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
 */

export interface RetryOptions {
  /** Max additional attempts after the first (total attempts = retries + 1). */
  retries?: number;
  baseDelayMs?: number;
  /** GET/HEAD are idempotent; writes are not. Controls 5xx/network retry. */
  isIdempotent?: boolean;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
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

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after")?.trim();
  if (!header) {
    return null;
  }
  // `Retry-After` is either a non-negative delta-seconds count or an HTTP-date.
  if (/^\d+$/.test(header)) {
    return clampDelay(Number.parseInt(header, 10) * 1000);
  }
  // Only treat it as a date when it actually looks like one — `Date.parse` is
  // lax enough to accept e.g. "-5" as a year, which must not become a 0ms wait.
  if (/[a-zA-Z]/.test(header)) {
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      return clampDelay(dateMs - Date.now());
    }
  }
  // Unparseable (e.g. a negative or malformed value): fall back to backoff.
  return null;
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
  const base = opts.baseDelayMs ?? 500;
  const isIdempotent = opts.isIdempotent ?? true;
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? fetch;

  let attempt = 0;
  for (;;) {
    attempt++;
    let res: Response;
    try {
      res = await doFetch(input, init);
    } catch (err) {
      if (attempt <= retries && isIdempotent) {
        await sleep(backoffMs(base, attempt));
        continue;
      }
      throw err;
    }
    if (attempt <= retries && shouldRetryStatus(res.status, isIdempotent)) {
      const delay = retryAfterMs(res) ?? backoffMs(base, attempt);
      // Drain the response we're discarding so its socket isn't left buffered.
      await res.body?.cancel().catch(() => {});
      await sleep(delay);
      continue;
    }
    return res;
  }
}
