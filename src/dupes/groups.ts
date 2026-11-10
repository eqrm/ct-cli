/**
 * Groups both persons of a pair belong to. ChurchTools refuses a merge while such a group exists
 * (HTTP 403 "error.forbidden.merge-persons-having-common-groups"), so these are cleaned up first:
 *
 * - dynamic ("Auto") groups: the Duplikat is removed; the group's ruleset decides about the
 *   Original anyway.
 * - other groups: the Original's membership is kept and updated with the operator's choices (the
 *   earlier join date by default, empty values filled from the Duplikat), then the Duplikat is
 *   removed.
 *
 * Verified on a dev instance: `GET /groups/{g}/members/{p}` reads one membership, `PATCH` on it sets
 * `memberStartDate`, `comment` and `fields`, and `DELETE` removes a member from a dynamic group too.
 */
import { fetchDynamicGroupIds } from "../api/dynamicGroups.js";
import type { DupesClient, MergeGroup } from "./ct.js";
import { canon, isEmpty, type Side } from "./merge-model.js";

interface RawField {
  id: number;
  name?: string;
  value?: unknown;
}

export interface RawMembership {
  groupTypeRoleId?: number | null;
  groupMemberStatus?: string | null;
  memberStartDate?: string | null;
  memberEndDate?: string | null;
  comment?: string | null;
  fields?: RawField[];
}

export interface MemberItem {
  /** `groupTypeRoleId`, `groupMemberStatus`, `memberStartDate`, `memberEndDate`, `comment` or `field:<id>`. */
  key: string;
  label: string;
  original: unknown;
  duplicate: unknown;
  choice: Side;
}

export interface SharedGroup {
  id: number;
  title: string;
  dynamic: boolean;
  /** Empty for dynamic groups: nothing to choose, the Duplikat is just removed. */
  items: MemberItem[];
}

const BASE_ITEMS: ReadonlyArray<{ key: keyof RawMembership; label: string }> = [
  { key: "groupTypeRoleId", label: "Rolle" },
  { key: "groupMemberStatus", label: "Status" },
  { key: "memberStartDate", label: "Beitritt" },
  { key: "memberEndDate", label: "Ende" },
  { key: "comment", label: "Kommentar" },
];

/** Non-empty side wins, the Original wins a conflict; for the join date the earlier one wins. */
function itemDefault(key: string, o: unknown, d: unknown): Side {
  if (isEmpty(o)) return isEmpty(d) ? "original" : "duplicate";
  if (isEmpty(d)) return "original";
  if (key === "memberStartDate")
    return String(d).slice(0, 10) < String(o).slice(0, 10) ? "duplicate" : "original";
  return "original";
}

export function buildItems(original: RawMembership, duplicate: RawMembership): MemberItem[] {
  const items: MemberItem[] = [];
  for (const b of BASE_ITEMS) {
    const o = original[b.key] ?? null;
    const d = duplicate[b.key] ?? null;
    if (isEmpty(o) && isEmpty(d)) continue;
    items.push({ key: b.key, label: b.label, original: o, duplicate: d, choice: itemDefault(b.key, o, d) });
  }
  const fields = new Map<number, { name: string; o: unknown; d: unknown }>();
  for (const f of original.fields ?? [])
    fields.set(f.id, { name: f.name ?? `Feld ${f.id}`, o: f.value ?? null, d: null });
  for (const f of duplicate.fields ?? []) {
    const e = fields.get(f.id) ?? { name: f.name ?? `Feld ${f.id}`, o: null, d: null };
    e.d = f.value ?? null;
    fields.set(f.id, e);
  }
  for (const [id, f] of fields) {
    if (isEmpty(f.o) && isEmpty(f.d)) continue;
    items.push({
      key: `field:${id}`,
      label: f.name,
      original: f.o,
      duplicate: f.d,
      choice: itemDefault("", f.o, f.d),
    });
  }
  return items;
}

export const itemDiffers = (i: MemberItem): boolean => canon(i.original) !== canon(i.duplicate);

/** Ids of all dynamic groups (one GET; empty when the endpoint is unavailable). */
export async function loadDynamicGroupIds(client: DupesClient): Promise<Set<number>> {
  try {
    return await fetchDynamicGroupIds(client);
  } catch {
    return new Set();
  }
}

/** Both memberships for every shared group of the merge preview. */
export async function loadSharedGroups(
  client: DupesClient,
  both: readonly MergeGroup[],
  originalId: number,
  duplicateId: number,
  dynamicIds: ReadonlySet<number>,
): Promise<SharedGroup[]> {
  const out: SharedGroup[] = [];
  for (const g of both) {
    const title = g.title ?? `#${g.id}`;
    if (dynamicIds.has(g.id)) {
      out.push({ id: g.id, title, dynamic: true, items: [] });
      continue;
    }
    const [o, d] = await Promise.all([
      client.get<RawMembership>(`/groups/${g.id}/members/${originalId}`),
      client.get<RawMembership>(`/groups/${g.id}/members/${duplicateId}`),
    ]);
    out.push({ id: g.id, title, dynamic: false, items: buildItems(o, d) });
  }
  return out;
}

export function setItemChoice(
  groups: SharedGroup[],
  groupId: number,
  key: string,
  choice: Side,
): SharedGroup[] {
  return groups.map((g) =>
    g.id !== groupId ? g : { ...g, items: g.items.map((i) => (i.key === key ? { ...i, choice } : i)) },
  );
}

/** The PATCH for the Original's membership: only values taken from the Duplikat. Null when unchanged. */
export function membershipPatch(g: SharedGroup): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  for (const i of g.items) {
    if (i.choice !== "duplicate" || !itemDiffers(i)) continue;
    if (i.key.startsWith("field:")) fields[i.key.slice(6)] = i.duplicate;
    else patch[i.key] = i.duplicate;
  }
  if (Object.keys(fields).length > 0) patch.fields = fields;
  return Object.keys(patch).length > 0 ? patch : null;
}

export interface GroupStep {
  groupId: number;
  dynamic: boolean;
  /** Keys taken over from the Duplikat's membership. */
  updated: string[];
}

/**
 * Update the Original's memberships, then remove the Duplikat from every shared group. Stops at the
 * first failure and throws; `done` holds the steps that went through (for the audit).
 */
export async function prepareSharedGroups(
  client: DupesClient,
  groups: readonly SharedGroup[],
  originalId: number,
  duplicateId: number,
  done: GroupStep[],
): Promise<void> {
  for (const g of groups) {
    const patch = g.dynamic ? null : membershipPatch(g);
    if (patch) await client.request("PATCH", `/groups/${g.id}/members/${originalId}`, patch);
    await client.request("DELETE", `/groups/${g.id}/members/${duplicateId}`);
    const updated = patch
      ? g.items.filter((i) => i.choice === "duplicate" && itemDiffers(i)).map((i) => i.key)
      : [];
    done.push({ groupId: g.id, dynamic: g.dynamic, updated });
  }
}
