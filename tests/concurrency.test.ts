import { describe, it, expect } from "vitest";
import { mapConcurrent } from "../src/util/concurrency.js";

describe("mapConcurrent", () => {
  it("preserves input order and maps every item", async () => {
    const result = await mapConcurrent([1, 2, 3, 4], 2, async (n) => n * 2);
    expect(result).toEqual([2, 4, 6, 8]);
  });

  it("never runs more than the concurrency limit at once", async () => {
    let active = 0;
    let peak = 0;
    await mapConcurrent(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually parallel, not serialised
  });

  it("handles an empty list", async () => {
    expect(await mapConcurrent([], 4, async (x) => x)).toEqual([]);
  });
});
