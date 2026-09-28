/**
 * Changing a managed group's `groupTypeId` is a MIGRATION, not a field update (#171).
 *
 * ChurchTools refuses the field on the ordinary group update — `PATCH /groups/{id}` answers
 * `HTTP 400 groupTypeId: validation.always.invalid` ("Das Feld ist nicht erlaubt") — and exposes a
 * dedicated endpoint instead:
 *
 *     POST /groups/{id}/grouptype   { "groupTypeId": <new>, "roleMapping": { <oldRoleId>: <newRoleId> } }
 *
 * Verified live against CT 3.137.0-RC21 on 2026-09-28 by migrating a group and migrating it back:
 * both keys and values of `roleMapping` are **`groupTypeRoleId`s** (the type-level role ids from
 * `/group/roles`), keyed by the roles of the group's CURRENT type. The endpoint answers `204` with an
 * empty body. The UI asks a human to fill that mapping in, because it decides where every existing
 * MEMBERSHIP lands: a member holding a role that maps to X holds X afterwards.
 *
 * That is why this module refuses to guess. The mapping is derived only where the answer cannot
 * cost anyone their role:
 *
 *   1. `declared`   — an explicit `roleMapping` in config always wins.
 *   2. `name`       — exactly one role of the target type carries the same name (slug-compared).
 *   3. `empty-role` — the old role holds NO members in this group, so no membership can move.
 *                     It still needs a target (the payload is keyed by every current-type role), and
 *                     the target type's default role is used.
 *
 * Anything else — a role that HOLDS MEMBERS and has no same-named target — is returned as
 * {@link UnmappableRole} so the caller can refuse at PLAN time, before a single write. That is the
 * honest-plan rule: a plan that cannot be applied must not render as applicable.
 */

import { slug } from "../resources/registry.js";
import type { Plan } from "./types.js";

/** A `/group/roles` row, reduced to what a migration needs. */
export interface GroupTypeRole {
  id: number;
  name: string;
  groupTypeId: number;
  /** CT's `leader` | `participant` discriminator. Used only to pick a sane default target. */
  type?: string;
  isDefault?: boolean;
}

/** Why a role's target was chosen — rendered in the plan so the operator can see the reasoning. */
export type RoleMappingReason = "declared" | "name" | "empty-role";

export interface RoleMappingEntry {
  fromId: number;
  fromName: string;
  toId: number;
  toName: string;
  reason: RoleMappingReason;
  /** Members of this group holding the old role. `empty-role` is only ever chosen when this is 0. */
  members: number;
}

/** A role holding members that cannot be mapped without guessing. Blocks the plan. */
export interface UnmappableRole {
  id: number;
  name: string;
  members: number;
  /** Role names of the target type, offered in the error so the operator can declare one. */
  candidates: string[];
}

export interface GroupTypeMigration {
  fromGroupTypeId: number;
  toGroupTypeId: number;
  entries: RoleMappingEntry[];
}

export interface DeriveRoleMappingInput {
  /** Roles of the group's CURRENT type — the payload is keyed by these. */
  sourceRoles: GroupTypeRole[];
  /** Roles of the type the group is moving TO. */
  targetRoles: GroupTypeRole[];
  /** Members per `groupTypeRoleId` in this group. A role absent from the map holds none. */
  memberCounts: ReadonlyMap<number, number>;
  /** Config's explicit mapping, old role NAME → new role NAME (slug-compared). */
  declared?: Readonly<Record<string, string>>;
}

export type DeriveRoleMappingResult =
  { ok: true; entries: RoleMappingEntry[] } | { ok: false; unmappable: UnmappableRole[] };

/** The role a membership lands in when its old role holds nobody: the target type's default. */
function defaultTargetRole(targetRoles: GroupTypeRole[], like?: string): GroupTypeRole | undefined {
  return (
    targetRoles.find((r) => r.isDefault === true) ??
    // No flagged default (CT allows that): keep the leader/participant character rather than
    // silently promoting a participant into a leader role.
    targetRoles.find((r) => like !== undefined && r.type === like) ??
    targetRoles[0]
  );
}

/**
 * Build the `roleMapping` for a group-type migration, or report every role that would need a guess.
 *
 * Deterministic and side-effect free: the same inputs always produce the same mapping, which is what
 * lets `plan` render it and `apply` send exactly what was rendered.
 */
export function deriveRoleMapping(input: DeriveRoleMappingInput): DeriveRoleMappingResult {
  const { sourceRoles, targetRoles, memberCounts } = input;
  const declared = input.declared ?? {};

  // Target lookups. A name is only a usable key when exactly ONE target role carries it — CT does not
  // forbid duplicates, and "one of the two Leiter roles" is precisely the guess this must not make.
  const targetsBySlug = new Map<string, GroupTypeRole[]>();
  for (const role of targetRoles) {
    const key = slug(role.name);
    const bucket = targetsBySlug.get(key);
    if (bucket) bucket.push(role);
    else targetsBySlug.set(key, [role]);
  }
  const uniqueTarget = (name: string): GroupTypeRole | undefined => {
    const bucket = targetsBySlug.get(slug(name));
    return bucket !== undefined && bucket.length === 1 ? bucket[0] : undefined;
  };

  const declaredBySlug = new Map<string, string>();
  for (const [from, to] of Object.entries(declared)) {
    declaredBySlug.set(slug(from), to);
  }

  const entries: RoleMappingEntry[] = [];
  const unmappable: UnmappableRole[] = [];
  const candidates = targetRoles.map((r) => r.name);

  for (const source of sourceRoles) {
    const members = memberCounts.get(source.id) ?? 0;

    const declaredTargetName = declaredBySlug.get(slug(source.name));
    if (declaredTargetName !== undefined) {
      const target = uniqueTarget(declaredTargetName);
      if (!target) {
        // A declared mapping that does not land is a config error, not a guess to be papered over.
        unmappable.push({ id: source.id, name: source.name, members, candidates });
        continue;
      }
      entries.push({
        fromId: source.id,
        fromName: source.name,
        toId: target.id,
        toName: target.name,
        reason: "declared",
        members,
      });
      continue;
    }

    const byName = uniqueTarget(source.name);
    if (byName) {
      entries.push({
        fromId: source.id,
        fromName: source.name,
        toId: byName.id,
        toName: byName.name,
        reason: "name",
        members,
      });
      continue;
    }

    if (members === 0) {
      const fallback = defaultTargetRole(targetRoles, source.type);
      if (fallback) {
        entries.push({
          fromId: source.id,
          fromName: source.name,
          toId: fallback.id,
          toName: fallback.name,
          reason: "empty-role",
          members,
        });
        continue;
      }
    }

    unmappable.push({ id: source.id, name: source.name, members, candidates });
  }

  return unmappable.length > 0 ? { ok: false, unmappable } : { ok: true, entries };
}

/** The wire payload for `POST /groups/{id}/grouptype`. */
export function roleMappingPayload(migration: GroupTypeMigration): Record<string, number> {
  const mapping: Record<string, number> = {};
  for (const entry of migration.entries) {
    mapping[String(entry.fromId)] = entry.toId;
  }
  return mapping;
}

/** Roles of one group type, in the order `/group/roles` returned them. */
export function rolesOfType(roles: GroupTypeRole[], groupTypeId: number): GroupTypeRole[] {
  return roles.filter((r) => r.groupTypeId === groupTypeId);
}

/** Members per `groupTypeRoleId` from a `GET /groups/{id}/members` page. */
export function memberCountsByRole(members: { groupTypeRoleId?: number }[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const member of members) {
    const roleId = member.groupTypeRoleId;
    if (typeof roleId === "number") {
      counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Resolve the migration for every group update whose `groupTypeId` changes, so the plan renders the
 * same mapping the apply will send.
 *
 * Costs nothing on the common path: with no type change it issues no request at all. When there is
 * one it reads `/group/roles` once plus one members page per migrating group — and that members read
 * is what makes an empty role safe to map automatically, so it is not optional.
 *
 * Throws {@link unmappableRolesError} when a mapping cannot be derived without guessing. Deliberate:
 * the alternative is rendering an applicable-looking plan that CT rejects mid-apply (#171).
 */
export async function resolveGroupTypeMigrations(
  client: { get<T = unknown>(path: string): Promise<T> },
  plan: Plan,
  declaredByKey: ReadonlyMap<string, Record<string, string> | undefined>,
): Promise<void> {
  const migrating = plan.items.filter(
    (item) =>
      item.type === "group" &&
      item.action === "update" &&
      item.id !== null &&
      item.changes.some((c) => c.field === "groupTypeId"),
  );
  if (migrating.length === 0) return;

  const roles = await client.get<GroupTypeRole[]>("/group/roles");
  const catalog = Array.isArray(roles) ? roles : [];

  for (const item of migrating) {
    const change = item.changes.find((c) => c.field === "groupTypeId")!;
    const fromGroupTypeId = Number(change.from);
    const toGroupTypeId = Number(change.to);
    if (!Number.isFinite(fromGroupTypeId) || !Number.isFinite(toGroupTypeId)) continue;

    const members = await client.get<{ groupTypeRoleId?: number }[]>(`/groups/${item.id}/members?limit=200`);
    const declared = declaredByKey.get(item.key);
    const result = deriveRoleMapping({
      sourceRoles: rolesOfType(catalog, fromGroupTypeId),
      targetRoles: rolesOfType(catalog, toGroupTypeId),
      memberCounts: memberCountsByRole(Array.isArray(members) ? members : []),
      ...(declared ? { declared } : {}),
    });
    if (!result.ok) {
      throw unmappableRolesError(item.key, fromGroupTypeId, toGroupTypeId, result.unmappable);
    }
    item.groupTypeMigration = { fromGroupTypeId, toGroupTypeId, entries: result.entries };
  }
}

/**
 * The plan-time refusal (#171). Names every blocking role with its member count and the target
 * type's role names, so the fix — a declared `roleMapping` — can be written without another round
 * trip to the API.
 */
export function unmappableRolesError(
  groupKey: string,
  fromGroupTypeId: number,
  toGroupTypeId: number,
  unmappable: UnmappableRole[],
): Error {
  const lines = unmappable.map(
    (role) =>
      `    - "${role.name}" (role ${role.id}, ${role.members} member(s)) has no same-named role in group type ${toGroupTypeId}`,
  );
  return new Error(
    `group "${groupKey}": cannot change groupTypeId ${fromGroupTypeId} -> ${toGroupTypeId} without a role mapping.\n` +
      `  ChurchTools migrates a group's type through POST /groups/{id}/grouptype, which maps every role of the\n` +
      `  current type onto a role of the new one — that mapping decides where existing MEMBERSHIPS land, so ct\n` +
      `  will not guess it:\n` +
      lines.join("\n") +
      `\n  Declare the mapping on the group (old role name -> new role name), e.g.\n` +
      `      roleMapping: { ${unmappable.map((r) => `"${r.name}": "<target>"`).join(", ")} }\n` +
      `  Target type ${toGroupTypeId} offers: ${unmappable[0]?.candidates.join(", ") ?? "(no roles)"}.`,
  );
}
