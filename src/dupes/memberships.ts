/**
 * Group-membership comparison for a merge (pure). ChurchTools' own merge carries no membership
 * attributes, so for a group both persons belong to we decide per member field which value the
 * surviving membership keeps.
 */

export interface Membership {
  groupId: number;
  groupTitle: string;
  roleId: number | null;
  status: string;
  comment: string;
  /** Member field id -> name and value. */
  fields: Record<string, { name: string; value: string }>;
}

/** One attribute of a membership that differs between survivor and loser. */
export interface MembershipDiff {
  /** `role`, `status`, `comment` or `field:<id>`. */
  key: string;
  label: string;
  survivor: string;
  loser: string;
  /** Needs the operator: both sides hold a value and the values differ. */
  conflict: boolean;
  /** What to write to the survivor when not a conflict (the non-empty side). */
  proposal: "survivor" | "loser";
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function entry(key: string, label: string, survivor: string, loser: string): MembershipDiff | null {
  if (survivor === loser) return null;
  const conflict = survivor !== "" && loser !== "";
  return { key, label, survivor, loser, conflict, proposal: survivor !== "" ? "survivor" : "loser" };
}

/** Attributes that differ between two memberships of the same group. */
export function diffMemberships(survivor: Membership, loser: Membership): MembershipDiff[] {
  const out: Array<MembershipDiff | null> = [
    entry("role", "role", str(survivor.roleId), str(loser.roleId)),
    entry("status", "status", survivor.status, loser.status),
    entry("comment", "comment", survivor.comment, loser.comment),
  ];
  const ids = new Set([...Object.keys(survivor.fields), ...Object.keys(loser.fields)]);
  for (const id of [...ids].sort((x, y) => Number(x) - Number(y))) {
    const s = survivor.fields[id];
    const l = loser.fields[id];
    out.push(entry(`field:${id}`, (s ?? l)!.name, str(s?.value), str(l?.value)));
  }
  return out.filter((d): d is MembershipDiff => d !== null);
}

/**
 * Build the PATCH body for the surviving membership from the diff and the operator's picks.
 * `picks` maps a conflicting key to `survivor` or `loser`. Returns null when nothing changes.
 */
export function buildMembershipPatch(
  diffs: readonly MembershipDiff[],
  picks: Readonly<Record<string, "survivor" | "loser">>,
): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  const fields: Record<string, string> = {};
  for (const d of diffs) {
    const choice = d.conflict ? (picks[d.key] ?? "survivor") : d.proposal;
    if (choice !== "loser") continue;
    if (d.key === "role") body.groupTypeRoleId = Number(d.loser);
    else if (d.key === "status") body.groupMemberStatus = d.loser;
    else if (d.key === "comment") body.comment = d.loser;
    else fields[d.key.slice("field:".length)] = d.loser;
  }
  if (Object.keys(fields).length > 0) body.fields = fields;
  return Object.keys(body).length > 0 ? body : null;
}

/** Normalise an API membership record. */
export function toMembership(raw: unknown): Membership {
  const r = raw as {
    group?: { title?: string; domainIdentifier?: string };
    groupTypeRoleId?: number | null;
    groupMemberStatus?: string;
    comment?: string | null;
    fields?: Array<{ id: number; name: string; value: unknown }>;
  };
  const fields: Membership["fields"] = {};
  for (const f of r.fields ?? []) fields[String(f.id)] = { name: f.name, value: str(f.value) };
  return {
    groupId: Number(r.group?.domainIdentifier),
    groupTitle: r.group?.title ?? "",
    roleId: r.groupTypeRoleId ?? null,
    status: r.groupMemberStatus ?? "",
    comment: str(r.comment),
    fields,
  };
}
