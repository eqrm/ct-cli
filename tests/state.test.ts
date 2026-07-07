import { describe, it, expect } from "vitest";
import { emptyState, upsert, findByTypeId, isManaged } from "../src/state/state.js";

const HOST = "https://eqrm.church.tools";
const NOW = "2026-07-07T00:00:00.000Z";
const LATER = "2026-07-08T00:00:00.000Z";

describe("state.upsert", () => {
  it("creates a new managed resource", () => {
    const state = emptyState(HOST);
    const action = upsert(state, { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz" } }, NOW);
    expect(action).toBe("created");
    expect(state.resources.mainz).toMatchObject({ type: "campus", id: 0, key: "mainz", adoptedAt: NOW });
  });

  it("is idempotent for the same (type, id) — updates in place, no duplicate", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz" } }, NOW);
    const action = upsert(
      state,
      { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz HQ" } },
      LATER,
    );
    expect(action).toBe("updated");
    expect(Object.keys(state.resources)).toHaveLength(1);
    expect(state.resources.mainz?.fields).toEqual({ name: "Mainz HQ" });
    expect(state.resources.mainz?.adoptedAt).toBe(NOW);
    expect(state.resources.mainz?.updatedAt).toBe(LATER);
  });

  it("handles id 0 without treating it as missing", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: {} }, NOW);
    expect(isManaged(state, "campus", 0)).toBe(true);
    expect(findByTypeId(state, "campus", 0)?.id).toBe(0);
  });

  it("re-keys when the same resource is adopted under a new key", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: {} }, NOW);
    upsert(state, { type: "campus", id: 0, key: "mz", fields: {} }, LATER);
    expect(Object.keys(state.resources)).toEqual(["mz"]);
    expect(findByTypeId(state, "campus", 0)?.key).toBe("mz");
  });

  it("rejects a key already taken by a different resource", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "shared", fields: {} }, NOW);
    expect(() => upsert(state, { type: "group", id: 5, key: "shared", fields: {} }, NOW)).toThrow(
      /already used/,
    );
  });
});
