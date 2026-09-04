/**
 * Portable config (#20): ZERO numeric ChurchTools ids. Every id-bearing field is
 * a logical reference the per-host resolver fills in at plan time — so this exact
 * file plans and applies against any instance without edits (ids differ per host).
 *
 * References resolve from, in order: (1) resources managed by this tool (declared
 * here or already in state), (2) live master-data catalogs (group types, campuses,
 * group statuses, roles) matched by name. An unresolvable name fails the plan with a
 * clear error naming the reference and where it was used — never a silent wrong id.
 *
 * The numeric escape hatch remains available everywhere (`groupTypeId: 2`,
 * `campusId: 3`, `q.eq("ctgroup.campusId", 4)`, `id: <domainId>`) for the rare case
 * where you deliberately target one instance's id. A group's lifecycle status can
 * instead use `status: "active"`; it resolves through the nested group-status catalog
 * in `/person/masterdata` (#157).
 */
import type { ConfigContext } from "../src/config/context.js";
import { q, churchQuery, ref } from "../src/config/context.js";

export default (ct: ConfigContext): void => {
  // A campus created in this same run. Groups below link to it by key (`campus: "mainz"`);
  // its id is unknown until it is created, so the resolver marks those links pending and
  // fills in the real id at apply time (tier ordering creates the campus first).
  ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });

  // Group type + campus by name — no numeric ids. `groupType: "ministry_team"` resolves against
  // the live /group/grouptypes catalog on whichever host you apply to.
  ct.group({
    key: "mainz_kids_lead",
    name: "Mainz · Kids Leitung",
    groupType: "ministry_team",
    campus: "mainz",
    parents: [],
  });
  ct.group({
    key: "mainz_kids_team",
    name: "Mainz · Kids Team",
    groupType: "ministry_team",
    campus: "mainz",
    parents: ["mainz_kids_lead"],
  });

  // A dynamic auto-group whose ruleset filters by campus — again by reference, not id.
  ct.group({
    key: "mainz_kids_all",
    name: "Mainz · Kids (alle)",
    groupType: "ministry_team",
    campus: "mainz",
    parents: ["mainz_kids_lead"],
    dynamic: {
      status: "manual",
      ruleset: {
        description: "Alle aktiven Kids-Mitarbeiter Mainz",
        importance: 0,
        personIdFieldName: "person.id",
        process: {},
        query: churchQuery(
          q.and(q.eq("ctgroup.campusId", ref.campus("mainz")), q.eq("person.isArchived", false)),
        ),
      },
    },
  });

  // A permission template whose domain is the group type BY NAME — the resolver maps it to the
  // per-host group-type id. Scope keys reference the managed groups above.
  ct.groupTypeRole({
    key: "kids_lead_tpl",
    groupType: "ministry_team",
    grants: [{ right: "churchgroup:view group", scope: ["mainz_kids_lead"] }],
  });
};
