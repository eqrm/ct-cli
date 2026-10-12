/**
 * HTTP with rate-limit awareness and bounded retry.
 *
 * ChurchTools rate-limits bursts (HTTP 429) and can return transient 5xx. This
 * wrapper retries with exponential backoff + jitter, honouring a `Retry-After`
 * header when present.
 *
 * Safety: only **idempotent** requests (GET/HEAD) are retried on 5xx or network
 * errors — a write that may have already been applied is never blindly repeated.
 * A 429 is always safe to retry: the server rejected the request before
 * processing it.
 *
 * Retrying alone does not keep a fan-out under the limit: a plan reads a few
 * hundred resources through several concurrent pools, every request that 429s
 * backs off on its own while its siblings keep firing, and three quick retries
 * can run out before the instance lets anyone through again (a prod drift
 * check lost `GET /groups/{id}` that way). So every request also goes through
 * one {@link RequestPacer} per host, which spaces request starts and holds ALL
 * requests to that host back when any of them is told to slow down.
 */

export interface RetryOptions {
  /** Max additional attempts after the first (total attempts = retries + 1). */
  retries?: number;
  baseDelayMs?: number;
  /** GET/HEAD are idempotent; writes are not. Controls 5xx/network retry. */
  isIdempotent?: boolean;
  /**
   * Max additional attempts after a 429 specifically. Defaults to `retries` when
   * that is set, else {@link DEFAULT_RATE_LIMIT_RETRIES}: waiting out a throttle
   * needs a longer budget than riding out a flaky 5xx.
   */
  rateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Pacer to go through; defaults to the shared one for the request's host. `null` skips pacing. */
  pacer?: RequestPacer | null;
}

/**
 * 429 retries when the caller sets no budget: backoff 0.5s → 16s, about 30s
 * waited in all. A `Retry-After` replaces the backoff (each wait capped at 60s).
 */
export const DEFAULT_RATE_LIMIT_RETRIES = 6;

/**
 * Request starts per second per host when {@link MAX_RPS_ENV} is unset.
 *
 * ChurchTools publishes no number for its API limit, so this is set well below
 * what the unpaced client reached (eight concurrent reads at a few hundred ms
 * each), which is what tripped 429. Override it with the env var; `0` turns the
 * spacing off and keeps only the shared 429 pause.
 */
export const DEFAULT_MAX_REQUESTS_PER_SECOND = 10;
export const MAX_RPS_ENV = "CT_MAX_REQUESTS_PER_SECOND";

/**
 * Spaces request starts to one host and shares a 429 pause across them.
 *
 * {@link reserve} is synchronous on purpose: concurrent callers each claim a
 * distinct start slot before any of them awaits, so N workers released at once
 * still start {@link minIntervalMs} apart instead of in a burst.
 */
export class RequestPacer {
  private nextStartAt = 0;
  private pausedUntil = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Claim the next start slot and return how long to wait for it, in ms. */
  reserve(): number {
    const now = this.now();
    const start = Math.max(now, this.nextStartAt, this.pausedUntil);
    this.nextStartAt = start + this.minIntervalMs;
    return start - now;
  }

  /** How much of the shared 429 pause is still left, in ms. */
  pauseRemaining(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  /** Hold every request to this host back for `ms` — a 429 is about the client, not one request. */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }
}

function minIntervalFromEnv(): number {
  const raw = process.env[MAX_RPS_ENV]?.trim();
  const rps = raw ? Number(raw) : DEFAULT_MAX_REQUESTS_PER_SECOND;
  if (!Number.isFinite(rps) || rps < 0) {
    return 1000 / DEFAULT_MAX_REQUESTS_PER_SECOND;
  }
  return rps === 0 ? 0 : 1000 / rps;
}

const pacers = new Map<string, RequestPacer>();

/** The process-wide pacer for `input`'s origin, created on first use. */
export function pacerFor(input: string | URL): RequestPacer | null {
  let origin: string;
  try {
    origin = new URL(input).origin;
  } catch {
    return null;
  }
  let pacer = pacers.get(origin);
  if (!pacer) {
    pacer = new RequestPacer(minIntervalFromEnv());
    pacers.set(origin, pacer);
  }
  return pacer;
}

/** Cap on any single wait, so an outsized `Retry-After` can't hang the CLI. */
const MAX_DELAY_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) {
    return 0;
  }
  return Math.min(Math.max(ms, 0), MAX_DELAY_MS);
}

function backoffMs(base: number, attempt: number): number {
  const exp = base * 2 ** (attempt - 1);
  return clampDelay(exp + Math.floor(Math.random() * base));
}

/**
 * The wait a response's `Retry-After` header asks for, in ms — `null` when the
 * header is absent or unusable, and deliberately NOT clamped: this is the
 * server's actual ask. Exported so a caller that has run out of retries can
 * still *tell the user* how long to wait (see the 429 login message in
 * `ctClient.authenticate`), where clamping to the sleep cap would understate it.
 */
export function parseRetryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after")?.trim();
  if (!header) {
    return null;
  }
  // `Retry-After` is either a non-negative delta-seconds count or an HTTP-date.
  if (/^\d+$/.test(header)) {
    return Number.parseInt(header, 10) * 1000;
  }
  // Only treat it as a date when it actually looks like one — `Date.parse` is
  // lax enough to accept e.g. "-5" as a year, which must not become a 0ms wait.
  if (/[a-zA-Z]/.test(header)) {
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      return dateMs - Date.now();
    }
  }
  // Unparseable (e.g. a negative or malformed value): fall back to backoff.
  return null;
}

/**
 * The `Retry-After` wait clamped to what this client is willing to sleep for —
 * an outsized (or already-elapsed) value can neither hang the CLI nor turn into
 * a busy retry.
 */
function retryAfterMs(res: Response): number | null {
  const ms = parseRetryAfterMs(res);
  return ms === null ? null : clampDelay(ms);
}

function shouldRetryStatus(status: number, isIdempotent: boolean): boolean {
  if (status === 429) {
    return true;
  }
  return status >= 500 && isIdempotent;
}

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const rateLimitRetries = opts.rateLimitRetries ?? opts.retries ?? DEFAULT_RATE_LIMIT_RETRIES;
  const base = opts.baseDelayMs ?? 500;
  const isIdempotent = opts.isIdempotent ?? true;
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? fetch;
  const pacer = opts.pacer === undefined ? pacerFor(input) : opts.pacer;

  // Two budgets: 429s are waited out on their own, longer one, so a throttle
  // cannot use up the retries a later 5xx or network error is owed.
  let failures = 0;
  let rateLimited = 0;
  for (;;) {
    let wait = pacer?.reserve() ?? 0;
    while (wait > 0) {
      await sleep(wait);
      // A sibling's 429 may have started a pause while this request slept toward its slot.
      wait = pacer && pacer.pauseRemaining() > 0 ? pacer.reserve() : 0;
    }
    let res: Response;
    try {
      res = await doFetch(input, init);
    } catch (err) {
      if (failures < retries && isIdempotent) {
        failures++;
        await sleep(backoffMs(base, failures));
        continue;
      }
      throw err;
    }
    if (res.status === 429) {
      if (rateLimited >= rateLimitRetries) {
        return res;
      }
      rateLimited++;
      const delay = retryAfterMs(res) ?? backoffMs(base, rateLimited);
      // Drain the response we're discarding so its socket isn't left buffered.
      await res.body?.cancel().catch(() => {});
      // The pacer's next reserve() waits this out — for this request and every sibling.
      if (pacer) {
        pacer.pauseFor(delay);
      } else {
        await sleep(delay);
      }
      continue;
    }
    if (failures < retries && shouldRetryStatus(res.status, isIdempotent)) {
      failures++;
      const delay = retryAfterMs(res) ?? backoffMs(base, failures);
      await res.body?.cancel().catch(() => {});
      await sleep(delay);
      continue;
    }
    return res;
  }
}
