/**
 * A cross-process brake on the ChurchTools LOGIN handshake (#179).
 *
 * ChurchTools rate-limits logins per instance, and `ct` is one-shot: nothing inside a single
 * invocation can see how many handshakes the last minute already spent. The session cache (#145)
 * removes most of them, but it cannot remove the ones that matter here — `ct auth token` is designed
 * to be called by another tool on every run, and on Linux/CI there is no session cache at all, so
 * every invocation starts cold. Two parallel `tofu` runs, or a loop in a script, and the instance
 * answers 429 for everybody, including the humans.
 *
 * So the count lives in a file: one per host, holding nothing but timestamps.
 *
 *   - A handshake closer than {@link MIN_INTERVAL_MS} to the previous one WAITS for the remainder.
 *     A short sleep is strictly better than a 429 — the caller gets a session either way.
 *   - More than {@link MAX_PER_HOUR} in a rolling hour THROWS, naming when the window frees up. That
 *     is a runaway loop, not a burst, and continuing to hammer a throttled instance only lengthens
 *     the outage for everyone on it.
 *
 * ## What it does not do
 *
 * The counter is read, modified and written without a lock, so it bounds a SEQUENCE of invocations,
 * not a simultaneous burst: two processes that read the same file at the same moment compute the
 * same wait, sleep it together, and the second write drops the first one's timestamp. Truly parallel
 * handshakes are therefore spaced no better than not at all, and the hourly count under-reports them.
 * Holding a lock across a network handshake is its own hazard (a crashed `ct` would wedge every later
 * one), and the 429 this exists to avoid is driven by sustained rate, not by two coincident logins —
 * so the honest bound is the useful one, and it is stated here rather than implied away.
 *
 * Deliberately NOT in the Keychain: there is no secret here (see the blob shape below), and a
 * Keychain read is an ACL prompt away from being the very thing that makes the CLI unusable in a
 * script. A cache file that a user deletes, or that never appears at all, simply means no throttle —
 * every read and write is best-effort, and only the rolling cap ever fails a command.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostSlug } from "../permissions/catalog-store.js";

/**
 * Minimum spacing between two handshakes against one host. Waited out, never an error.
 *
 * This is the real brake, and the only one that scales with how fast a caller goes: 3s means at most
 * 20 handshakes a minute no matter how hard anything loops. That is the conservative end of what an
 * instance takes — a login handshake is heavier than a plain read, so sitting at the bottom of the
 * band is the right default rather than the top of it.
 *
 * It is also close to free for CI, which is the case that pays it: a `ct plan` takes longer than 3s
 * on its own, so the wait is usually already elapsed by the time the next invocation asks.
 */
export const MIN_INTERVAL_MS = 3_000;
/**
 * Handshakes per rolling hour per host before `ct` refuses to add to the pile.
 *
 * Deliberately far above anything legitimate, because this is NOT the rate limiter — the spacing
 * above is. {@link MIN_INTERVAL_MS} already caps sustained traffic at 20 handshakes a minute, which
 * sits at the conservative end of what a ChurchTools instance tolerates (operator estimate: 20-30
 * requests a minute, possibly 40). Anything the spacing permits is by definition a rate the instance
 * is fine with, so an hourly cap that binds FIRST is not protecting the instance — it is just
 * failing commands that were never the problem.
 *
 * It bound first for a long time. The gate sits in `CtClient.performLogin`, so it covers EVERY ct
 * command, and on Linux and Windows there is no session cache at all (`sessionStore` is
 * Keychain-only by design) — so on CI each invocation costs one handshake. The original 20/hour
 * failed a pipeline's 21st `ct plan`; even 120/hour is an average of 2 a minute, a tenth of what the
 * spacing already allows.
 *
 * So this is only the backstop for a process that has been hammering for an actual hour. 1000 is
 * just under the ~1200 the spacing physically permits, so it never binds on a pipeline of any
 * plausible size, while a genuine runaway still stops rather than running all day.
 */
export const MAX_PER_HOUR = 1000;
const HOUR_MS = 60 * 60 * 1000;

/** What a throttle needs from its caller. Injected so a client in a test never touches the disk. */
export interface LoginThrottle {
  acquire(host: string): Promise<void>;
}

/** Nothing here is a credential: a host label and the times ct last logged in to it. */
interface ThrottleRecord {
  host: string;
  recent: number[];
}

export function throttleDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(base, "ct-cli");
}

export function throttlePath(host: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(throttleDir(env), `login-throttle.${hostSlug(host)}.json`);
}

function parseRecord(raw: string, host: string, now: number): ThrottleRecord {
  try {
    const parsed = JSON.parse(raw) as Partial<ThrottleRecord>;
    if (parsed.host !== host || !Array.isArray(parsed.recent)) return { host, recent: [] };
    // A timestamp in the FUTURE (a clock change, a copied file) is dropped rather than trusted:
    // keeping it would hold the brake on for as long as the skew lasts.
    return { host, recent: parsed.recent.filter((t) => typeof t === "number" && t <= now) };
  } catch {
    return { host, recent: [] };
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface FileThrottleOptions {
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * The real, file-backed throttle. `CT_NO_LOGIN_THROTTLE=1` disables it — for a CI job that knows it
 * runs alone and would rather fail fast than sleep.
 */
export function fileLoginThrottle(options: FileThrottleOptions = {}): LoginThrottle {
  const env = options.env ?? process.env;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  return {
    async acquire(host: string): Promise<void> {
      if (env.CT_NO_LOGIN_THROTTLE === "1") return;
      const path = throttlePath(host, env);
      let record: ThrottleRecord = { host, recent: [] };
      try {
        record = parseRecord(await readFile(path, "utf8"), host, now());
      } catch {
        // No file, an unreadable one, a read-only home — none of those is a reason to refuse a login.
      }
      const recent = record.recent.filter((t) => now() - t < HOUR_MS).sort((a, b) => a - b);
      if (recent.length >= MAX_PER_HOUR) {
        const freesAt = new Date(recent[0]! + HOUR_MS);
        throw new Error(
          `Refusing to log in to ${host} again: ${recent.length} login handshakes in the last hour ` +
            `(ct's own limit, to stay under ChurchTools' rate limit). The oldest ages out at ` +
            `${freesAt.toISOString()}. If a script is looping, fix that first; set ` +
            `CT_NO_LOGIN_THROTTLE=1 to override.`,
        );
      }
      const last = recent[recent.length - 1];
      if (last !== undefined) {
        const wait = MIN_INTERVAL_MS - (now() - last);
        if (wait > 0) await sleep(wait);
      }
      const next: ThrottleRecord = { host, recent: [...recent, now()] };
      try {
        await mkdir(throttleDir(env), { recursive: true });
        await writeFile(path, `${JSON.stringify(next)}\n`, "utf8");
      } catch {
        // Best-effort: an unwritable cache means no throttle, never a failed command.
      }
    },
  };
}
