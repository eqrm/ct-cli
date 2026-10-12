import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_RATE_LIMIT_RETRIES,
  MAX_RPS_ENV,
  RequestPacer,
  fetchWithRetry,
  pacerFor,
  parseRetryAfterMs,
} from "../src/api/http.js";

const noSleep = () => Promise.resolve();

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : "{}", { status, headers });
}

describe("fetchWithRetry", () => {
  it("retries a 429 then succeeds", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));
    const out = await fetchWithRetry(
      "https://x/api/campuses",
      {},
      { sleep: noSleep, fetchImpl, pacer: null },
    );
    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honours Retry-After for the wait duration", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, { "retry-after": "2" }))
      .mockResolvedValueOnce(res(200));
    const sleep = vi.fn(() => Promise.resolve());
    await fetchWithRetry("https://x/api/campuses", {}, { sleep, fetchImpl, pacer: null });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("caps an outsized Retry-After so the CLI can't hang for hours", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, { "retry-after": "86400" }))
      .mockResolvedValueOnce(res(200));
    const sleep = vi.fn(() => Promise.resolve());
    await fetchWithRetry("https://x/api/campuses", {}, { sleep, fetchImpl, pacer: null });
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("ignores a malformed Retry-After and falls back to backoff", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, { "retry-after": "-5" }))
      .mockResolvedValueOnce(res(200));
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    await fetchWithRetry("https://x/api/campuses", {}, { baseDelayMs: 500, sleep, fetchImpl, pacer: null });
    // Backoff, not an immediate (negative → 0) retry.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0] ?? 0).toBeGreaterThanOrEqual(500);
  });

  it("waits out a 429 on a write too — the server rejected it before processing", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, { "retry-after": "3" }))
      .mockResolvedValueOnce(res(200));
    const sleep = vi.fn(() => Promise.resolve());
    const out = await fetchWithRetry(
      "https://x/api/campuses",
      { method: "POST" },
      { sleep, fetchImpl, pacer: null, isIdempotent: false },
    );
    expect(out.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("retries idempotent GET on 500", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
    const out = await fetchWithRetry(
      "https://x/api/campuses",
      {},
      { sleep: noSleep, fetchImpl, pacer: null, isIdempotent: true },
    );
    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a write on 500", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(res(500));
    const out = await fetchWithRetry(
      "https://x/api/campuses",
      { method: "POST" },
      { sleep: noSleep, fetchImpl, pacer: null, isIdempotent: false },
    );
    expect(out.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget and returns the last response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(res(429));
    const out = await fetchWithRetry(
      "https://x/api/campuses",
      {},
      { retries: 2, sleep: noSleep, fetchImpl, pacer: null },
    );
    expect(out.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a write on a network error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      fetchWithRetry(
        "https://x/api/campuses",
        { method: "POST" },
        { sleep: noSleep, fetchImpl, pacer: null, isIdempotent: false },
      ),
    ).rejects.toThrow("ECONNRESET");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("parseRetryAfterMs", () => {
  it("reports the server's full ask, unclamped, so a message can quote it", () => {
    // fetchWithRetry clamps its own sleep to 60s; the *message* must not claim
    // "wait about a minute" when the server asked for an hour.
    expect(parseRetryAfterMs(res(429, { "retry-after": "3600" }))).toBe(3_600_000);
  });

  it("returns null when the header is missing or malformed", () => {
    expect(parseRetryAfterMs(res(429))).toBeNull();
    expect(parseRetryAfterMs(res(429, { "retry-after": "-5" }))).toBeNull();
  });
});

describe("fetchWithRetry under a rate limit", () => {
  it("waits out more 429s than 5xx retries by default", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(res(429));
    const out = await fetchWithRetry(
      "https://x/api/groups/1",
      {},
      { sleep: noSleep, fetchImpl, pacer: null },
    );
    expect(out.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_RATE_LIMIT_RETRIES + 1);
  });

  it("does not let 429s use up the retries a later 5xx is owed", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(200));
    const out = await fetchWithRetry(
      "https://x/api/groups/1",
      {},
      { sleep: noSleep, fetchImpl, pacer: null },
    );
    expect(out.status).toBe(200);
  });

  it("holds a sibling request back when another one is told to slow down", async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const pacer = new RequestPacer(0, () => clock);
    const throttled = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, { "retry-after": "2" }))
      .mockResolvedValueOnce(res(200));
    await fetchWithRetry("https://x/api/groups/1", {}, { sleep, fetchImpl: throttled, pacer });
    expect(sleep).toHaveBeenCalledWith(2000);

    // The pause is shared: a request started while it runs waits for the rest of it.
    clock = 500;
    pacer.pauseFor(2000);
    sleep.mockClear();
    const sibling = vi.fn<typeof fetch>().mockResolvedValue(res(200));
    await fetchWithRetry("https://x/api/groups/2", {}, { sleep, fetchImpl: sibling, pacer });
    expect(sleep).toHaveBeenCalledWith(2000);
  });
});

describe("RequestPacer", () => {
  it("gives concurrent callers distinct, spaced start slots", () => {
    const pacer = new RequestPacer(100, () => 1_000);
    expect([pacer.reserve(), pacer.reserve(), pacer.reserve()]).toEqual([0, 100, 200]);
  });

  it("starts the spacing after a pause, not during it", () => {
    let clock = 0;
    const pacer = new RequestPacer(100, () => clock);
    pacer.pauseFor(1_000);
    expect(pacer.reserve()).toBe(1_000);
    expect(pacer.reserve()).toBe(1_100);
    clock = 5_000;
    expect(pacer.reserve()).toBe(0);
  });

  it("never shortens a pause that is already longer", () => {
    const pacer = new RequestPacer(0, () => 0);
    pacer.pauseFor(5_000);
    pacer.pauseFor(1_000);
    expect(pacer.reserve()).toBe(5_000);
  });
});

describe("pacerFor", () => {
  it("shares one pacer per origin", () => {
    expect(pacerFor("https://a.example/api/groups/1")).toBe(pacerFor("https://a.example/api/persons"));
    expect(pacerFor("https://a.example/api/x")).not.toBe(pacerFor("https://b.example/api/x"));
  });

  it(`turns the spacing off with ${MAX_RPS_ENV}=0 but keeps the shared pause`, () => {
    vi.stubEnv(MAX_RPS_ENV, "0");
    try {
      const pacer = pacerFor("https://unpaced.example/api/x");
      expect(pacer?.reserve()).toBe(0);
      expect(pacer?.reserve()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("spaces requests at the configured rate", () => {
    vi.stubEnv(MAX_RPS_ENV, "4");
    try {
      const pacer = pacerFor("https://paced.example/api/x");
      pacer?.reserve();
      const second = pacer?.reserve() ?? 0;
      // 4/s = 250ms apart; a little slack for the clock moving between the two calls.
      expect(second).toBeGreaterThan(240);
      expect(second).toBeLessThanOrEqual(250);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
