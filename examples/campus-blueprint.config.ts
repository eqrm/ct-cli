/**
 * Parametrized campus blueprint: define the Kids area once, instantiate per campus.
 * Demonstrates that the config DSL needs no special "blueprint" machinery — a
 * blueprint is a plain function over the injected context, called in a loop.
 */
import type { ConfigContext } from "../src/config/context.js";
import { q, churchQuery } from "../src/config/context.js";

const CAMPUSES = ["mainz", "berlin"] as const;

/**
 * One campus's Kids area: a lead group with three ministry teams under it, plus a dynamic "all members" group.
 *
 * Portable references (#20): the group type is named (`groupType: "ministry_team"`) rather than a
 * hardcoded numeric id — the per-host resolver maps it to that instance's group-type id at plan time.
 * Campus assignment (#21) uses the SAME logical form: `campus: campus` links each group to a campus
 * created in this very apply. Its id is unknowable at eval time, so the resolver marks it pending and
 * fills in the freshly-created id at apply time. The numeric escape hatch still works everywhere:
 * pass `groupTypeId: 2` / `campusId: 3` to target an existing id directly.
 */
function kidsArea(ct: ConfigContext, campus: string): void {
  const lead = `${campus}_kids_lead`;
  ct.group({ key: lead, name: `${campus} · Kids Leitung`, groupType: "ministry_team", campus, parents: [] });
  for (const [suffix, label] of [
    ["0_3", "0–3"],
    ["4_6", "4–6"],
    ["checkin", "Check-in"],
  ] as const) {
    ct.group({
      key: `${campus}_kids_${suffix}`,
      name: `${campus} · Kids ${label}`,
      groupType: "ministry_team",
      campus,
      parents: [lead], // managed hierarchy: team sits under the campus lead group
    });
  }
  // A dynamic auto-group (#14) composed inside the blueprint.
  ct.group({
    key: `${campus}_kids_all`,
    name: `${campus} · Kids (alle)`,
    groupType: "ministry_team",
    campus,
    parents: [lead],
    dynamic: {
      status: "manual",
      ruleset: {
        description: `Alle aktiven Kids-Mitarbeiter ${campus}`,
        importance: 0,
        personIdFieldName: "person.id",
        process: {},
        query: churchQuery(q.eq("person.isArchived", false)),
      },
    },
  });
}

export default (ct: ConfigContext): void => {
  for (const campus of CAMPUSES) {
    ct.campus({ key: campus, name: `Campus ${campus}`, shorty: campus.slice(0, 3).toUpperCase() });
    kidsArea(ct, campus);
  }
  // A permission grant (#13) on a shared group-type-role template. The domain is declared by name
  // (`groupType: "ministry_team"`) — no hardcoded numeric domainId. Both rights are scoped (they
  // carry a `scopeField` in the catalog), so they must be declared as `{ right, scope: [...] }` —
  // a bare string would grant them globally and is rejected.
  const kidsLeads = CAMPUSES.map((c) => `${c}_kids_lead`);
  ct.groupTypeRole({
    key: "kids_lead_tpl",
    groupType: "ministry_team",
    role: "Leiter",
    grants: [
      { right: "churchgroup:view group", scope: kidsLeads },
      { right: "churchgroup:edit group memberships of group", scope: kidsLeads },
    ],
  });
};
