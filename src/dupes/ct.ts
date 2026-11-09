/**
 * ChurchTools access for `ct dupes`. All person data enters the process here.
 * Takes a narrow client interface so tests can substitute a fake.
 */
import { fetchDynamicGroupIds } from "../api/dynamicGroups.js";
import type { CtClient } from "../api/ctClient.js";
import { type Candidate, type DupePerson, detect, pairKey, pairScorer, tierOf } from "./detector.js";
import { toMembership, type Membership } from "./memberships.js";

export type DupesClient = Pick<CtClient, "get" | "getAll" | "request">;

/** Person fields shown side by side in review. */
export interface PersonRecord {
  id: number;
  firstName: string;
  lastName: string;
  nickname: string;
  email: string;
  mobile: string;
  phonePrivate: string;
  birthday: string | null;
  street: string;
  zip: string;
  city: string;
  sexId: number | null;
  campusId: number | null;
  statusId: number | null;
  isArchived: boolean;
  createdDate: string;
  lastEditedDate: string;
  lastLogin: string;
  optigem: string;
}

export const DEFAULT_OPTIGEM_FIELD = "optigemId";

export function toPersonRecord(raw: Record<string, unknown>, optigemField: string): PersonRecord {
  const s = (k: string): string => (raw[k] === null || raw[k] === undefined ? "" : String(raw[k]));
  const meta = (raw.meta ?? {}) as { createdDate?: string };
  return {
    id: Number(raw.id),
    firstName: s("firstName"),
    lastName: s("lastName"),
    nickname: s("nickname"),
    email: s("email"),
    mobile: s("mobile"),
    phonePrivate: s("phonePrivate"),
    birthday: (raw.birthday as string | null) ?? null,
    street: s("street"),
    zip: s("zip"),
    city: s("city"),
    sexId: (raw.sexId as number | null) ?? null,
    campusId: (raw.campusId as number | null) ?? null,
    statusId: (raw.statusId as number | null) ?? null,
    isArchived: raw.isArchived === true,
    createdDate: meta.createdDate ?? "",
    lastEditedDate: s("lastEditedDate"),
    lastLogin: s("lastLogin"),
    optigem: s(optigemField),
  };
}

export function toDupePerson(r: PersonRecord): DupePerson {
  return { ...r, optigem: r.optigem };
}

/** All non-archived persons. */
export async function loadActivePersons(client: DupesClient, optigemField: string): Promise<PersonRecord[]> {
  const { data } = await client.getAll<Record<string, unknown>>("/persons");
  return data.map((p) => toPersonRecord(p, optigemField)).filter((p) => !p.isArchived);
}

export async function loadPerson(
  client: DupesClient,
  id: number,
  optigemField: string,
): Promise<PersonRecord> {
  const raw = await client.get<Record<string, unknown>>(`/persons/${id}`);
  return toPersonRecord(raw, optigemField);
}

export interface RelationshipTypeIds {
  noDuplicate: number;
  duplicate: number;
}

interface RelType {
  id: number;
  functionKeys?: string[];
}

/** Resolve the two duplicate-related relationship types by function key (ids differ per instance). */
export async function resolveRelationshipTypes(client: DupesClient): Promise<RelationshipTypeIds> {
  const md = await client.get<{ relationshipTypes?: RelType[] }>("/person/masterdata");
  const types = md.relationshipTypes ?? [];
  const noDuplicate = types.find((t) => t.functionKeys?.includes("noduplicate"))?.id;
  const duplicate = types.find((t) => t.functionKeys?.includes("openduplicate"))?.id;
  // No fallback ids: they differ per instance, and a wrong guess writes a wrong relationship.
  if (noDuplicate === undefined || duplicate === undefined) {
    throw new Error(
      "ChurchTools masterdata has no relationship types with the function keys noduplicate/openduplicate.",
    );
  }
  return { noDuplicate, duplicate };
}

export interface RelationState {
  types: RelationshipTypeIds;
  /** Pairs with any relationship other than "Dublette": the detector never proposes them. */
  suppressed: Set<string>;
  /** Pairs CT itself proposes (untagged). */
  ctCandidates: Array<[number, number]>;
  /** Pairs tagged "Dublette" but not merged yet. */
  markedDuplicates: Array<[number, number]>;
}

interface RelRow {
  personAId: number;
  personBId: number;
  relationshipType?: { id?: number };
  relationshipTypeId?: number;
}

export async function loadRelationState(client: DupesClient): Promise<RelationState> {
  const types = await resolveRelationshipTypes(client);
  const rels = await client.getAll<RelRow>("/persons/relationships");
  const suppressed = new Set<string>();
  const marked = new Map<string, [number, number]>();
  for (const r of rels.data) {
    const typeId = r.relationshipType?.id ?? r.relationshipTypeId;
    const key = pairKey(r.personAId, r.personBId);
    if (typeId === types.duplicate) marked.set(key, [r.personAId, r.personBId]);
    else suppressed.add(key);
  }
  const groups = await client.get<
    Array<{
      relationshipTypeId: number | null;
      relationships: Array<{ p1: { id: number }; p2: { id: number } }>;
    }>
  >("/persons/duplicates");
  const ct = new Map<string, [number, number]>();
  for (const g of groups) {
    for (const rel of g.relationships ?? []) {
      const key = pairKey(rel.p1.id, rel.p2.id);
      if (g.relationshipTypeId === null) ct.set(key, [rel.p1.id, rel.p2.id]);
      else if (g.relationshipTypeId === types.duplicate) marked.set(key, [rel.p1.id, rel.p2.id]);
      else suppressed.add(key);
    }
  }
  for (const key of suppressed) {
    ct.delete(key);
    marked.delete(key);
  }
  return { types, suppressed, ctCandidates: [...ct.values()], markedDuplicates: [...marked.values()] };
}

/** Run the detector, merge in CT's own suggestions, drop suppressed pairs. */
export function buildCandidates(persons: readonly PersonRecord[], rel: RelationState): Candidate[] {
  const dupes = persons.map(toDupePerson);
  const byId = new Map(dupes.map((p) => [p.id, p]));
  const found = new Map(detect(dupes, { suppressed: rel.suppressed }).map((c) => [pairKey(c.a, c.b), c]));
  const scorePair = pairScorer(dupes);
  const addExternal = (pair: [number, number], marked: boolean): void => {
    const [x, y] = pair;
    const key = pairKey(x, y);
    const pa = byId.get(x);
    const pb = byId.get(y);
    if (!pa || !pb || rel.suppressed.has(key)) return; // archived or unknown
    const hit = found.get(key);
    if (hit) {
      hit.source = "both";
      if (marked) hit.markedDuplicate = true;
      return;
    }
    const res = scorePair(pa, pb);
    if (res.veto === "placeholder" && !marked) return;
    const score = Math.max(res.veto ? 0 : res.score, 35);
    found.set(key, {
      a: Math.min(x, y),
      b: Math.max(x, y),
      score,
      tier: tierOf(score) ?? "T3",
      matchClass: "ct",
      signals: res.veto ? [`veto:${res.veto}`] : res.signals,
      source: "ct",
      ...(marked ? { markedDuplicate: true } : {}),
    });
  };
  for (const pair of rel.ctCandidates) addExternal(pair, false);
  for (const pair of rel.markedDuplicates) addExternal(pair, true);
  return [...found.values()].sort((p, q) => q.score - p.score || p.a - q.a || p.b - q.b);
}

export interface SharedGroups {
  dynamic: Array<{ groupId: number; title: string }>;
  static: Array<{ groupId: number; title: string }>;
}

interface PersonGroupRow {
  group: { title?: string; domainIdentifier: string };
}

const dynamicIdCache = new WeakMap<DupesClient, Promise<Set<number>>>();

/** Dynamic group ids, fetched once per client (constant for a review session). */
function dynamicGroupIds(client: DupesClient): Promise<Set<number>> {
  let ids = dynamicIdCache.get(client);
  if (!ids) {
    ids = fetchDynamicGroupIds(client);
    dynamicIdCache.set(client, ids);
    ids.catch(() => dynamicIdCache.delete(client));
  }
  return ids;
}

/** Groups both persons belong to, split into dynamic (auto) and static. */
export async function findSharedGroups(client: DupesClient, a: number, b: number): Promise<SharedGroups> {
  const [ga, gb] = await Promise.all([
    client.getAll<PersonGroupRow>(`/persons/${a}/groups`),
    client.getAll<PersonGroupRow>(`/persons/${b}/groups`),
  ]);
  const idsB = new Set(gb.data.map((r) => Number(r.group.domainIdentifier)));
  const dynamicIds = await dynamicGroupIds(client);
  const out: SharedGroups = { dynamic: [], static: [] };
  const seen = new Set<number>();
  for (const row of ga.data) {
    const id = Number(row.group.domainIdentifier);
    if (!idsB.has(id) || seen.has(id)) continue;
    seen.add(id);
    const entry = { groupId: id, title: row.group.title ?? "" };
    (dynamicIds.has(id) ? out.dynamic : out.static).push(entry);
  }
  return out;
}

export async function loadMembership(
  client: DupesClient,
  groupId: number,
  personId: number,
): Promise<Membership> {
  return toMembership(await client.get(`/groups/${groupId}/members/${personId}`));
}

export async function patchMembership(
  client: DupesClient,
  groupId: number,
  personId: number,
  body: Record<string, unknown>,
): Promise<void> {
  await client.request("PATCH", `/groups/${groupId}/members/${personId}`, body);
}

export async function removeMembership(
  client: DupesClient,
  groupId: number,
  personId: number,
): Promise<void> {
  await client.request("DELETE", `/groups/${groupId}/members/${personId}`);
}

interface PersonRel {
  id: number;
  relationshipTypeId?: number;
  relationshipType?: { id?: number };
  /** The other person, as `GET /persons/{id}/relationships` returns it. */
  relative?: { domainIdentifier?: string };
  relativeId?: number;
}

/**
 * Tag a pair "Keine Dublette". An existing "Dublette" tag between the same two persons is removed
 * first so the two statuses never coexist.
 */
export async function markNoDuplicate(
  client: DupesClient,
  a: number,
  b: number,
  types: RelationshipTypeIds,
): Promise<void> {
  const rels = await client.get<PersonRel[]>(`/persons/${a}/relationships`);
  for (const r of rels) {
    const typeId = r.relationshipType?.id ?? r.relationshipTypeId;
    const other = Number(r.relative?.domainIdentifier ?? r.relativeId);
    if (typeId === types.duplicate && other === b) {
      await client.request("DELETE", `/persons/${a}/relationships/${r.id}`);
    }
  }
  await client.request("POST", `/persons/${a}/relationships`, {
    otherPersonId: b,
    relationshipTypeId: types.noDuplicate,
  });
}
