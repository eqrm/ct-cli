import { describe, it, expect } from "vitest";
import { emitAdoptedGrants } from "../src/permissions/adopt.js";
import {
  diffGrants,
  normalizeActual,
  normalizeEffective,
  type DomainType,
  type RawPermission,
} from "../src/permissions/grants.js";
import { desiredTuples } from "../src/permissions/plan.js";
import { resolveScopeRefs } from "../src/permissions/scope.js";
import { Resolver } from "../src/resolve/resolver.js";
import type { Grant, ScopeEntry } from "../src/permissions/types.js";
import type { State } from "../src/state/state.js";

const HOST = "https://mychurch.church.tools";

/** A state file with one managed group "kids" at id 99. */
function stateWithKids(): State {
  return {
    version: 1,
    host: HOST,
    resources: {
      kids: { type: "group", id: 99, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" },
    },
  };
}

function emptyState(): State {
  return { version: 1, host: HOST, resources: {} };
}

/** A client whose master-data catalogs are empty — every emitted ref must resolve from state. */
function catalogClient() {
  return { get: async <T>(): Promise<T> => [] as T };
}

/**
 * Parse the ACTIVE (non-comment) grant entries back out of an emitted block, so they can be fed
 * through the real `desiredTuples` — the round-trip property the emitter guarantees.
 */
function parseEmittedGrants(block: string): Grant[] {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l.trim() === "grants: [");
  if (start === -1) return []; // "grants: []," — nothing emitted
  const grants: Grant[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (line === "],") break;
    if (line.startsWith("//")) continue;
    const entry = line.replace(/,$/, "");
    if (entry.startsWith('"')) {
      grants.push(JSON.parse(entry) as string);
      continue;
    }
    const m = /^\{ right: ("(?:[^"\\]|\\.)*"), scope: \[(.*)\] \}$/.exec(entry);
    if (!m?.[1] || m[2] == null) throw new Error(`Unparseable emitted grant line: ${line}`);
    // Scope entries are JSON except for a typed logical ref (#98), whose object key is an unquoted
    // TS identifier (`{ campus: "koblenz" }`) — quote it so the whole array parses as JSON.
    const scopeJson = m[2].replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
    grants.push({ right: JSON.parse(m[1]) as string, scope: JSON.parse(`[${scopeJson}]`) as ScopeEntry[] });
  }
  return grants;
}

describe("emitAdoptedGrants", () => {
  it("happy path — emits named unscoped grants and the right DSL function", () => {
    const rows: RawPermission[] = [
      { authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows,
      state: emptyState(),
    });

    expect(block).toContain("ct.groupTypeRole({");
    expect(block).toContain("id: 42,");
    expect(block).toContain('"churchcore:administer settings"');
    // grants are config-only, never a numeric id when the authId is known
    expect(block).not.toContain("authId");
  });

  it("group_role emits ct.groupRole", () => {
    const rows: RawPermission[] = [
      { authId: 1, dataId: null, type: "grant", domainId: 7, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 7, rows, state: emptyState() });
    expect(block).toContain("ct.groupRole({");
  });

  it("scoped grant whose dataId is a managed group → emits the group's logical key", () => {
    const rows: RawPermission[] = [
      { authId: 1104, dataId: 99, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows,
      state: stateWithKids(),
    });

    expect(block).toContain('{ right: "churchgroup:view group", scope: ["kids"] }');
    expect(block).not.toContain("WARNING");
  });

  it("collapses a multi-scope grant (one CT row per dataId) into one entry", () => {
    const state = stateWithKids();
    state.resources.youth = {
      type: "group",
      id: 100,
      key: "youth",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    const rows: RawPermission[] = [
      { authId: 1104, dataId: 99, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
      { authId: 1104, dataId: 100, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state });
    expect(block).toContain('{ right: "churchgroup:view group", scope: ["kids", "youth"] }');
  });

  it("scoped grant whose dataId is NOT managed → clearly-marked placeholder comment, no bare key", () => {
    const rows: RawPermission[] = [
      { authId: 1104, dataId: 777, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows,
      state: emptyState(),
    });

    expect(block).toContain("WARNING: scope target group #777 is not managed");
    expect(block).toContain("ct adopt group 777");
    // the grant is a commented placeholder — never an active line with an invalid/guessed key
    expect(block).toContain('// { right: "churchgroup:view group", scope:');
  });

  it("excludes baseline + inherited rows and notes preserved revoke/deny rows", () => {
    const rows: RawPermission[] = [
      { authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // kept
      { authId: 2, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: -1 } }, // baseline → excluded
      { authId: 3, dataId: null, type: "grant", domainId: 42, isInherited: true }, // inherited → excluded
      { authId: 1104, dataId: 99, type: "revoke", domainId: 42, meta: { modifiedPid: 5 } }, // deny → preserved, noted
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows,
      state: stateWithKids(),
    });

    expect(block).toContain('"churchcore:administer settings"'); // authId 1 kept
    expect(block).not.toContain('scope: ["kids"]'); // the revoke row is NOT emitted as a grant
    expect(block).toContain("1 revoke/deny row(s) exist");
    expect(block).toContain("PRESERVES");
  });

  it("unknown authId → warning comment only (numeric rights are undeclarable), does not fail", () => {
    const rows: RawPermission[] = [
      { authId: 999999, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows,
      state: emptyState(),
    });

    expect(block).toContain("WARNING: authId 999999 has no catalog entry");
    expect(parseEmittedGrants(block)).toEqual([]); // comment only, no active grant line
  });

  it("emits an empty grants array only when the domain grants NOTHING", () => {
    const block = emitAdoptedGrants({
      domainType: "group_role",
      domainId: 42,
      rows: [],
      state: emptyState(),
    });
    expect(block).toContain("grants: [],");
  });

  it("emits a system-baseline grant and says so, instead of silently dropping it (#114)", () => {
    // The same right can be system-authored on one host and user-authored on another — the copy that
    // produced the second host stamps a person id onto rows that are system rows upstream. Dropping
    // it here produced a config that could not be a clean no-op on both: omitted, it REVOKED the
    // right on the other host; declared by hand, it planned `+1 grant` on this one.
    const rows: RawPermission[] = [
      { authId: 2, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: -1 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });
    expect(block).not.toContain("grants: [],");
    expect(block).toContain("NOTE: 1 of the grant(s) above are INHERITED or system-baseline");
  });

  it("group_type_role admin-authored authId >= 10000 member right IS emitted as an active grant (#65)", () => {
    // "churchdb:+edit group infos" (authId 10122) — an admin-authored (pid 5) MEMBER right CT lets you
    // write on group_type_role. It is now managed: emitted as an active grant, never a NOTE comment.
    const rows: RawPermission[] = [
      { authId: 10122, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows,
      state: emptyState(),
    });

    expect(block).not.toContain("NOTE:");
    expect(parseEmittedGrants(block)).toEqual(["churchdb:+edit group infos"]);
  });

  it("group_role right with authId >= 10000 IS emitted (both domains manage member rights)", () => {
    const rows: RawPermission[] = [
      { authId: 10122, dataId: null, type: "grant", domainId: 7, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 7, rows, state: emptyState() });
    expect(parseEmittedGrants(block)).toEqual(["churchdb:+edit group infos"]);
  });

  it("scoped right granted globally (dataId null) → WARNING comment, never a bare string", () => {
    // A bare string for a scoped right is rejected by desiredTuples (silent-global-grant guard).
    const rows: RawPermission[] = [
      { authId: 1104, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows,
      state: emptyState(),
    });

    expect(block).toContain('WARNING: "churchgroup:view group" is granted GLOBALLY here');
    expect(parseEmittedGrants(block)).toEqual([]);
  });

  it("unscoped right carrying dataIds (stale catalog) → WARNING comment, never a scope", () => {
    const rows: RawPermission[] = [
      { authId: 1, dataId: 55, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows,
      state: emptyState(),
    });

    expect(block).toContain('WARNING: "churchcore:administer settings" is unscoped per the catalog');
    expect(parseEmittedGrants(block)).toEqual([]);
  });

  it("header warns that comment-only grants will be REVOKED on apply — and only when some exist", () => {
    const dirty = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows: [
        { authId: 999999, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // unknown authId
        { authId: 1104, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // scoped right granted globally
      ],
      state: emptyState(),
    });
    expect(dirty).toContain("WARNING: 2 live grant(s) could not be expressed as config");
    expect(dirty).toContain("REVOKE");

    const clean = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows: [{ authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }],
      state: emptyState(),
    });
    expect(clean).not.toContain("REVOKE");
  });

  it("scoped grant on a non-group scope dimension → emits the numeric scope form directly, never 'ct adopt group' (#49)", () => {
    // churchdb:view comments (authId 113) is scoped by "cdb_comment_viewer", not a group — dataIds
    // 1/2 will never resolve via `findByTypeId(state, "group", …)`. The right can still be declared:
    // the numeric escape hatch lets adopt emit it as an ACTIVE grant instead of an unresolvable WARNING.
    const rows: RawPermission[] = [
      { authId: 113, dataId: 1, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },
      { authId: 113, dataId: 2, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 9,
      rows,
      state: emptyState(),
    });

    expect(block).toContain('{ right: "churchdb:view comments", scope: [1, 2] }');
    expect(block).not.toContain("ct adopt group");
    expect(block).not.toContain("WARNING");
    // names the right's actual scope dimension in the hint, per catalog scopeField
    expect(block).toContain("cdb_comment_viewer");
  });

  it("scoped grant on the churchdb security-level dimension (cc_securitylevel) round-trips numerically (#49 repro)", () => {
    // Mirrors the real-world case from issue #49: churchdb:security level view/edit own data,
    // scoped to dataIds 1,2,3,5 — none of which are groups (GET /groups/{1,2,3,5} 404s).
    const rows: RawPermission[] = [
      { authId: 131, dataId: 1, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },
      { authId: 131, dataId: 2, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },
      { authId: 131, dataId: 3, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },
      { authId: 131, dataId: 5, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },
      { authId: 132, dataId: 1, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 9,
      rows,
      state: emptyState(),
    });
    const grants = parseEmittedGrants(block);

    expect(block).not.toContain("WARNING");
    expect(block).not.toContain("ct adopt group");
    expect(grants).toEqual([
      { right: "churchdb:security level view own data", scope: [1, 2, 3, 5] },
      { right: "churchdb:security level edit own data", scope: [1] },
    ]);

    // Full round-trip: pasting this block into config and diffing against the SAME live rows must
    // be a no-op — no toPut, and critically no toDelete (a partial block must never revoke a live
    // grant it could not express).
    const desired = grants.flatMap((g) =>
      desiredTuples(
        { key: "adopted", domainType: "group_type_role", domainId: 9, grants: [g] },
        emptyState(),
      ),
    );
    const actual = normalizeActual(rows);
    const diff = diffGrants(desired, actual);
    expect(diff.toPut).toEqual([]);
    expect(diff.toDelete).toEqual([]);
  });

  it("admin-authored member rights (authId >= 10000) are managed; system/inherited rows excluded (#65)", () => {
    // prod, group_type_role 9 (/Struktur): admin-authored churchdb:+… MEMBER rights (authId >=
    // 10000, isInherited:false, modifiedPid != -1) that CT lets you write — verified live (24 such
    // rows, each with a real admin's modifiedPid). They must be adopted as ACTIVE grants and
    // round-trip to a no-op.
    // The self-re-adding system baseline (modifiedPid === -1) and truly-inherited rows must be
    // EXCLUDED by normalizeActual and NEVER show up as `toDelete` (the #65 bug was "0 grant, 24 remove").
    // The reconciliation boundary is inheritance + system-baseline, NOT the authId — hence the
    // excluded rows below also carry authId >= 10000, proving the authId is not the cutoff.
    const rows: RawPermission[] = [
      // writable, user-authored grants (unscoped + group-scoped) — emitted active
      { authId: 1113, dataId: null, type: "grant", domainId: 9, meta: { modifiedPid: 5 } }, // churchgroup:administer groups
      { authId: 1104, dataId: 99, type: "grant", domainId: 9, meta: { modifiedPid: 5 } }, // churchgroup:view group scoped to managed "kids"
      // admin-authored MEMBER rights (authId >= 10000) — NOW managed: unscoped + security-level scopes
      { authId: 10107, dataId: null, type: "grant", domainId: 9, meta: { modifiedPid: 5 } }, // churchdb:+add person (unscoped)
      { authId: 10101, dataId: 2, type: "grant", domainId: 9, meta: { modifiedPid: 5 } }, // churchdb:+see persons scope [2]
      { authId: 10133, dataId: 1, type: "grant", domainId: 9, meta: { modifiedPid: 5 } }, // churchdb:+edit group member fields scope [1]
      // EXCLUDED (authId >= 10000 too): system baseline + a truly-inherited row → never revoked
      { authId: 10122, dataId: null, type: "grant", domainId: 9, meta: { modifiedPid: -1 } }, // system baseline
      { authId: 10111, dataId: null, type: "grant", domainId: 9, isInherited: true }, // inherited
    ];
    const state = stateWithKids();
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 9, rows, state });
    // the admin-authored member rights are emitted as ACTIVE grants, never as omitted WARNINGs. The
    // security-level-scoped ones carry a portable-form NOTE (#110) — advice, not an omission — so the
    // assertion is about what is DECLARED, which `parseEmittedGrants` below reads back in full.
    expect(block).not.toContain("WARNING:");
    expect(block).toContain("churchdb:+add person");
    const grants = parseEmittedGrants(block);

    // Paste-and-plan: diff the emitted declaration against the FULL live row set.
    const desired = grants.flatMap((g) =>
      desiredTuples({ key: "adopted", domainType: "group_type_role", domainId: 9, grants: [g] }, state),
    );
    const actual = normalizeActual(rows);
    const diff = diffGrants(desired, actual, undefined, normalizeEffective(rows));
    // The system-baseline and inherited rows ARE now declared (#114/#119) and are satisfied by the
    // live rows, so they need no PUT...
    expect(diff.toPut).toEqual([]);
    // ...and they are still never revoked: revocation is judged against the OWNED set only.
    expect(diff.toDelete).toEqual([]);
  });

  it("declaring an inherited right is a no-op HERE and stops the revoke THERE (#119)", () => {
    // The measured case: one role instance holds 15 group-member rights that the group's TYPE also
    // grants. On prod they read `isInherited: true`; on dev, byte-identical effective permissions
    // read `isInherited: false`. Adoption used to drop them on prod, so planning that config on dev
    // proposed stripping all 15.
    const AUTH = 10107; // churchdb:+add person — unscoped, so the block round-trips cleanly
    const prodRows: RawPermission[] = [
      { authId: 1113, dataId: null, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },
      { authId: AUTH, dataId: null, type: "grant", domainId: 9, isInherited: true },
    ];
    const devRows: RawPermission[] = [
      { authId: 1113, dataId: null, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },
      { authId: AUTH, dataId: null, type: "grant", domainId: 9, meta: { modifiedPid: 1 } },
    ];

    // Adopt from prod — the inherited right is emitted, not dropped.
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 9,
      rows: prodRows,
      state: emptyState(),
    });
    const grants = parseEmittedGrants(block);
    const desired = grants.flatMap((g) =>
      desiredTuples(
        { key: "adopted", domainType: "group_type_role", domainId: 9, grants: [g] },
        emptyState(),
      ),
    );

    // ...and the SAME config is a clean no-op on both hosts.
    for (const [host, rows] of [
      ["prod", prodRows],
      ["dev", devRows],
    ] as const) {
      const diff = diffGrants(desired, normalizeActual(rows), undefined, normalizeEffective(rows));
      expect(diff.toPut, `${host} toPut`).toEqual([]);
      expect(diff.toDelete, `${host} toDelete`).toEqual([]);
    }
  });

  it("unmanaged group-dimension scope still gets the 'ct adopt group' hint (unchanged behavior)", () => {
    // Regression guard: only NON-group scope dimensions bypass the group-resolution path — a
    // cdb_gruppe-scoped right with an unmanaged dataId must still point at `ct adopt group <id>`.
    const rows: RawPermission[] = [
      { authId: 1104, dataId: 777, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows,
      state: emptyState(),
    });
    expect(block).toContain("ct adopt group 777");
  });

  it("campus-dimension scope whose dataId is a MANAGED campus → emits a logical ref, not a number (#98)", () => {
    // churchdb:view station (authId 124) scopes by cdb_station. Campus ids are host-specific, so an
    // adopted numeric literal is a misgrant when the block is replayed on the other instance.
    const state = stateWithKids();
    state.resources.koblenz = {
      type: "campus",
      id: 23,
      key: "koblenz",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    const rows: RawPermission[] = [
      { authId: 124, dataId: 23, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state });

    expect(block).toContain('{ right: "churchdb:view station", scope: [{ campus: "koblenz" }] }');
    expect(block).not.toContain("scope: [23]");
    expect(block).not.toContain("WARNING");
  });

  it("campus-dimension scope on an UNMANAGED campus stays numeric with a NOTE, and is still applicable (#98)", () => {
    const rows: RawPermission[] = [
      { authId: 124, dataId: 23, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain('{ right: "churchdb:view station", scope: [23] }');
    expect(block).toContain("ct adopt campus 23");
    // A NOTE, not a WARNING: the numeric line IS valid config, just not portable — nothing is at
    // risk of being revoked, so the block-level "will REVOKE" header must stay off.
    expect(block).not.toContain("WARNING");
    expect(block).not.toContain("REVOKE");
  });

  it("mixes managed (logical) and unmanaged (numeric) campus scopes in one grant", () => {
    const state = emptyState();
    state.resources.koblenz = {
      type: "campus",
      id: 23,
      key: "koblenz",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    const rows: RawPermission[] = [
      { authId: 124, dataId: 23, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
      { authId: 124, dataId: 99, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state });
    expect(block).toContain('scope: [{ campus: "koblenz" }, 99]');
  });

  it("points an UNMANAGED comment-viewer scope at `ct adopt comment-viewer` (#151)", () => {
    // This dimension used to be the last catalog-only one, and got the weaker "portable form:
    // { commentViewer: \"<name>\" }" note — honest then, useless in practice, because the NAME did
    // not exist on the other host either. Comment viewers are a managed resource now, so the advice
    // is the same as for every other dimension: adopt the viewer, then re-adopt the grants.
    const rows: RawPermission[] = [
      { authId: 113, dataId: 4, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain("ct adopt comment-viewer 4");
    // The numeric-escape-hatch line is for dimensions with NO logical form at all.
    expect(block).not.toContain("not a group");
    expect(block).toContain('{ right: "churchdb:view comments", scope: [4] }');
  });

  it("emits a MANAGED comment-viewer scope as the portable ref form (#151)", () => {
    const state = emptyState();
    state.resources.dienstbereich = {
      type: "comment-viewer",
      id: 4,
      key: "dienstbereich",
      fields: { name: "Dienstbereich", sortKey: 40 },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const rows: RawPermission[] = [
      { authId: 113, dataId: 4, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state });

    // The whole point of #151: what used to be a raw host-specific 4 is now a name that means the
    // same thing on the host this config is replayed against.
    expect(block).toContain('scope: [{ commentViewer: "dienstbereich" }]');
    expect(block).not.toContain("ct adopt comment-viewer");
  });

  it("points an unmanaged Bereich scope at `ct adopt department` now that Bereiche are managed (#108)", () => {
    const rows: RawPermission[] = [
      { authId: 102, dataId: 4, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // cdb_bereich
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });
    expect(block).toContain("ct adopt department 4");
    expect(block).toContain('{ right: "churchdb:view alldata", scope: [4] }');
  });

  it("points an UNMANAGED security-level scope at `ct adopt security-level` (#110)", () => {
    // Security levels are a managed resource now, so the honest advice is the same as for any other
    // managed dimension: adopt the level, then re-adopt the grants to get the portable ref form.
    const rows: RawPermission[] = [
      { authId: 125, dataId: 2, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // cc_securitylevel
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });
    expect(block).toContain("ct adopt security-level 2");
    expect(block).not.toContain("not a group");
    expect(block).toContain('{ right: "churchdb:security level person", scope: [2] }');
  });

  it("emits a MANAGED security-level scope as the portable ref (#110)", () => {
    const state: State = {
      ...emptyState(),
      resources: {
        stufe_2_mittel: {
          type: "security-level",
          id: 2,
          key: "stufe_2_mittel",
          fields: { id: 2, name: "Stufe 2 (Mittel)" },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    const rows: RawPermission[] = [
      { authId: 125, dataId: 2, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state });
    expect(block).toContain('scope: [{ securityLevel: "stufe_2_mittel" }]');
  });

  it("a dimension with no logical form still gets the numeric-escape-hatch note", () => {
    const rows: RawPermission[] = [
      // cc_calcategory — a calendar dimension, outside this tool's mandate, so no ref kind exists.
      { authId: 403, dataId: 2, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });
    expect(block).toContain("not a group");
    expect(block).not.toContain("Portable form");
  });

  it("names EVERY unmanaged dataId in the adopt hint, not just the first", () => {
    const rows: RawPermission[] = [
      { authId: 124, dataId: 23, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
      { authId: 124, dataId: 99, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
      { authId: 124, dataId: 101, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });
    for (const id of [23, 99, 101]) {
      expect(block).toContain(`ct adopt campus ${id}`);
    }
  });

  it("round trip — every emitted grant passes the real desiredTuples, for any mix of rows", async () => {
    const state = stateWithKids();
    // A managed campus, so the fixture also covers the #98 typed-ref emission form (`{ campus: … }`)
    // — without it the round-trip property was only ever exercised on group/numeric scopes, and the
    // one shape that needs a pre-resolved ScopeRefMap went unchecked.
    state.resources.koblenz = {
      type: "campus",
      id: 23,
      key: "koblenz",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    const rows: RawPermission[] = [
      { authId: 124, dataId: 23, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // cdb_station, managed → { campus: … }
      { authId: 124, dataId: 777, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // cdb_station, unmanaged → numeric
      { authId: 102, dataId: 4, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // cdb_bereich (catalog-only) → numeric
      { authId: 125, dataId: 2, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // cc_securitylevel (no logical form) → numeric
      { authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // known unscoped
      { authId: 1, dataId: 55, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // unscoped w/ dataId (stale catalog)
      { authId: 1104, dataId: 99, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // scoped, managed
      { authId: 1104, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // scoped, GLOBAL
      { authId: 1112, dataId: 777, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // scoped, unmanaged
      { authId: 999999, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // unknown authId
      { authId: 10122, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // >= 10000
      { authId: 2, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: -1 } }, // baseline
      { authId: 3, dataId: null, type: "grant", domainId: 42, isInherited: true }, // inherited
      { authId: 1112, dataId: 99, type: "revoke", domainId: 42, meta: { modifiedPid: 5 } }, // deny
    ];
    for (const domainType of ["group_role", "group_type_role"] as DomainType[]) {
      const block = emitAdoptedGrants({ domainType, domainId: 42, rows, state });
      const grants = parseEmittedGrants(block);
      expect(grants.length).toBeGreaterThan(0); // the property is not vacuous
      const permission = { key: "adopted", domainType, domainId: 42, grants };
      // The invariant is "passes desiredTuples GIVEN the plan's pre-resolution pass" — a typed scope
      // ref must be resolved first (buildPermissionPlan always does this), so run the real
      // resolveScopeRefs here rather than asserting against an empty map.
      const resolver = new Resolver({ client: catalogClient(), state, desired: [] });
      const refs = await resolveScopeRefs([permission], resolver, state);
      expect(() => desiredTuples(permission, state, new Set(), refs)).not.toThrow();
      // …and the emitted campus ref really did resolve to this host's managed campus id.
      const campusTuple = desiredTuples(permission, state, new Set(), refs).find(
        (t) => t.authId === 124 && t.dataId.includes(23),
      );
      expect(campusTuple).toBeDefined();
    }
  });
});

describe('the built-in "Alle" comment viewer (dataId 0) is not a host-specific id (#151)', () => {
  // `churchdb:view comments` (authId 113) scopes by `cdb_comment_viewer`. Unlike `-1`, `0` is a REAL
  // row — but it is one CT ships on every instance, so the number already means the same thing on
  // every host. Adopting it is the trap: `ct adopt comment-viewer 0` yields
  // `ct.commentViewer({ key: "alle", name: "Alle" })`, and replaying that on a second host with a
  // fresh state finds no state entry, POSTs a SECOND "Alle", and scopes the grant to the duplicate —
  // the exact misgrant #151 exists to prevent, plus a catalog with two "Alle" rows that makes
  // `{ commentViewer: "alle" }` permanently ambiguous.
  const alleRows: RawPermission[] = [
    { authId: 113, dataId: 0, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
  ];

  const block = (rows: RawPermission[] = alleRows) =>
    emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });

  it("never tells you to adopt it", () => {
    expect(block()).not.toMatch(/ct adopt comment-viewer 0/);
  });

  it("does not call it host-specific, because it is not", () => {
    expect(block()).not.toMatch(/0 is not managed/);
    expect(block()).not.toMatch(/host-specific number/);
  });

  it("says what it actually is", () => {
    expect(block()).toMatch(/scope 0 is the built-in "Alle" comment-viewer/);
    expect(block()).toContain("present on every instance");
  });

  it("emits the NUMBER, not a name — a built-in row can still be renamed by an admin", () => {
    expect(block()).toContain("scope: [0]");
    expect(block()).not.toContain("{ commentViewer:");
  });

  it("still flags a REAL unmanaged viewer id in the same grant", () => {
    const mixed: RawPermission[] = [
      { authId: 113, dataId: 0, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
      { authId: 113, dataId: 4, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const out = block(mixed);
    expect(out).toContain("scope: [0, 4]");
    expect(out).toMatch(/ct adopt comment-viewer 4/);
    expect(out).not.toMatch(/ct adopt comment-viewer 0/);
    // The "4 is not managed" note must name 4 alone, never "0, 4".
    expect(out).not.toMatch(/0, 4 (is|are) not managed/);
  });

  it("is scoped to the comment-viewer dimension — `0` elsewhere is an ordinary id", () => {
    // `churchdb:view alldata` (102) scopes by `cdb_bereich`, where 0 has no special meaning.
    const other: RawPermission[] = [
      { authId: 102, dataId: 0, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    expect(block(other)).toMatch(/ct adopt department 0/);
  });
});

describe('the `-1` "alle" sentinel is not a host-specific id (#115)', () => {
  // `churchdb:view alldata` (authId 102) scopes by `cdb_bereich`; `churchdb:view station` (124) by
  // `cdb_station`. A grant scoped to "alle" comes back as `dataId: -1`.
  const sentinelRows: RawPermission[] = [
    { authId: 102, dataId: -1, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    { authId: 124, dataId: -1, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
  ];

  const block = () =>
    emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows: sentinelRows, state: emptyState() });

  it("never tells you to adopt it — `ct adopt department -1` cannot work", () => {
    expect(block()).not.toMatch(/ct adopt \S+ -1/);
  });

  it("does not call it host-specific, because it is not", () => {
    expect(block()).not.toMatch(/-1 is not managed/);
    expect(block()).not.toMatch(/host-specific number/);
  });

  it("says what it actually is, once per grant", () => {
    const lines = block()
      .split("\n")
      .filter((l) => l.includes('"alle" sentinel'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("host-independent");
  });

  it("still emits the scope value itself, so the declaration keeps its meaning", () => {
    expect(block()).toContain("scope: [-1]");
  });

  it("still flags a REAL unmanaged id in the same grant", () => {
    // Mixed scope: -1 is fine, 77 is a genuine host-specific id that does need adopting.
    const mixed: RawPermission[] = [
      { authId: 1104, dataId: -1, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
      { authId: 1104, dataId: 77, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const out = emitAdoptedGrants({
      domainType: "group_role",
      domainId: 42,
      rows: mixed,
      state: emptyState(),
    });
    expect(out).toContain("ct adopt group 77");
    expect(out).not.toContain("ct adopt group -1");
  });
});
