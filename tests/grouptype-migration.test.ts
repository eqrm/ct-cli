import { describe, expect, it } from "vitest";

import {
  deriveRoleMapping,
  memberCountsByRole,
  roleMappingPayload,
  rolesOfType,
  unmappableRolesError,
  type GroupTypeRole,
} from "../src/engine/grouptype.js";

/**
 * Real role catalogs read from a live instance (a dev instance, CT 3.137.0-RC21, 2026-09-28). Kept verbatim
 * rather than simplified: the interesting cases in #171 are exactly the shapes CT actually ships —
 * a type whose roles are a superset of the target's, and stock lowercase role keys sitting next to
 * church-named ones.
 */
const ROLES: GroupTypeRole[] = [
  // 18 "AppModule"
  { id: 60, name: "participant", groupTypeId: 18, type: "participant", isDefault: false },
  { id: 63, name: "leader", groupTypeId: 18, type: "leader", isDefault: false },
  { id: 162, name: "Teilnehmer", groupTypeId: 18, type: "participant", isDefault: true },
  { id: 165, name: "Systemdesign", groupTypeId: 18, type: "leader", isDefault: false },
  { id: 168, name: "Eigentümer", groupTypeId: 18, type: "leader", isDefault: false },
  { id: 279, name: "Read", groupTypeId: 18, type: "participant", isDefault: false },
  { id: 282, name: "Admin", groupTypeId: 18, type: "leader", isDefault: false },
  { id: 285, name: "Write", groupTypeId: 18, type: "participant", isDefault: false },
  // 21 "Local Lead"
  { id: 66, name: "participant", groupTypeId: 21, type: "participant", isDefault: false },
  { id: 69, name: "leader", groupTypeId: 21, type: "leader", isDefault: false },
  { id: 171, name: "Teilnehmer", groupTypeId: 21, type: "participant", isDefault: true },
  { id: 174, name: "Leiter", groupTypeId: 21, type: "leader", isDefault: false },
  { id: 177, name: "Organisator", groupTypeId: 21, type: "leader", isDefault: false },
  // 5 "Team"
  { id: 32, name: "participant", groupTypeId: 5, type: "participant", isDefault: false },
  { id: 35, name: "leader", groupTypeId: 5, type: "leader", isDefault: false },
  { id: 105, name: "Mitglied", groupTypeId: 5, type: "participant", isDefault: true },
  { id: 108, name: "Leiter", groupTypeId: 5, type: "leader", isDefault: false },
  { id: 111, name: "Organisator", groupTypeId: 5, type: "leader", isDefault: false },
  { id: 201, name: "Supporter", groupTypeId: 5, type: "participant", isDefault: false },
  // 4 "Merkmal"
  { id: 29, name: "Teilnehmer", groupTypeId: 4, type: "participant", isDefault: false },
  { id: 30, name: "Leiter", groupTypeId: 4, type: "leader", isDefault: false },
  { id: 114, name: "Mitglied", groupTypeId: 4, type: "participant", isDefault: true },
  { id: 117, name: "Eigentümer", groupTypeId: 4, type: "leader", isDefault: false },
  { id: 150, name: "Organisator", groupTypeId: 4, type: "leader", isDefault: false },
];

const derive = (from: number, to: number, counts: Map<number, number>, declared?: Record<string, string>) =>
  deriveRoleMapping({
    sourceRoles: rolesOfType(ROLES, from),
    targetRoles: rolesOfType(ROLES, to),
    memberCounts: counts,
    ...(declared ? { declared } : {}),
  });

describe("rolesOfType", () => {
  it("selects only the requested type's roles", () => {
    expect(rolesOfType(ROLES, 21).map((r) => r.id)).toEqual([66, 69, 171, 174, 177]);
  });
});

describe("memberCountsByRole", () => {
  it("counts members per role and ignores rows without a role", () => {
    const counts = memberCountsByRole([
      { groupTypeRoleId: 171 },
      { groupTypeRoleId: 171 },
      { groupTypeRoleId: 174 },
      {},
    ]);
    expect(counts.get(171)).toBe(2);
    expect(counts.get(174)).toBe(1);
    expect(counts.size).toBe(2);
  });
});

describe("deriveRoleMapping — Team -> Merkmal, no members", () => {
  it("maps same-named roles by name and routes the rest to the default, since nothing can move", () => {
    const result = derive(5, 4, new Map());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = Object.fromEntries(result.entries.map((e) => [e.fromName, e]));
    expect(byName.Mitglied).toMatchObject({ toId: 114, toName: "Mitglied", reason: "name" });
    expect(byName.Leiter).toMatchObject({ toId: 30, toName: "Leiter", reason: "name" });
    expect(byName.Organisator).toMatchObject({ toId: 150, toName: "Organisator", reason: "name" });

    // No "Supporter"/"participant"/"leader" in Merkmal — but every one of them is empty, so the
    // migration is still risk-free and must not be refused.
    expect(byName.Supporter).toMatchObject({ toId: 114, reason: "empty-role", members: 0 });
    expect(byName.participant).toMatchObject({ toId: 114, reason: "empty-role" });
    expect(byName.leader).toMatchObject({ toId: 114, reason: "empty-role" });
  });

  it("produces a payload keyed by the CURRENT type's role ids", () => {
    const result = derive(5, 4, new Map());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(roleMappingPayload({ fromGroupTypeId: 5, toGroupTypeId: 4, entries: result.entries })).toEqual({
      "32": 114,
      "35": 114,
      "105": 114,
      "108": 30,
      "111": 150,
      "201": 114,
    });
  });
});

describe("deriveRoleMapping — refuses to guess where a membership would move", () => {
  it("blocks an occupied role that has no same-named target", () => {
    // "Supporter" holds two people and Merkmal has no Supporter: where they land is a decision.
    const result = derive(5, 4, new Map([[201, 2]]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmappable).toHaveLength(1);
    expect(result.unmappable[0]).toMatchObject({ id: 201, name: "Supporter", members: 2 });
    expect(result.unmappable[0]!.candidates).toContain("Mitglied");
  });

  it("still maps the empty roles when a different role blocks", () => {
    const result = derive(5, 4, new Map([[201, 1]]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Only the occupied, unmatched role blocks — the report stays narrow and actionable.
    expect(result.unmappable.map((r) => r.name)).toEqual(["Supporter"]);
  });

  it("an occupied role WITH a same-named target is fine", () => {
    const result = derive(5, 4, new Map([[105, 9]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.find((e) => e.fromId === 105)).toMatchObject({
      toId: 114,
      reason: "name",
      members: 9,
    });
  });
});

describe("deriveRoleMapping — declared mappings", () => {
  it("unblocks an occupied role and wins over a name match", () => {
    const result = derive(
      5,
      4,
      new Map([
        [201, 2],
        [105, 1],
      ]),
      {
        Supporter: "Teilnehmer",
        Mitglied: "Eigentümer",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.find((e) => e.fromId === 201)).toMatchObject({
      toId: 29,
      toName: "Teilnehmer",
      reason: "declared",
    });
    // Declared beats the same-named target: Mitglied -> Eigentümer, not Mitglied -> Mitglied.
    expect(result.entries.find((e) => e.fromId === 105)).toMatchObject({
      toId: 117,
      toName: "Eigentümer",
      reason: "declared",
    });
  });

  it("is slug-compared, so case and spacing do not have to match CT exactly", () => {
    const result = derive(5, 4, new Map([[201, 2]]), { supporter: "teilnehmer" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.find((e) => e.fromId === 201)).toMatchObject({ toId: 29, reason: "declared" });
  });

  it("treats a declared target that does not exist as a blocker, not a fallback", () => {
    const result = derive(5, 4, new Map([[201, 2]]), { Supporter: "Nonexistent" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmappable.map((r) => r.name)).toEqual(["Supporter"]);
  });
});

describe("deriveRoleMapping — ambiguity", () => {
  const duplicated: GroupTypeRole[] = [
    { id: 1, name: "Leiter", groupTypeId: 99, type: "leader", isDefault: false },
    { id: 2, name: "Leiter", groupTypeId: 99, type: "leader", isDefault: false },
    { id: 3, name: "Mitglied", groupTypeId: 99, type: "participant", isDefault: true },
  ];

  it("refuses a name match when the target type carries that name twice", () => {
    const result = deriveRoleMapping({
      sourceRoles: [{ id: 108, name: "Leiter", groupTypeId: 5, type: "leader" }],
      targetRoles: duplicated,
      memberCounts: new Map([[108, 3]]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmappable[0]).toMatchObject({ name: "Leiter", members: 3 });
  });
});

describe("deriveRoleMapping — the migration this was verified against", () => {
  it("reverses the live Local Lead -> AppModule migration onto the ruleset's own role", () => {
    // amCheckin (#1817) after the UI moved it 18 -> 21: three members sat in 171, and
    // rulesets/amcheckin.json assigns appmodule/"Read" (279). Name matching handles the rest.
    const result = derive(21, 18, new Map([[171, 3]]), { Teilnehmer: "Read" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(roleMappingPayload({ fromGroupTypeId: 21, toGroupTypeId: 18, entries: result.entries })).toEqual({
      "66": 60,
      "69": 63,
      "171": 279,
      "174": 162,
      "177": 162,
    });
  });
});

describe("unmappableRolesError", () => {
  it("names the role, its member count and the target type's roles", () => {
    const message = unmappableRolesError("youth_team", 5, 4, [
      { id: 201, name: "Supporter", members: 2, candidates: ["Mitglied", "Leiter"] },
    ]).message;
    expect(message).toContain("youth_team");
    expect(message).toContain("groupTypeId 5 -> 4");
    expect(message).toContain('"Supporter" (role 201, 2 member(s))');
    expect(message).toContain("POST /groups/{id}/grouptype");
    expect(message).toContain("roleMapping");
    expect(message).toContain("Mitglied, Leiter");
  });
});
