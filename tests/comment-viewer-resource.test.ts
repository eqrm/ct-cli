/**
 * Comment viewers as a managed resource (#151) — the last scope dimension a config could not express
 * portably.
 *
 * `cdb_comment_viewer` had a reference form (`{ commentViewer: "…" }`, #102) but no declaration
 * behind it, so a config granting `churchdb:view comments` had to write a raw numeric `dataId`. That
 * id is host-specific: read on two hosts of the same deployment on 2026-08-24, three of prod's six
 * viewer ids did not exist on dev at all, and the two present on both named different categories on
 * each. Nothing detected it — `ct plan` compares the declared id against the live id and they match;
 * the id is simply meaningless on the target host. The name ref was no escape either, because the
 * NAMES were missing on the second host too, so the ref hard-errored rather than resolving wrongly.
 *
 * Declaring the viewer is what makes the name exist on both hosts, which is what makes the ref
 * portable. `/person/commentviewers` is conventional REST, so this type needs none of the machinery
 * the other two awkward master-data types did: CT mints the id (unlike `security-level`) and the
 * writes are REST (unlike `department`). Fully live-probed on eqrm-dev, CT 3.135.2 (2026-08-26):
 * collection GET/POST, item GET/PUT/DELETE, absent item id → clean 404.
 *
 * The one dataId that is NOT host-specific is `0`, the built-in "Alle" viewer CT ships everywhere —
 * so it is emitted as a number and never offered for adoption (see the "Alle" test below).
 */
import { describe, it, expect, vi } from "vitest";
import { evaluateConfig } from "../src/config/context.js";
import { executePlan } from "../src/engine/execute.js";
import { computePlan } from "../src/engine/plan.js";
import { tierOf, isKnownType } from "../src/engine/graph.js";
import { applyPermissionPlan } from "../src/permissions/apply.js";
import { buildPermissionPlan } from "../src/permissions/plan.js";
import { RESOURCES, configSnippet, knownFields } from "../src/resources/registry.js";
import { emptyState, type State } from "../src/state/state.js";
import type { DesiredPermission } from "../src/permissions/types.js";
import type { DesiredResource, Plan } from "../src/engine/types.js";
import type { CtClient } from "../src/api/ctClient.js";

const HOST = "https://mychurch.church.tools";
const PATH = "/person/commentviewers";
const SPEC = RESOURCES["comment-viewer"]!;

/** `churchdb:view comments` — authId 113, the one right scoped by `cdb_comment_viewer`. */
const VIEW_COMMENTS = "churchdb:view comments";

const noSave: (path: string, state: State) => Promise<void> = async () => {};

function recorder(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      return (responses[`${method} ${path}`] ?? {}) as T;
    },
  };
  return { client, calls };
}

/** State holding one viewer under key `dienstbereich`, as a prior apply would have left it. */
function stateWithViewer(id: number): State {
  return {
    version: 1,
    host: HOST,
    resources: {
      dienstbereich: {
        type: "comment-viewer",
        id,
        key: "dienstbereich",
        fields: { name: "Dienstbereich", sortKey: 40 },
        adoptedAt: "t",
        updatedAt: "t",
      },
    },
  };
}

/** A grant scoped by a comment viewer, declared with the portable ref form. */
const viewerScoped: DesiredPermission = {
  key: "pastoral_care_grants",
  domainType: "group_role",
  domainId: 900,
  grants: [{ right: VIEW_COMMENTS, scope: [{ commentViewer: "dienstbereich" }] }],
};

describe("declaring, creating and updating a comment viewer (#151)", () => {
  it("is a plain collection POST — CT mints the id, unlike a security level", async () => {
    const state = emptyState(HOST);
    const { client, calls } = recorder({ [`POST ${PATH}`]: { id: 7 } });
    const plan: Plan = {
      items: [
        {
          type: "comment-viewer",
          key: "dienstbereich",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Dienstbereich" },
            { field: "sortKey", from: undefined, to: 40 },
          ],
        },
      ],
    };

    const res = await executePlan(plan, { client, state, statePath: "unused", save: noSave });
    expect(res.failed).toBeUndefined();
    expect(calls).toEqual([{ method: "POST", path: PATH, body: { name: "Dienstbereich", sortKey: 40 } }]);
    expect(state.resources.dienstbereich).toMatchObject({ type: "comment-viewer", id: 7 });
    // Pinned against a future refactor that makes the caller-assigned-id path unconditional: this
    // type must NOT post to `/person/commentviewers/{id}` the way a security level does.
    expect(SPEC.createPath).toBeUndefined();
    expect(SPEC.callerAssignedId).toBeUndefined();
  });

  it("supplies a neutral sortKey at create when the declaration omits it", () => {
    // `sortkey` is a non-nullable integer column on these 3-column master-data tables, so a
    // hand-authored declaration carrying only `name` still needs a valid create body. A DECLARED
    // value wins (createDefaults merges UNDER the body) — that ordering is the executor's, so all
    // this pins is that the default exists and is the neutral one.
    expect(SPEC.createDefaults?.({ name: "Dienstbereich" })).toEqual({ sortKey: 0 });
  });

  it("updates with a PUT carrying the whole managed set", async () => {
    const state = stateWithViewer(4);
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "comment-viewer",
          key: "dienstbereich",
          id: 4,
          action: "update",
          actual: { name: "Dienstbereich", sortKey: 40 },
          changes: [{ field: "name", from: "Dienstbereich", to: "Dienstbereiche" }],
        },
      ],
    };

    const res = await executePlan(plan, { client, state, statePath: "unused", save: noSave });
    expect(res.failed).toBeUndefined();
    // PUT is a full replace, so the unchanged sibling has to travel with it — `name` and `sortKey`
    // are the whole editable surface, so nothing outside the managed set can be blanked.
    expect(calls).toEqual([
      { method: "PUT", path: `${PATH}/4`, body: { name: "Dienstbereiche", sortKey: 40 } },
    ]);
  });

  it("applies in the master-data tier, before permissions", () => {
    expect(isKnownType("comment-viewer")).toBe(true);
    expect(tierOf("comment-viewer")).toBe(0);
  });

  it("names what a delete reaches, the way person-status and security-level do", () => {
    expect(SPEC.destroyWarning).toMatch(/churchdb:view comments/);
    expect(SPEC.destroyWarning).toMatch(/ct get comment-viewers/);
  });
});

describe("adopt → config → plan round-trips to a no-op (#151)", () => {
  it("uses the DEFAULT item read — `GET {itemPath}` exists here (probed 2026-08-26)", () => {
    // This type briefly carried a collection-filtering `fetchOne` because a GET on the item path was
    // unprobed, and guessing it has a genuinely bad failure mode (#108): a 404 reads as "vanished in
    // ChurchTools", so every plan proposes creating the viewer again. The live probe retired the
    // guess — `GET /person/commentviewers/{id}` returns the row, and an ABSENT id returns a clean
    // 404 `error.notfound`, which is exactly the distinction the default read needs. Keeping the hook
    // would cost one full collection read per managed viewer per plan/apply/destroy (`fetchActual`
    // fans out concurrently) against a rate-limited API. `department` is the only type that still
    // needs the hook, because `/departments/{id}` genuinely does not exist.
    expect(SPEC.fetchOne).toBeUndefined();
  });

  it("emits a declaration that diffs clean against the row it was adopted from", async () => {
    const live = { id: 4, name: "Dienstbereich", sortKey: 40 };
    const fields = SPEC.managedFields(live);
    expect(fields).toEqual({ name: "Dienstbereich", sortKey: 40 });

    const snippet = configSnippet("comment-viewer", "dienstbereich", fields);
    expect(snippet).toContain("commentViewer(");
    expect(snippet).toContain('name: "Dienstbereich"');

    const { resources } = await evaluateConfig((ct) => {
      ct.commentViewer({ key: "dienstbereich", name: "Dienstbereich", sortKey: 40 });
    });
    expect(resources[0]).toMatchObject({ type: "comment-viewer", key: "dienstbereich" });
    const plan = computePlan(resources, stateWithViewer(4), new Map([["dienstbereich", live]]));
    expect(plan.items.map((i) => i.action)).toEqual(["no-op"]);
  });

  it("accepts `name` and `sortKey` as known fields — no unknown-field warning", () => {
    expect(knownFields("comment-viewer")).toEqual(new Set(["name", "sortKey"]));
  });
});

describe("the same config means the same thing on two hosts (#151)", () => {
  /** A client whose permission reads are empty and whose viewer catalog is host-specific. */
  function mockClient(viewers: { id: number; name: string }[] = [], newId = 555) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const get = vi.fn(async (path: string) => {
      if (path === PATH) return viewers;
      const match = /^\/person\/commentviewers\/(\d+)$/.exec(path);
      if (match) return viewers.find((viewer) => viewer.id === Number(match[1]));
      return [];
    });
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === PATH) return { id: newId };
      return {};
    });
    return { client: { get, request } as unknown as CtClient, calls };
  }

  it("resolves the ref from MANAGED state, so the dataId differs per host and the config does not", async () => {
    // The exact failure #151 exists to close: the declared viewer is id 4 on one host and id 2 on the
    // other. Written as a raw `scope: [4]` the second host gets a grant pointing at a different
    // viewer — or at nothing — and no plan, row count or diff can see it.
    for (const id of [4, 2]) {
      const { client } = mockClient();
      const { items, fetchErrors } = await buildPermissionPlan(client, stateWithViewer(id), [viewerScoped]);
      expect(fetchErrors).toEqual([]);
      expect(items[0]?.diff.toPut).toEqual([
        { authId: 113, dataId: [id], type: "grant", scopeKey: "dienstbereich", scopeType: "comment-viewer" },
      ]);
    }
  });

  it("a viewer declared in the SAME run is pending at plan time and gets its real id at apply time", async () => {
    // The fresh-host case: nothing exists yet, so the viewer and the grant that scopes to it have to
    // land in one run. Before #151 this could not be expressed at all — the viewer had to be created
    // by hand on every target instance first.
    const desired: DesiredResource[] = [
      {
        type: "comment-viewer",
        key: "dienstbereich",
        fields: { name: "Dienstbereich", sortKey: 40 },
        dependsOn: [],
      },
    ];
    const { client, calls } = mockClient([], 555);
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [viewerScoped], desired);
    expect(items[0]?.diff.toPut).toEqual([
      {
        authId: 113,
        dataId: [],
        type: "grant",
        scopeKey: "dienstbereich",
        scopeType: "comment-viewer",
        pending: true,
      },
    ]);

    const createViewer: Plan = {
      items: [
        {
          type: "comment-viewer",
          key: "dienstbereich",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Dienstbereich" },
            { field: "sortKey", from: undefined, to: 40 },
          ],
        },
      ],
    };
    await executePlan(createViewer, { client, state, statePath: "unused", save: noSave });
    expect(state.resources.dienstbereich?.id).toBe(555);

    const res = await applyPermissionPlan(items, client, state);
    expect(res.granted).toBe(1);
    const put = calls.find((c) => c.method === "PUT" && c.path === "/permissions/group_role/900");
    expect(put?.body).toEqual({ authId: 113, type: "grant", dataId: [555] });
  });

  it("resolves an explicitly bound external viewer without managing it", async () => {
    const { client } = mockClient([{ id: 2, name: "Dienstbereich" }]);
    const state = emptyState(HOST);
    state.externals!.dienstbereich = {
      type: "comment-viewer",
      id: 2,
      key: "dienstbereich",
      identity: { name: "Dienstbereich" },
      boundAt: "t",
    };
    const { items, fetchErrors } = await buildPermissionPlan(client, state, [viewerScoped]);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.diff.toPut).toEqual([{ authId: 113, dataId: [2], type: "grant" }]);
  });
});
