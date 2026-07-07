import { describe, it, expect } from "vitest";
import { renderPlan } from "../src/engine/render.js";

describe("renderPlan", () => {
  it("reports no changes for an empty or all-no-op plan", () => {
    expect(renderPlan({ items: [] })).toMatch(/No changes/);
    expect(
      renderPlan({ items: [{ type: "campus", key: "mz", id: 0, action: "no-op", changes: [] }] }),
    ).toMatch(/No changes/);
  });

  it("renders create/update lines and a summary", () => {
    const out = renderPlan({
      items: [
        {
          type: "campus",
          key: "mainz",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Mainz" }],
        },
        {
          type: "group",
          key: "kids",
          id: 7,
          action: "update",
          changes: [{ field: "name", from: "K", to: "Kids" }],
        },
      ],
    });
    expect(out).toMatch(/campus\.mainz/);
    expect(out).toMatch(/group\.kids/);
    expect(out).toMatch(/1 to create, 1 to update/);
  });

  it("surfaces drift", () => {
    const out = renderPlan({
      items: [
        {
          type: "campus",
          key: "mainz",
          id: 0,
          action: "no-op",
          changes: [],
          drift: [{ field: "shortName", from: "MZ", to: "CHANGED" }],
        },
      ],
    });
    expect(out).toMatch(/Drift detected/);
    expect(out).toMatch(/shortName/);
  });
});
