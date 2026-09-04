/**
 * Portable-ruleset ergonomics (#76, Stages 1–2): the `var → RefKind` catalog and the pure
 * `portablizeRuleset` reverse-rewrite helper. Everything here is offline and deterministic — the
 * caller supplies the per-kind id→key maps and the role catalog; no network, no live writes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  VAR_REF_KINDS,
  formatPortablizeWarnings,
  portablizeRuleset,
  scanUnportablized,
  type RoleCatalogEntry,
} from "../src/config/query-refs.js";
import { q, churchQuery } from "../src/config/query.js";
import { normalizeRuleset } from "../src/engine/dynamic.js";
import { deepMapRefs, ref, refKey, type Ref, type RefKind } from "../src/resolve/refs.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("VAR_REF_KINDS catalog (#76 Stage 1)", () => {
  it("maps every SIMPLE entity var observed in the captured prod rulesets to a real RefKind", () => {
    // Exactly the simple, name-based entity vars present in ct-structure/rulesets/*.json, verified
    // against the real files (2026-07-11). `role.id` is NOT here — it is a group-type-scoped role
    // (groupTypeRoleId) handled by the role special case in portablizeRuleset (see the test below and
    // the module comment), because role names are not globally unique across group types (#76).
    expect(VAR_REF_KINDS).toEqual({
      "ctgroup.id": "group",
      "ctgroup.campusId": "campus",
      "ctgroup.groupTypeId": "group-type",
      "ctgroup.groupStatusId": "group-status",
      "person.campusId": "campus",
    });
  });

  it("leaves role.id, non-entity, and catalog-less vars OUT of the table", () => {
    // role.id is deliberately absent (fixed in #76, reverting #86's wrong `role-def` mapping): it needs
    // the (group-type, role-name) special case, not a lone name-based kind. groupStatusId has no REST
    // catalog (#67); isArchived/dateOfDeath are boolean/date literals.
    expect(VAR_REF_KINDS["role.id"]).toBeUndefined();
    expect(VAR_REF_KINDS["ctgroup.groupStatusId"]).toBe("group-status");
    expect(VAR_REF_KINDS["person.isArchived"]).toBeUndefined();
    expect(VAR_REF_KINDS["person.dateOfDeath"]).toBeUndefined();
  });
});

describe("portablizeRuleset (#76 Stage 2)", () => {
  it("rewrites a managed id in a `==` var position to the exact ref marker shape", () => {
    const ruleset = { query: churchQuery(q.eq("ctgroup.campusId", 7)) };
    const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
      idToKeyByKind: { campus: new Map([[7, "mainz"]]) },
    });
    const filter = (out.query as { params: { filter: { "==": unknown[] } } }).params.filter;
    // Byte-identical to JSON.stringify(ref.campus("mainz")) — the marker isRef() already resolves.
    expect(filter["=="][1]).toEqual({ __ctRef: true, kind: "campus", key: "mainz" });
    expect(warnings).toEqual([]);
  });

  it("rewrites every managed id in a `oneof` id list and keeps operand order", () => {
    const ruleset = { query: churchQuery(q.oneof("ctgroup.id", [148, 1228])) };
    const { ruleset: out } = portablizeRuleset(ruleset, {
      idToKeyByKind: {
        group: new Map([
          [148, "jugend-mainz"],
          [1228, "jugend-berlin"],
        ]),
      },
    });
    const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
    expect(filter.oneof[0]).toEqual({ var: "ctgroup.id" });
    expect(filter.oneof[1]).toEqual([
      { __ctRef: true, kind: "group", key: "jugend-mainz" },
      { __ctRef: true, kind: "group", key: "jugend-berlin" },
    ]);
  });

  it("leaves an unmanaged id numeric and collects a warning naming the reason (#101)", () => {
    const ruleset = { query: churchQuery(q.oneof("ctgroup.id", [148, 999])) };
    const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
      idToKeyByKind: { group: new Map([[148, "jugend-mainz"]]) },
    });
    const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
    expect(filter.oneof[1]).toEqual([{ __ctRef: true, kind: "group", key: "jugend-mainz" }, 999]);
    expect(warnings).toEqual([
      {
        var: "ctgroup.id",
        id: 999,
        reason: "unmanaged",
        detail: "not under management — `ct adopt group <id>` for each (then re-adopt) makes them portable",
      },
    ]);
  });

  it("rewrites known groupStatusId values and preserves unknown ids with a warning (#157)", () => {
    const ruleset = { query: churchQuery(q.oneof("ctgroup.groupStatusId", [1, 2, 4])) };
    const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
      idToKeyByKind: {
        "group-status": new Map([
          [1, "active"],
          [2, "pending"],
        ]),
      },
    });
    const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
    expect(filter.oneof[1]).toEqual([ref.status("active"), ref.status("pending"), 4]);
    expect(warnings.map((w) => w.id)).toEqual([4]);
    expect(new Set(warnings.map((w) => w.reason))).toEqual(new Set(["unmanaged"]));
  });

  it("does not mutate its input ruleset", () => {
    const ruleset = { query: churchQuery(q.eq("ctgroup.campusId", 7)) };
    const before = JSON.stringify(ruleset);
    portablizeRuleset(ruleset, { idToKeyByKind: { campus: new Map([[7, "mainz"]]) } });
    expect(JSON.stringify(ruleset)).toEqual(before);
  });

  describe("role.id → (group-type, role-name) marker (#76 — the fix for #86's role-def mapping)", () => {
    // A `role.id` is a groupTypeRoleId: two ids can share a role NAME on different group types, so the
    // marker must carry the (group-type, role-name) pair, resolved via /group/roles by (groupTypeId, name).
    const roleCatalog = new Map<number, RoleCatalogEntry>([
      [84, { groupTypeId: 12, name: "Leiter" }],
      [16, { groupTypeId: 2, name: "Leiter" }], // SAME name as 84, different group type
    ]);
    const groupTypeIdToKey = new Map<number, string>([
      [12, "local_lead"],
      [2, "team"],
    ]);

    it("disambiguates two same-named roles by their group type", () => {
      const ruleset = { query: churchQuery(q.oneof("role.id", [84, 16])) };
      const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
        idToKeyByKind: {},
        roleCatalog,
        groupTypeIdToKey,
      });
      const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
      expect(filter.oneof[1]).toEqual([
        { __ctRef: true, kind: "group-type-role", groupType: "local_lead", role: "Leiter" },
        { __ctRef: true, kind: "group-type-role", groupType: "team", role: "Leiter" },
      ]);
      expect(warnings).toEqual([]);
    });

    it("leaves a role id whose group type is unmanaged numeric, with a { var: 'role.id' } warning", () => {
      const ruleset = { query: churchQuery(q.oneof("role.id", [84, 999])) };
      const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
        idToKeyByKind: {},
        roleCatalog,
        groupTypeIdToKey,
      });
      const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
      expect(filter.oneof[1]).toEqual([
        { __ctRef: true, kind: "group-type-role", groupType: "local_lead", role: "Leiter" },
        999, // not in roleCatalog → numeric
      ]);
      expect(warnings).toEqual([
        {
          var: "role.id",
          id: 999,
          reason: "role-unknown",
          detail: "no /group/roles row on this host carries these groupTypeRoleIds",
        },
      ]);
    });

    it("distinguishes 'role unknown' from 'role's group type unmanaged' (#101)", () => {
      const ruleset = { query: churchQuery(q.oneof("role.id", [84])) };
      const { warnings } = portablizeRuleset(ruleset, {
        idToKeyByKind: {},
        roleCatalog, // 84 → group type 12 …
        groupTypeIdToKey: new Map(), // … which is NOT managed here
      });
      expect(warnings).toEqual([
        {
          var: "role.id",
          id: 84,
          reason: "role-group-type-unmanaged",
          detail:
            "the role's group type is not managed — " +
            "adopt that group type to make the (group-type, role) pair portable",
        },
      ]);
    });

    it("leaves role.id numeric (with a warning) when no roleCatalog is supplied at all", () => {
      const ruleset = { query: churchQuery(q.oneof("role.id", [84])) };
      const { ruleset: out, warnings } = portablizeRuleset(ruleset, { idToKeyByKind: {} });
      const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
      expect(filter.oneof[1]).toEqual([84]);
      expect(warnings).toEqual([
        {
          var: "role.id",
          id: 84,
          reason: "role-unknown",
          detail: "no /group/roles row on this host carries these groupTypeRoleIds",
        },
      ]);
    });
  });

  describe("process.*.handleMembership.groupTypeRoleId — an out-of-query role field (#76)", () => {
    const roleCatalog = new Map<number, RoleCatalogEntry>([[66, { groupTypeId: 9, name: "Mitglied" }]]);
    const groupTypeIdToKey = new Map<number, string>([[9, "struktur"]]);

    it("rewrites the integer field to a group-type-role marker via the same role catalog", () => {
      const ruleset = {
        query: churchQuery(q.eq("person.isArchived", 0)),
        process: {
          queryResultOnly: {
            none: { handleMembership: { groupMemberStatus: "active", groupTypeRoleId: 66 } },
          },
        },
      };
      const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
        idToKeyByKind: {},
        roleCatalog,
        groupTypeIdToKey,
      });
      const hm = (out.process as { queryResultOnly: { none: { handleMembership: Record<string, unknown> } } })
        .queryResultOnly.none.handleMembership;
      expect(hm.groupTypeRoleId).toEqual({
        __ctRef: true,
        kind: "group-type-role",
        groupType: "struktur",
        role: "Mitglied",
      });
      expect(hm.groupMemberStatus).toBe("active"); // sibling string untouched
      expect(warnings).toEqual([]);
    });

    it("leaves the field numeric with a warning when the role is unknown", () => {
      const ruleset = {
        process: { queryResultOnly: { none: { handleMembership: { groupTypeRoleId: 4242 } } } },
      };
      const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
        idToKeyByKind: {},
        roleCatalog,
        groupTypeIdToKey,
      });
      const hm = (out.process as { queryResultOnly: { none: { handleMembership: Record<string, unknown> } } })
        .queryResultOnly.none.handleMembership;
      expect(hm.groupTypeRoleId).toBe(4242);
      expect(warnings).toEqual([
        {
          var: "groupTypeRoleId",
          id: 4242,
          reason: "role-unknown",
          detail: "no /group/roles row on this host carries these groupTypeRoleIds",
        },
      ]);
    });
  });

  describe("real captured prod ruleset round-trip (skidscheckinopsmz.json)", () => {
    // The real ct-structure ruleset the #76 fix targets: ctgroup.id ["112","8","1246"], role.id
    // ["84","85","17","16"], and process...handleMembership.groupTypeRoleId 66 (OUT of the query).
    const raw = JSON.parse(
      readFileSync(join(here, "fixtures/dynamic/portablize-skidscheckinopsmz.json"), "utf8"),
    );
    // captureDynamic normalizes first (numeric-string ids → numbers), so Stage 2 runs on numbers.
    const normalized = normalizeRuleset(raw);

    // The real decode of the referenced ids (live prod /api/group/roles + /group/grouptypes, 2026-07-11).
    const roleCatalog = new Map<number, RoleCatalogEntry>([
      [84, { groupTypeId: 12, name: "Leiter" }],
      [85, { groupTypeId: 12, name: "Organisator" }],
      [16, { groupTypeId: 2, name: "Leiter" }],
      [17, { groupTypeId: 2, name: "Organisator" }],
      [66, { groupTypeId: 9, name: "Mitglied" }], // the process.groupTypeRoleId target
    ]);
    const groupTypeIdToKey = new Map<number, string>([
      [12, "local_lead"],
      [2, "team"],
      [9, "struktur"],
    ]);
    // Group 1246 is deliberately UNMANAGED (not in the map) — the escape hatch: it stays numeric.
    const idToKeyByKind: Partial<Record<RefKind, Map<number, string>>> = {
      group: new Map([
        [112, "bereich_kids"],
        [8, "team_kidsdienst"],
      ]),
      "group-status": new Map([
        [1, "active"],
        [2, "pending"],
        [4, "finished"],
      ]),
    };
    const opts = { idToKeyByKind, roleCatalog, groupTypeIdToKey };

    it("produces (group-type, role-name) markers for the query roles AND the process groupTypeRoleId", () => {
      const { ruleset: portable } = portablizeRuleset(normalized, opts);
      const json = JSON.stringify(portable);
      // A query role marker (84 → local_lead/Leiter) and the process-field marker (66 → struktur/Mitglied).
      expect(json).toContain(
        '{"__ctRef":true,"kind":"group-type-role","groupType":"local_lead","role":"Leiter"}',
      );
      const hm = (
        portable.process as { queryResultOnly: { none: { handleMembership: Record<string, unknown> } } }
      ).queryResultOnly.none.handleMembership;
      expect(hm.groupTypeRoleId).toEqual({
        __ctRef: true,
        kind: "group-type-role",
        groupType: "struktur",
        role: "Mitglied",
      });
    });

    it("resolves byte-faithfully back to the original ids (round-trip, incl. process.groupTypeRoleId)", () => {
      const { ruleset: portable } = portablizeRuleset(normalized, opts);
      // Inverse map keyed by refKey — the identity string the resolver caches by — applied with the SAME
      // deepMapRefs the resolver uses. Markers sit exactly where the ids were, so the whole ruleset
      // (query filter AND the out-of-query process.groupTypeRoleId) restores byte-identical.
      const keyToId = new Map<string, number>();
      for (const [id, key] of [
        [112, "bereich_kids"],
        [8, "team_kidsdienst"],
      ] as const) {
        keyToId.set(refKey({ __ctRef: true, kind: "group", key }), id);
      }
      for (const [id, entry] of roleCatalog) {
        keyToId.set(
          refKey({
            __ctRef: true,
            kind: "group-type-role",
            groupType: groupTypeIdToKey.get(entry.groupTypeId)!,
            role: entry.name,
          }),
          id,
        );
      }
      for (const [id, key] of idToKeyByKind["group-status"]!) {
        keyToId.set(refKey(ref.status(key)), id);
      }
      const back = deepMapRefs(portable, (r: Ref) => keyToId.get(refKey(r)));
      expect(back).toEqual(normalized);
    });

    it("leaves only the unmanaged group id numeric; known group statuses become refs (#157)", () => {
      const { ruleset: portable, warnings } = portablizeRuleset(normalized, opts);
      const json = JSON.stringify(portable);
      expect(json).toContain("1246"); // unmanaged group id survives numeric
      expect(warnings).toContainEqual({
        var: "ctgroup.id",
        id: 1246,
        reason: "unmanaged",
        detail: "not under management — `ct adopt group <id>` for each (then re-adopt) makes them portable",
      });
      expect(json).toContain('"kind":"group-status"');
      expect(warnings.some((w) => w.var === "ctgroup.groupStatusId")).toBe(false);
    });

    it("scanUnportablized reports the same ids from the ALREADY-PORTABLIZED file (#101 plan-time check)", () => {
      const { ruleset: portable } = portablizeRuleset(normalized, opts);
      const left = scanUnportablized(portable);
      // Every marker-rewritten id is gone from the report; the numeric leftovers remain.
      expect(left.some((w) => w.var === "ctgroup.id" && w.id === 1246)).toBe(true);
      expect(left.some((w) => w.id === 112 || w.id === 8)).toBe(false); // now `{ __ctRef }` markers
      expect(formatPortablizeWarnings(left).some((l) => l.startsWith("ctgroup.id: 1246 left numeric"))).toBe(
        true,
      );
    });

    // The scan has no state, no catalogs and no network, so it can prove POSITION and nothing else.
    // Reporting "unmanaged" from here told someone whose group IS adopted that it is not under
    // management — on every plan — and handed them a `ct adopt` that fails because it already is.
    it("reports only what position proves — never an unchecked 'unmanaged'/'role-unknown' verdict", () => {
      const left = scanUnportablized(normalized);
      expect(left.some((w) => w.var === "ctgroup.id")).toBe(true);
      expect(left.filter((w) => w.var === "ctgroup.id").every((w) => w.reason === "left-numeric")).toBe(true);
      expect(left.filter((w) => w.var === "role.id").every((w) => w.reason === "left-numeric")).toBe(true);
      expect(left.some((w) => /is not under management|no \/group\/roles row/.test(w.detail))).toBe(false);
      expect(
        left.filter((w) => w.var === "ctgroup.groupStatusId").every((w) => w.reason === "left-numeric"),
      ).toBe(true);
    });
  });
});

describe("person.id is reported by the portability audit (#127)", () => {
  // Four of five auto-group rulesets captured in one week included or excluded specific people by
  // id. Those are the SOURCE host's person ids written verbatim into the other host's ruleset, where
  // they name entirely different people — the same failure mode as a raw `ctgroup.id`, and the one
  // the warning did not mention. The absence of a warning implied there was nothing to find.

  it("reports an `oneof` include-list of person ids", () => {
    const w = scanUnportablized({ oneof: [{ var: "person.id" }, [5703, 4389]] });
    expect(w.map((x) => x.id).sort((a, b) => a - b)).toEqual([4389, 5703]);
    expect(w.every((x) => x.var === "person.id")).toBe(true);
  });

  it("reports a NEGATED exclusion clause too — the dangerous one", () => {
    // `person.id` 1 exists on every ChurchTools instance and is almost always an administrator, so
    // an exclusion aimed at one person here lands on someone real there.
    const w = scanUnportablized({ "!": [{ oneof: [{ var: "person.id" }, [12, 1]] }] });
    expect(w.map((x) => x.id).sort((a, b) => a - b)).toEqual([1, 12]);
  });

  it("reports an equality comparison against a single person id", () => {
    expect(scanUnportablized({ "==": [{ var: "person.id" }, 5703] })).toHaveLength(1);
  });

  it("words it as unfixable — a decision, not a command that will fail", () => {
    const lines = formatPortablizeWarnings(scanUnportablized({ oneof: [{ var: "person.id" }, [5703]] }));
    const text = lines.join("\n");
    expect(text).toContain("person.id");
    expect(text).toContain("NEVER portable");
    expect(text).toContain("DIFFERENT people on another host");
    // There is no `ct adopt person` and there never will be — people are permanently out of scope.
    expect(text).not.toMatch(/ct adopt person/);
  });

  it("does not fire on a non-id person literal", () => {
    // Reporting `person.age > 18` would bury the real findings in noise.
    expect(scanUnportablized({ ">": [{ var: "person.age" }, 18] })).toEqual([]);
  });

  it("reports person ids alongside the ctgroup ids it already found", () => {
    const w = scanUnportablized({
      and: [{ oneof: [{ var: "ctgroup.id" }, [3090]] }, { "!": [{ oneof: [{ var: "person.id" }, [1]] }] }],
    });
    expect(new Set(w.map((x) => x.var))).toEqual(new Set(["ctgroup.id", "person.id"]));
  });
});

describe("ruleset role refs fall back to a managed role-def only when the name pair is ambiguous (#125)", () => {
  // `role.id` portablizes to a (group type, role NAME) pair, resolved by filtering `/group/roles` on
  // (groupTypeId, slug(name)). Two rows sharing a name on ONE group type make that a hard error — and
  // neither remedy the error offered works for a config shared across hosts: "rename" edits
  // ChurchTools master data (here, CT's own stock `leader`), and "pass a numeric id" cannot work
  // because the roles have different ids per host with no env to branch on. A managed `role-def` key
  // is the way out of THAT case.
  //
  // It is only a way out of that case, though. Off this host a `role-def` ref is the WEAKER of the
  // two: the resolver falls back to a `/group/roles` lookup keyed on slug(name) alone, so on a host
  // where the role was never adopted under the shared key it can resolve silently to a role on a
  // different group type. The pair cannot fail that way. So the pair stays the default and `role-def`
  // is reserved for the ids the pair genuinely cannot name.
  const groupTypeIdToKey = new Map([[30, "community"]]);
  // Two rows, same group type, same name — the collision #125 is actually about.
  const ambiguousCatalog = new Map([
    [207, { groupTypeId: 30, name: "leader" }],
    [208, { groupTypeId: 30, name: "Leader" }],
  ]);
  // One row — the common case: unique across all 46 prod roles.
  const uniqueCatalog = new Map([[207, { groupTypeId: 30, name: "leader" }]]);
  const ruleset = { oneof: [{ var: "role.id" }, [207]] };

  it("emits a role-def ref when the name pair is ambiguous and the role is under management", () => {
    const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
      idToKeyByKind: { "role-def": new Map([[207, "community_leader"]]) },
      roleCatalog: ambiguousCatalog,
      groupTypeIdToKey,
    });
    expect(warnings).toEqual([]);
    expect(out).toEqual({
      oneof: [{ var: "role.id" }, [{ __ctRef: true, kind: "role-def", key: "community_leader" }]],
    });
  });

  it("keeps the (group-type, role) pair when it is unambiguous, EVEN IF the role is managed", () => {
    // The safety property: a `role-def` ref can mis-resolve to another group type's role on a host
    // that never adopted the key, and the pair cannot. Nothing is gained by trading down here, so a
    // managed role-def must not win by default.
    const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
      idToKeyByKind: { "role-def": new Map([[207, "community_leader"]]) },
      roleCatalog: uniqueCatalog,
      groupTypeIdToKey,
    });
    expect(warnings).toEqual([]);
    expect(out).toEqual({
      oneof: [
        { var: "role.id" },
        [{ __ctRef: true, kind: "group-type-role", groupType: "community", role: "leader" }],
      ],
    });
  });

  it("still emits the (group-type, role) pair when the role is NOT managed", () => {
    const { ruleset: out } = portablizeRuleset(ruleset, {
      idToKeyByKind: {},
      roleCatalog: uniqueCatalog,
      groupTypeIdToKey,
    });
    expect(out).toEqual({
      oneof: [
        { var: "role.id" },
        [{ __ctRef: true, kind: "group-type-role", groupType: "community", role: "leader" }],
      ],
    });
  });

  it("leaves an ambiguous, unmanaged role to the pair — which hard-errors at plan time, honestly", () => {
    // Nothing portable to emit: the pair cannot name it and there is no shared key yet. Emitting the
    // pair anyway is right — the resolver's ambiguity error is what tells the author to adopt it.
    const { ruleset: out } = portablizeRuleset(ruleset, {
      idToKeyByKind: {},
      roleCatalog: ambiguousCatalog,
      groupTypeIdToKey,
    });
    expect(out).toEqual({
      oneof: [
        { var: "role.id" },
        [{ __ctRef: true, kind: "group-type-role", groupType: "community", role: "leader" }],
      ],
    });
  });

  it("adopting the role under a shared key is what makes the ambiguous case resolvable", () => {
    // Two hosts, same logical key, different numeric ids — the whole point. Each host's capture
    // produces the SAME portable marker.
    const prod = portablizeRuleset(
      { oneof: [{ var: "role.id" }, [127]] },
      {
        idToKeyByKind: { "role-def": new Map([[127, "community_leader"]]) },
        roleCatalog: new Map([
          [127, { groupTypeId: 30, name: "leader" }],
          [128, { groupTypeId: 30, name: "Leader" }],
        ]),
        groupTypeIdToKey,
      },
    ).ruleset;
    const dev = portablizeRuleset(ruleset, {
      idToKeyByKind: { "role-def": new Map([[207, "community_leader"]]) },
      roleCatalog: ambiguousCatalog,
      groupTypeIdToKey,
    }).ruleset;
    expect(prod).toEqual(dev);
    expect(prod).toEqual({
      oneof: [{ var: "role.id" }, [{ __ctRef: true, kind: "role-def", key: "community_leader" }]],
    });
  });

  it("also portablizes the out-of-query handleMembership.groupTypeRoleId field", () => {
    const { ruleset: out } = portablizeRuleset(
      { process: { x: { handleMembership: { groupTypeRoleId: 207 } } } },
      {
        idToKeyByKind: { "role-def": new Map([[207, "community_leader"]]) },
        roleCatalog: ambiguousCatalog,
        groupTypeIdToKey,
      },
    );
    expect(out).toEqual({
      process: {
        x: {
          handleMembership: {
            groupTypeRoleId: { __ctRef: true, kind: "role-def", key: "community_leader" },
          },
        },
      },
    });
  });
});
