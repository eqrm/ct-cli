/**
 * Coverage: what this host has that the config does not manage, and what could be managed (#103).
 *
 * Every consumer repo was reinventing this audit by hand — joining `/groups?include[]=roles`,
 * `/dynamicgroups` and `/permissions/group_role`, then diffing the lot against the state file. Two
 * things make it worth owning here rather than leaving to each repo:
 *
 *  - `?include[]=roles` is a non-obvious trick that turns one role lookup per group into a handful of
 *    paged calls, and nobody finds it without digging;
 *  - getting it wrong is easy and QUIET. Forgetting the `isInherited` filter inflates the authored
 *    grant count (714 vs 590 on eqrm prod) and makes several role instances look unmanageable that
 *    are not.
 *
 * The DECLARABILITY verdict is the valuable half, and `ct` is the only thing that can compute it: it
 * needs to know which scope dimensions have a logical reference form (#98), which are numeric but
 * host-independent, and which are module data with no resource behind them at all.
 *
 * This module is pure — it takes already-fetched rows and returns a report. The command wrapper does
 * the I/O, so the whole verdict is unit-testable without a network.
 */
import { KNOWN_AUTH_IDS, SCOPE_FIELD_BY_AUTH_ID } from "../permissions/catalog.js";
import { normalizeActual, normalizeEffective, type RawPermission } from "../permissions/grants.js";
import { ALL_SCOPE_SENTINEL, SCOPE_REF_KIND } from "../permissions/scope.js";
import { fromInformation } from "../resources/registry.js";
import type { State } from "../state/state.js";

// `cc_securitylevel` used to be listed here as "numeric-universal" — a dimension whose ids mean the
// same thing on every instance, so a numeric literal counted as declarable. #110 retired that idea:
// security levels are admin-editable master-data rows with an auto-increment id, so the alignment held
// by convention, not by construction. They now have a real reference form (`{ securityLevel: "…" }`,
// resolved through `GET /securitylevels`), so `SCOPE_REF_KIND` covers them like any other dimension
// and no universality exemption is needed.

/** A live (group, role) permission domain — the granularity declarability is decided at. */
export interface RoleInstance {
  /** `groups[].roles[].id` — the `group_role` domainId a `ct.groupRole` declaration targets. */
  domainId: number;
  groupId: number;
  groupName: string;
  groupTypeId: number;
  roleName: string;
}

export interface GroupRow {
  id: number;
  name: string;
  groupTypeId: number;
  roles: RoleInstance[];
}

/** Why a role instance's grants cannot all be expressed as config today. */
export interface DeclarabilityVerdict {
  declarable: boolean;
  /** Authored, non-inherited grants on this domain. */
  grantCount: number;
  /** Scope dimensions with no declarable form — the reason it is blocked, named. */
  blockedBy: string[];
  /** Live authIds the permission catalog cannot name (a stale catalog, or a foreign right). */
  unknownAuthIds: number[];
}

export interface RoleInstanceCoverage extends RoleInstance {
  managedGroupKey: string | null;
  /** The key the OpenTofu id map knows this group by (#202): owned elsewhere, so neither managed nor "unmanaged". */
  ownedElsewhereKey?: string;
  verdict: DeclarabilityVerdict;
}

export interface TypeCoverage {
  groupTypeId: number;
  name: string;
  total: number;
  managed: number;
  dynamic: number;
  /** Unmanaged groups that nevertheless carry authored grants — the real "you are missing this" number. */
  unmanagedWithGrants: number;
  /** Groups the OpenTofu id map owns (#202); left out of `unmanagedWithGrants`. Present only when non-zero. */
  ownedElsewhere?: number;
}

export interface CoverageReport {
  host: string;
  groups: {
    total: number;
    managed: number;
    dynamic: number;
    managedDynamic: number;
    /** Groups in the OpenTofu id map that ct's state does not hold (#202). Present only when non-zero. */
    ownedElsewhere?: number;
  };
  grants: {
    authored: number;
    roleInstances: number;
    declarable: number;
    blocked: number;
    blockingDimensions: string[];
  };
  byType: TypeCoverage[];
  roleInstances: RoleInstanceCoverage[];
}

export interface CoverageInput {
  host: string;
  state: State;
  groups: GroupRow[];
  /** Group type id → display name, from `/group/grouptypes`. */
  groupTypeNames: Map<number, string>;
  /** Ids from `/dynamicgroups` — which groups are auto-groups on this host. */
  dynamicGroupIds: Set<number>;
  /** Every row of `/permissions/group_role`, unfiltered (inherited rows are dropped here). */
  groupRolePermissions: RawPermission[];
  /** Group id → key for groups the OpenTofu id map owns (#202). Optional: no map, no such groups. */
  idMapGroupKeys?: ReadonlyMap<number, string>;
}

/**
 * Decide whether a role instance's live grants could be declared as config today, and if not, which
 * scope dimensions block it.
 *
 * A grant is declarable when its right is nameable AND its scope can be written portably:
 *  - unscoped rights always are;
 *  - the `-1` ALL sentinel always is (CT reads it back verbatim on every dimension);
 *  - a dimension with a logical reference form is (#98: group, campus, group type, department;
 *    #110 added security levels).
 * Everything else — calendar categories, HTML templates, wiki categories, OAuth clients — names
 * module data this tool has no resource for, so it blocks the whole instance under the strict
 * ownership default. (With `preserveUnknown` (#102) those same instances become declarable while
 * leaving the module grants alone; the verdict below is the strict one, and the command surfaces the
 * blocking dimensions precisely so they can be passed to `preserveUnknown`.)
 *
 * `scope` picks WHICH rows the verdict is about, and the two callers genuinely need different ones:
 *  - `"authored"` (default) — `ct coverage`, whose headline number is "grants an admin authored here".
 *    Inherited rows are somebody else's authorship and would inflate it.
 *  - `"effective"` — `ct adopt grants`, which since #114/#119 EMITS the effective set. The verdict has
 *    to be about the same rows the emitter will print, or it decides on rows that never reach the
 *    block: a domain carrying rights only as inherited rows counts as empty and is skipped (so the
 *    rights stay undeclared and the next apply on the other host revokes them), and an inherited grant
 *    on an unnameable dimension is invisible to the `blockedBy` gate that exists to stop exactly that
 *    line from being emitted as a host-specific number.
 */
export function declarability(
  rows: RawPermission[],
  { scope = "authored" }: { scope?: "authored" | "effective" } = {},
): DeclarabilityVerdict {
  // Both normalizers drop the self-re-adding system baseline; they differ only on inherited rows,
  // which `normalizeActual` also drops. Neither decides ownership — that stays `normalizeActual`'s
  // job at plan time, so widening the verdict here never widens what ct writes or revokes.
  const normalize = scope === "effective" ? normalizeEffective : normalizeActual;
  const tuples = normalize(rows).filter((t) => t.type === "grant");
  const blockedBy = new Set<string>();
  const unknownAuthIds = new Set<number>();
  for (const t of tuples) {
    if (!KNOWN_AUTH_IDS.has(t.authId)) {
      unknownAuthIds.add(t.authId);
      continue;
    }
    const scopeField = SCOPE_FIELD_BY_AUTH_ID.get(t.authId) ?? null;
    if (scopeField === null) continue;
    if (t.dataId.every((id) => id === ALL_SCOPE_SENTINEL)) continue;
    if (SCOPE_REF_KIND[scopeField] !== undefined) continue;
    blockedBy.add(scopeField);
  }
  return {
    declarable: blockedBy.size === 0 && unknownAuthIds.size === 0,
    grantCount: tuples.length,
    blockedBy: [...blockedBy].sort(),
    unknownAuthIds: [...unknownAuthIds].sort((a, b) => a - b),
  };
}

/** Build the whole report from already-fetched rows. Pure: no client, no state mutation. */
export function buildCoverageReport(input: CoverageInput): CoverageReport {
  const { host, state, groups, groupTypeNames, dynamicGroupIds, groupRolePermissions } = input;

  // group id → managed logical key, and the same for role-instance domainIds.
  const managedGroupKeyById = new Map<number, string>();
  for (const r of Object.values(state.resources)) {
    if (r.type === "group") managedGroupKeyById.set(r.id, r.key);
  }

  // A group the id map owns and ct's state does not (#202) is "owned elsewhere", not "unmanaged".
  const ownedElsewhereKeyById = new Map<number, string>();
  for (const [id, key] of input.idMapGroupKeys ?? []) {
    if (!managedGroupKeyById.has(id)) ownedElsewhereKeyById.set(id, key);
  }

  const rowsByDomainId = new Map<number, RawPermission[]>();
  for (const row of groupRolePermissions) {
    const list = rowsByDomainId.get(row.domainId);
    if (list) list.push(row);
    else rowsByDomainId.set(row.domainId, [row]);
  }

  const roleInstances: RoleInstanceCoverage[] = [];
  // Declarability is per (group, role), NOT per group: on a real instance one group routinely has two
  // declarable roles and one blocked one, and reporting at group granularity hides exactly that.
  for (const group of groups) {
    for (const role of group.roles) {
      const rows = rowsByDomainId.get(role.domainId) ?? [];
      const verdict = declarability(rows);
      if (verdict.grantCount === 0) continue; // no authored grants → nothing to declare, nothing to report
      roleInstances.push({
        ...role,
        managedGroupKey: managedGroupKeyById.get(group.id) ?? null,
        ...(ownedElsewhereKeyById.has(group.id)
          ? { ownedElsewhereKey: ownedElsewhereKeyById.get(group.id)! }
          : {}),
        verdict,
      });
    }
  }

  const groupsWithGrants = new Set(roleInstances.map((r) => r.groupId));
  const byType = new Map<number, TypeCoverage>();
  for (const group of groups) {
    let t = byType.get(group.groupTypeId);
    if (!t) {
      t = {
        groupTypeId: group.groupTypeId,
        name: groupTypeNames.get(group.groupTypeId) ?? `#${group.groupTypeId}`,
        total: 0,
        managed: 0,
        dynamic: 0,
        unmanagedWithGrants: 0,
      };
      byType.set(group.groupTypeId, t);
    }
    t.total += 1;
    const managed = managedGroupKeyById.has(group.id);
    if (managed) t.managed += 1;
    if (dynamicGroupIds.has(group.id)) t.dynamic += 1;
    // ownedElsewhereKeyById already excludes managed ids, so the two branches are disjoint.
    if (ownedElsewhereKeyById.has(group.id)) t.ownedElsewhere = (t.ownedElsewhere ?? 0) + 1;
    else if (!managed && groupsWithGrants.has(group.id)) t.unmanagedWithGrants += 1;
  }

  const ownedElsewhere = groups.filter((g) => ownedElsewhereKeyById.has(g.id)).length;
  const blockingDimensions = new Set<string>();
  for (const r of roleInstances) for (const d of r.verdict.blockedBy) blockingDimensions.add(d);

  return {
    host,
    groups: {
      total: groups.length,
      managed: groups.filter((g) => managedGroupKeyById.has(g.id)).length,
      dynamic: groups.filter((g) => dynamicGroupIds.has(g.id)).length,
      managedDynamic: groups.filter((g) => dynamicGroupIds.has(g.id) && managedGroupKeyById.has(g.id)).length,
      ...(ownedElsewhere > 0 ? { ownedElsewhere } : {}),
    },
    grants: {
      authored: roleInstances.reduce((n, r) => n + r.verdict.grantCount, 0),
      roleInstances: roleInstances.length,
      declarable: roleInstances.filter((r) => r.verdict.declarable).length,
      blocked: roleInstances.filter((r) => !r.verdict.declarable).length,
      blockingDimensions: [...blockingDimensions].sort(),
    },
    byType: [...byType.values()].sort((a, b) => a.name.localeCompare(b.name)),
    roleInstances: roleInstances.sort(
      (a, b) => a.groupName.localeCompare(b.groupName) || a.roleName.localeCompare(b.roleName),
    ),
  };
}

/**
 * Decode `/groups?include[]=roles` rows into the shape the report wants. Defensive about the role
 * row's own field names: the domainId is `roles[].id`, but the role NAME is only sometimes carried
 * inline — when it is not, `groupTypeRoleId` is joined against the `/group/roles` catalog. A role
 * whose name cannot be recovered either way still counts (it has a domainId and grants); it is just
 * labelled by its id, rather than being dropped from the audit.
 */
export function decodeGroupsWithRoles(
  rows: Array<Record<string, unknown>>,
  roleNamesById: Map<number, string>,
): GroupRow[] {
  const out: GroupRow[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    const groupTypeId = Number(fromInformation(row, "groupTypeId"));
    const rawRoles = Array.isArray(row.roles) ? (row.roles as Array<Record<string, unknown>>) : [];
    const roles: RoleInstance[] = [];
    for (const r of rawRoles) {
      const domainId = Number(r?.id);
      if (!Number.isFinite(domainId)) continue;
      const groupTypeRoleId = Number(r?.groupTypeRoleId);
      const inlineName = typeof r?.name === "string" && r.name.length > 0 ? r.name : undefined;
      const roleName =
        inlineName ??
        (Number.isFinite(groupTypeRoleId) ? roleNamesById.get(groupTypeRoleId) : undefined) ??
        `role #${domainId}`;
      roles.push({
        domainId,
        groupId: id,
        groupName: typeof row.name === "string" ? row.name : `#${id}`,
        groupTypeId: Number.isFinite(groupTypeId) ? groupTypeId : -1,
        roleName,
      });
    }
    out.push({
      id,
      name: typeof row.name === "string" ? row.name : `#${id}`,
      groupTypeId: Number.isFinite(groupTypeId) ? groupTypeId : -1,
      roles,
    });
  }
  return out;
}

/** Render the report the way the issue sketched it: totals, a per-type table, then the verdict. */
export function renderCoverage(report: CoverageReport): string {
  const lines: string[] = [];
  const g = report.groups;
  lines.push(
    `${g.total} groups · ${g.managed} managed${g.ownedElsewhere ? ` · ${g.ownedElsewhere} owned elsewhere (id map)` : ""} · ${report.grants.authored} authored grants over ` +
      `${report.grants.roleInstances} role instances`,
  );
  lines.push("");
  const nameWidth = Math.max(12, ...report.byType.map((t) => t.name.length));
  // The "elsewhere" column appears only when the id map owns any group (#202), so a host without
  // OpenTofu keeps the table it always had.
  const elsewhere = g.ownedElsewhere !== undefined;
  lines.push(
    `${"by type".padEnd(nameWidth)}  ${"total".padStart(5)}  ${"managed".padStart(7)}  ` +
      `${"dynamic".padStart(7)}  unmanaged+grants${elsewhere ? "  elsewhere" : ""}`,
  );
  for (const t of report.byType) {
    lines.push(
      `  ${t.name.padEnd(nameWidth - 2)}  ${String(t.total).padStart(5)}  ${String(t.managed).padStart(7)}  ` +
        `${String(t.dynamic).padStart(7)}  ${String(t.unmanagedWithGrants).padStart(16)}` +
        (elsewhere ? `  ${String(t.ownedElsewhere ?? 0).padStart(9)}` : ""),
    );
  }
  lines.push("");
  lines.push(
    `grants: ${report.grants.declarable} role instance(s) declarable · ${report.grants.blocked} blocked`,
  );
  if (report.grants.blockingDimensions.length > 0) {
    lines.push(`  blocked by: ${report.grants.blockingDimensions.join(", ")}`);
    lines.push(
      `  (a blocked instance becomes declarable with \`preserveUnknown: [<dimension>, …]\` — see #102)`,
    );
  }
  return lines.join("\n");
}

/** The per-role-instance detail lines, printed under `--verbose`/`--declarable`. */
export function renderRoleInstances(instances: readonly RoleInstanceCoverage[]): string {
  return instances
    .map((r) => {
      const managed = r.managedGroupKey
        ? `managed as "${r.managedGroupKey}"`
        : r.ownedElsewhereKey
          ? `owned elsewhere (id map) as "${r.ownedElsewhereKey}"`
          : "unmanaged";
      const verdict = r.verdict.declarable
        ? "declarable"
        : `blocked by ${[...r.verdict.blockedBy, ...r.verdict.unknownAuthIds.map((a) => `authId ${a}`)].join(", ")}`;
      return `  ${r.groupName} / ${r.roleName} (domainId ${r.domainId}, ${r.verdict.grantCount} grant(s), ${managed}): ${verdict}`;
    })
    .join("\n");
}
