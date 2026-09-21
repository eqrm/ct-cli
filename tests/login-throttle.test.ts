/**
 * The login-handshake brake (#179).
 *
 * `ct` is one-shot, so nothing inside an invocation knows how many handshakes the last minute
 * already spent — and `ct auth token` is designed to be called by another tool on every run, with no
 * session cache at all off macOS. ChurchTools rate-limits logins per instance, so the count has to
 * outlive the process: it lives in a cache file holding nothing but timestamps.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileLoginThrottle,
  MAX_PER_HOUR,
  MIN_INTERVAL_MS,
  throttleDir,
  throttlePath,
} from "../src/auth/loginThrottle.js";

const HOST = "https://mychurch.church.tools";
let dir: string | undefined;

function cacheDir(): NodeJS.ProcessEnv {
  dir = mkdtempSync(join(tmpdir(), "ct-throttle-"));
  const env = { XDG_CACHE_HOME: dir };
  mkdirSync(throttleDir(env), { recursive: true }); // so a test can seed the file the throttle reads
  return env;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("fileLoginThrottle", () => {
  it("keeps one file per host, holding no credential", async () => {
    const env = cacheDir();
    await fileLoginThrottle({ env, now: () => 1000 }).acquire(HOST);
    const path = throttlePath(HOST, env);
    expect(path).toContain("login-throttle.mychurch.church.tools.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ host: HOST, recent: [1000] });
  });

  it("waits out the minimum spacing rather than letting the instance answer 429", async () => {
    const env = cacheDir();
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => void slept.push(ms);
    const throttle = fileLoginThrottle({ env, sleep, now: () => 1000 });
    await throttle.acquire(HOST);
    expect(slept).toEqual([]);
    // A second handshake 500ms later waits the remaining 2.5s — a short sleep, not a failure: the
    // caller gets its session either way.
    await fileLoginThrottle({ env, sleep, now: () => 1500 }).acquire(HOST);
    expect(slept).toEqual([MIN_INTERVAL_MS - 500]);
  });

  it("refuses once a rolling hour is full, naming when the window frees up", async () => {
    const env = cacheDir();
    const start = Date.parse("2026-09-21T10:00:00.000Z");
    writeFileSync(
      throttlePath(HOST, env),
      JSON.stringify({ host: HOST, recent: Array.from({ length: MAX_PER_HOUR }, (_, i) => start + i) }),
      "utf8",
    );
    await expect(fileLoginThrottle({ env, now: () => start + 60_000 }).acquire(HOST)).rejects.toThrow(
      /2026-09-21T11:00:00.000Z/,
    );
  });

  it("forgets handshakes older than the window", async () => {
    const env = cacheDir();
    const start = Date.parse("2026-09-21T10:00:00.000Z");
    writeFileSync(
      throttlePath(HOST, env),
      JSON.stringify({ host: HOST, recent: Array.from({ length: MAX_PER_HOUR }, (_, i) => start + i) }),
      "utf8",
    );
    const later = start + 2 * 60 * 60 * 1000;
    await fileLoginThrottle({ env, now: () => later }).acquire(HOST);
    expect(JSON.parse(readFileSync(throttlePath(HOST, env), "utf8")).recent).toEqual([later]);
  });

  it("drops a timestamp from the future instead of holding the brake on", async () => {
    // A clock change or a copied cache file would otherwise throttle every login until the skew ran
    // out — an unreadable cache must degrade to "no throttle", never to "no logins".
    const env = cacheDir();
    const now = Date.parse("2026-09-21T10:00:00.000Z");
    writeFileSync(
      throttlePath(HOST, env),
      JSON.stringify({ host: HOST, recent: [now + 10 * 60 * 1000] }),
      "utf8",
    );
    const slept: number[] = [];
    await fileLoginThrottle({ env, sleep: async (ms) => void slept.push(ms), now: () => now }).acquire(HOST);
    expect(slept).toEqual([]);
  });

  it("does nothing under CT_NO_LOGIN_THROTTLE=1", async () => {
    const env = { ...cacheDir(), CT_NO_LOGIN_THROTTLE: "1" };
    const start = Date.parse("2026-09-21T10:00:00.000Z");
    writeFileSync(
      throttlePath(HOST, env),
      JSON.stringify({ host: HOST, recent: Array.from({ length: MAX_PER_HOUR }, (_, i) => start + i) }),
      "utf8",
    );
    await expect(fileLoginThrottle({ env, now: () => start + 1 }).acquire(HOST)).resolves.toBeUndefined();
  });

  it("never fails a login because the cache is unwritable", async () => {
    // No such directory, and none can be created under a file — the throttle is a courtesy, and a
    // courtesy that breaks the tool is a bug.
    const file = join(mkdtempSync(join(tmpdir(), "ct-throttle-")), "not-a-dir");
    writeFileSync(file, "x", "utf8");
    dir = file;
    await expect(
      fileLoginThrottle({ env: { XDG_CACHE_HOME: file }, now: () => 1 }).acquire(HOST),
    ).resolves.toBeUndefined();
  });
});
