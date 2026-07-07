import { describe, it, expect, vi } from "vitest";
import { fetchWithRetry } from "../src/api/http.js";

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
