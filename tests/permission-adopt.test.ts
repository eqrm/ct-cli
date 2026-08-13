import { describe, it, expect } from "vitest";
import { emitAdoptedGrants } from "../src/permissions/adopt.js";
import { diffGrants, normalizeActual, type DomainType, type RawPermission } from "../src/permissions/grants.js";
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
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain("ct.groupTypeRole({");
    expect(block).toContain("id: 42,");
    expect(block).toContain('"churchcore:administer settings"');
    // grants are config-only, never a numeric id when the authId is known
    expect(block).not.toContain("authId");
  });

  it("group_role emits ct.groupRole", () => {
    const rows: RawPermission[] = [{ authId: 1, dataId: null, type: "grant", domainId: 7, meta: { modifiedPid: 5 } }];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 7, rows, state: emptyState() });
    expect(block).toContain("ct.groupRole({");
  });

  it("scoped grant whose dataId is a managed group → emits the group's logical key", () => {
    const rows: RawPermission[] = [
      { authId: 1104, dataId: 99, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: stateWithKids() });

    expect(block).toContain('{ right: "churchgroup:view group", scope: ["kids"] }');
    expect(block).not.toContain("WARNING");
  });

  it("collapses a multi-scope grant (one CT row per dataId) into one entry", () => {
    const state = stateWithKids();
    state.resources.youth = { type: "group", id: 100, key: "youth", fields: {}, adoptedAt: "t", updatedAt: "t" };
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
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain("WARNING: scope target group #777 is not managed");
    expect(block).toContain("ct adopt group 777");
    // the grant is a commented placeholder — never an active line with an invalid/guessed key
    expect(block).toContain("// { right: \"churchgroup:view group\", scope:");
  });

  it("excludes baseline + inherited rows and notes preserved revoke/deny rows", () => {
    const rows: RawPermission[] = [
      { authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // kept
      { authId: 2, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: -1 } }, // baseline → excluded
      { authId: 3, dataId: null, type: "grant", domainId: 42, isInherited: true }, // inherited → excluded
      { authId: 1104, dataId: 99, type: "revoke", domainId: 42, meta: { modifiedPid: 5 } }, // deny → preserved, noted
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: stateWithKids() });

    expect(block).toContain('"churchcore:administer settings"'); // authId 1 kept
    expect(block).not.toContain('scope: ["kids"]'); // the revoke row is NOT emitted as a grant
    expect(block).toContain("1 revoke/deny row(s) exist");
    expect(block).toContain("PRESERVES");
  });

  it("unknown authId → warning comment only (numeric rights are undeclarable), does not fail", () => {
    const rows: RawPermission[] = [
      { authId: 999999, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain("WARNING: authId 999999 has no catalog entry");
    expect(parseEmittedGrants(block)).toEqual([]); // comment only, no active grant line
  });

  it("emits an empty grants array when no user-authored grants remain", () => {
    const rows: RawPermission[] = [
      { authId: 2, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: -1 } }, // baseline only
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });
    expect(block).toContain("grants: [],");
  });

  it("group_type_role admin-authored authId >= 10000 member right IS emitted as an active grant (#65)", () => {
    // "churchdb:+edit group infos" (authId 10122) — an admin-authored (pid 5) MEMBER right CT lets you
    // write on group_type_role. It is now managed: emitted as an active grant, never a NOTE comment.
    const rows: RawPermission[] = [
      { authId: 10122, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

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
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain('WARNING: "churchgroup:view group" is granted GLOBALLY here');
    expect(parseEmittedGrants(block)).toEqual([]);
  });

  it("unscoped right carrying dataIds (stale catalog) → WARNING comment, never a scope", () => {
    const rows: RawPermission[] = [
      { authId: 1, dataId: 55, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

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
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 9, rows, state: emptyState() });

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
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 9, rows, state: emptyState() });
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
    const desired = grants.flatMap((g) => desiredTuples({ key: "adopted", domainType: "group_type_role", domainId: 9, grants: [g] }, emptyState()));
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
      { authId: 1104, dataId: 99, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },   // churchgroup:view group scoped to managed "kids"
      // admin-authored MEMBER rights (authId >= 10000) — NOW managed: unscoped + security-level scopes
      { authId: 10107, dataId: null, type: "grant", domainId: 9, meta: { modifiedPid: 5 } }, // churchdb:+add person (unscoped)
      { authId: 10101, dataId: 2, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },    // churchdb:+see persons scope [2]
      { authId: 10133, dataId: 1, type: "grant", domainId: 9, meta: { modifiedPid: 5 } },    // churchdb:+edit group member fields scope [1]
      // EXCLUDED (authId >= 10000 too): system baseline + a truly-inherited row → never revoked
      { authId: 10122, dataId: null, type: "grant", domainId: 9, meta: { modifiedPid: -1 } }, // system baseline
      { authId: 10111, dataId: null, type: "grant", domainId: 9, isInherited: true },          // inherited
    ];
    const state = stateWithKids();
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 9, rows, state });
    // the admin-authored member rights are emitted as ACTIVE grants, never NOTE comments
    expect(block).not.toContain("NOTE:");
    expect(block).toContain("churchdb:+add person");
    const grants = parseEmittedGrants(block);

    // Paste-and-plan: diff the emitted declaration against the FULL live row set. normalizeActual
    // drops the system-baseline + inherited rows, so they never appear as revokes.
    const desired = grants.flatMap((g) => desiredTuples({ key: "adopted", domainType: "group_type_role", domainId: 9, grants: [g] }, state));
    const actual = normalizeActual(rows);
    const diff = diffGrants(desired, actual);
    expect(diff.toPut).toEqual([]);
    expect(diff.toDelete).toEqual([]); // critically: the system/inherited rows are NOT revoked
  });

  it("unmanaged group-dimension scope still gets the 'ct adopt group' hint (unchanged behavior)", () => {
    // Regression guard: only NON-group scope dimensions bypass the group-resolution path — a
    // cdb_gruppe-scoped right with an unmanaged dataId must still point at `ct adopt group <id>`.
    const rows: RawPermission[] = [
      { authId: 1104, dataId: 777, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });
    expect(block).toContain("ct adopt group 777");
  });

  it("campus-dimension scope whose dataId is a MANAGED campus → emits a logical ref, not a number (#98)", () => {
    // churchdb:view station (authId 124) scopes by cdb_station. Campus ids are host-specific, so an
    // adopted numeric literal is a misgrant when the block is replayed on the other instance.
    const state = stateWithKids();
    state.resources.koblenz = { type: "campus", id: 23, key: "koblenz", fields: {}, adoptedAt: "t", updatedAt: "t" };
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
    state.resources.koblenz = { type: "campus", id: 23, key: "koblenz", fields: {}, adoptedAt: "t", updatedAt: "t" };
    const rows: RawPermission[] = [
      { authId: 124, dataId: 23, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
      { authId: 124, dataId: 99, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state });
    expect(block).toContain('scope: [{ campus: "koblenz" }, 99]');
  });

  it("a catalog-only dimension gets ONE note — the portable form, not the 'not a group' line", () => {
    const rows: RawPermission[] = [
      { authId: 102, dataId: 4, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // cdb_bereich
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain('Portable form: { department: "<name>" }');
    // The numeric-escape-hatch line is for dimensions with NO logical form; emitting it here too
    // would contradict the portable-form note directly above it.
    expect(block).not.toContain("not a group");
    expect(block).toContain('{ right: "churchdb:view alldata", scope: [4] }');
  });

  it("a dimension with no logical form still gets the numeric-escape-hatch note", () => {
    const rows: RawPermission[] = [
      { authId: 125, dataId: 2, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // cc_securitylevel
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
    state.resources.koblenz = { type: "campus", id: 23, key: "koblenz", fields: {}, adoptedAt: "t", updatedAt: "t" };
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
