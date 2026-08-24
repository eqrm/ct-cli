import { describe, it, expect, vi } from "vitest";
import { fetchWithRetry, parseRetryAfterMs } from "../src/api/http.js";

const noSleep = () => Promise.resolve();

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : "{}", { status, headers });
}

describe("fetchWithRetry", () => {
  it("retries a 429 then succeeds", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));
    const out = await fetchWithRetry("https://x/api/campuses", {}, { sleep: noSleep, fetchImpl });
    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honours Retry-After for the wait duration", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, { "retry-after": "2" }))
      .mockResolvedValueOnce(res(200));
    const sleep = vi.fn(() => Promise.resolve());
    await fetchWithRetry("https://x/api/campuses", {}, { sleep, fetchImpl });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("caps an outsized Retry-After so the CLI can't hang for hours", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, { "retry-after": "86400" }))
      .mockResolvedValueOnce(res(200));
    const sleep = vi.fn(() => Promise.resolve());
    await fetchWithRetry("https://x/api/campuses", {}, { sleep, fetchImpl });
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("ignores a malformed Retry-After and falls back to backoff", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, { "retry-after": "-5" }))
      .mockResolvedValueOnce(res(200));
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    await fetchWithRetry("https://x/api/campuses", {}, { baseDelayMs: 500, sleep, fetchImpl });
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
      { sleep, fetchImpl, isIdempotent: false },
    );
    expect(out.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("retries idempotent GET on 500", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
    const out = await fetchWithRetry(
      "https://x/api/campuses",
      {},
      { sleep: noSleep, fetchImpl, isIdempotent: true },
    );
    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a write on 500", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(res(500));
    const out = await fetchWithRetry(
      "https://x/api/campuses",
      { method: "POST" },
      { sleep: noSleep, fetchImpl, isIdempotent: false },
    );
    expect(out.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget and returns the last response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(res(429));
    const out = await fetchWithRetry("https://x/api/campuses", {}, { retries: 2, sleep: noSleep, fetchImpl });
    expect(out.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a write on a network error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      fetchWithRetry(
        "https://x/api/campuses",
        { method: "POST" },
        { sleep: noSleep, fetchImpl, isIdempotent: false },
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
