/**
 * The side-effecting steps of `ct dupes review`, free of any UI: load a pair, merge, mark "no
 * duplicate", recover an unrecorded merge. The TUI calls these; tests call them with a fake client.
 * Error text never carries person data: only an HTTP status leaves this module.
 */
import { CtApiError } from "../api/ctClient.js";
import {
  loadMergePreview,
  loadPerson,
  loadRawPerson,
  markNoDuplicate,
  mergePersons,
  type DupesClient,
  type MergePreview,
  type PersonRecord,
  type RelationshipTypeIds,
} from "./ct.js";
import { MERGE_CONFIRMED } from "./finance.js";
import { buildBody, buildModel, optigemOutcome, type MergeModel } from "./merge-model.js";
import {
  loadDynamicGroupIds,
  loadSharedGroups,
  prepareSharedGroups,
  type GroupStep,
  type SharedGroup,
} from "./groups.js";
import type { Redactor } from "./redact.js";
import type { DupesStore } from "./store.js";

/** Lookup names for id-valued person fields, keyed by field (`campusId`, `statusId`, `sexId`, ...). */
export type Labels = Record<string, Map<number, string>>;

export interface ReviewDeps {
  client: DupesClient;
  store: DupesStore;
  host: string;
  redactor: Redactor;
  optigemField: string;
  types: RelationshipTypeIds;
  operator: { id: number; name: string };
  labels: Labels;
  now?: () => Date;
}

const LOOKUPS: Record<string, string> = {
  campusId: "campuses",
  statusId: "statuses",
  sexId: "sexes",
  groupTypeRoleId: "roles",
  nationalityId: "nationalities",
  familyStatusId: "familyStatuses",
};

/**
 * Field keys ChurchTools names in a validation error (`errors[].fieldId`). Keys only, never the
 * message or args, which can echo submitted values.
 */
export function rejectedFields(err: unknown): string[] {
  if (!(err instanceof CtApiError)) return [];
  const errors = (err.body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  const keys = errors
    .map((e) => (e as { fieldId?: unknown }).fieldId)
    .filter((k): k is string => typeof k === "string" && /^[A-Za-z0-9_.[\]-]{1,64}$/.test(k));
  return [...new Set(keys)];
}

/** Names for campus, status, sex, ... from `/person/masterdata`. Empty when unavailable. */
export async function loadLabels(client: DupesClient): Promise<Labels> {
  const out: Labels = {};
  try {
    const md = await client.get<Record<string, unknown>>("/person/masterdata");
    for (const [field, list] of Object.entries(LOOKUPS)) {
      const rows = md[list];
      const map = new Map<number, string>();
      if (Array.isArray(rows)) {
        for (const r of rows as Array<{ id?: unknown; name?: unknown }>) {
          if (typeof r.id === "number" && typeof r.name === "string") map.set(r.id, r.name);
        }
      }
      out[field] = map;
    }
  } catch {
    /* ids are shown instead */
  }
  return out;
}

/** Display text for a person field value. Names for ids where masterdata knows them. */
export function formatValue(key: string, v: unknown, labels: Labels): string {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.length === 0 ? "" : v.map(String).join(", ");
  if (typeof v === "number" && labels[key]?.has(v)) return labels[key]!.get(v)!;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** id -> "First Last" for the list screen: one paginated collection GET. */
export async function loadNames(client: DupesClient): Promise<Map<number, { first: string; last: string }>> {
  const out = new Map<number, { first: string; last: string }>();
  try {
    const { data } = await client.getAll<{ id: number; firstName?: string; lastName?: string }>("/persons");
    for (const p of data) out.set(p.id, { first: p.firstName ?? "", last: p.lastName ?? "" });
  } catch {
    /* ids only */
  }
  return out;
}

export interface PairData {
  original: PersonRecord;
  duplicate: PersonRecord;
  originalRaw: Record<string, unknown>;
  duplicateRaw: Record<string, unknown>;
  preview: MergePreview;
  model: MergeModel;
  /** Groups both persons are in; cleaned up before the merge (ChurchTools refuses otherwise). */
  shared: SharedGroup[];
}

/** Load both persons and the merge preview for one direction (`originalId` survives). */
export async function loadPair(deps: ReviewDeps, originalId: number, duplicateId: number): Promise<PairData> {
  const { client } = deps;
  const [original, duplicate, preview, originalRaw, duplicateRaw] = await Promise.all([
    loadPerson(client, originalId, deps.optigemField),
    loadPerson(client, duplicateId, deps.optigemField),
    loadMergePreview(client, originalId, duplicateId),
    loadRawPerson(client, originalId),
    loadRawPerson(client, duplicateId),
  ]);
  const shared =
    preview.groupsDiff.both.length === 0
      ? []
      : await loadSharedGroups(
          client,
          preview.groupsDiff.both,
          originalId,
          duplicateId,
          await loadDynamicGroupIds(client),
        );
  return {
    original,
    duplicate,
    originalRaw,
    duplicateRaw,
    preview,
    model: buildModel(originalRaw, duplicateRaw, preview.personDiff, deps.optigemField),
    shared,
  };
}

export type MergeResult =
  | {
      kind: "merged";
      duplicateStillExists: boolean;
      checkFailed: boolean;
      afterError: boolean;
      warnings: string[];
    }
  | {
      kind: "failed";
      status: number | null;
      stage: "reread" | "groups" | "patch";
      fields?: string[];
      /** Group steps that went through before the failure (they are not rolled back). */
      groupsDone?: GroupStep[];
      /** The group whose clean-up failed (stage "groups"). */
      groupId?: number;
    };

async function duplicateGone(deps: ReviewDeps, id: number): Promise<boolean | null> {
  try {
    await loadPerson(deps.client, id, deps.optigemField);
    return false;
  } catch (err) {
    return err instanceof CtApiError && err.status === 404 ? true : null;
  }
}

function confirm(
  deps: ReviewDeps,
  survivingId: number,
  loserId: number,
  leading: string,
  orphaned: string,
  extra: Record<string, unknown>,
): void {
  deps.store.audit(
    {
      action: MERGE_CONFIRMED,
      survivingId,
      loserId,
      leadingOptigemId: leading,
      orphanedOptigemId: orphaned,
      mergedBy: deps.operator.name,
      mergedById: deps.operator.id,
      ...extra,
    },
    (deps.now ?? ((): Date => new Date()))(),
  );
}

/** Merge `pair.duplicate` into `pair.original` with the model's choices. Re-reads the original first. */
export async function executeMerge(
  deps: ReviewDeps,
  pair: PairData,
  model: MergeModel,
  shared: readonly SharedGroup[] = pair.shared,
): Promise<MergeResult> {
  const now = deps.now ?? ((): Date => new Date());
  const { store } = deps;
  const survivingId = pair.original.id;
  const loserId = pair.duplicate.id;
  const status = (err: unknown): number | null => (err instanceof CtApiError ? err.status : null);
  const { leading, orphaned } = optigemOutcome(model);

  let built: ReturnType<typeof buildBody>;
  try {
    built = buildBody(await loadRawPerson(deps.client, survivingId), pair.duplicateRaw, model);
  } catch (err) {
    store.audit({ action: "merge-error", survivingId, loserId }, now());
    return { kind: "failed", status: status(err), stage: "reread" };
  }

  const gd = pair.preview.groupsDiff;
  store.audit(
    {
      action: "merge-started",
      survivingId,
      loserId,
      personDiff: pair.preview.personDiff.map((d) => ({ key: d.key, original: d.old, duplicate: d.new })),
      groupsDiff: {
        original: gd.old.map((g) => g.id),
        duplicate: gd.new.map((g) => g.id),
        both: gd.both.map((g) => g.id),
      },
      fromDuplicate: model.fields.filter((f) => f.choice === "duplicate").map((f) => f.key),
      leadingOptigemId: leading,
      orphanedOptigemId: orphaned,
    },
    now(),
  );
  const groupsDone: GroupStep[] = [];
  try {
    await prepareSharedGroups(deps.client, shared, survivingId, loserId, groupsDone);
  } catch (err) {
    const failedGroup = shared[groupsDone.length]?.id;
    store.audit(
      { action: "merge-error", survivingId, loserId, stage: "groups", groupsDone, failedGroup },
      now(),
    );
    return { kind: "failed", status: status(err), stage: "groups", groupsDone, groupId: failedGroup };
  }
  if (groupsDone.length > 0)
    store.audit({ action: "groups-prepared", survivingId, loserId, groupsDone }, now());
  try {
    await mergePersons(deps.client, survivingId, loserId, built.body);
  } catch (err) {
    store.audit({ action: "merge-error", survivingId, loserId }, now());
    if ((await duplicateGone(deps, loserId)) === true) {
      confirm(deps, survivingId, loserId, leading, orphaned, { afterError: true });
      return {
        kind: "merged",
        duplicateStillExists: false,
        checkFailed: false,
        afterError: true,
        warnings: built.warnings,
      };
    }
    return { kind: "failed", status: status(err), stage: "patch", fields: rejectedFields(err), groupsDone };
  }
  const gone = await duplicateGone(deps, loserId);
  confirm(deps, survivingId, loserId, leading, orphaned, {
    ...(gone === false ? { duplicateStillExists: true } : {}),
    ...(gone === null ? { duplicateCheckFailed: true } : {}),
  });
  return {
    kind: "merged",
    duplicateStillExists: gone === false,
    checkFailed: gone === null,
    afterError: false,
    warnings: built.warnings,
  };
}

/** Tag the pair "Keine Dublette". The decision is logged either way; `ok` says whether CT took it. */
export async function markNotDuplicate(
  deps: ReviewDeps,
  a: number,
  b: number,
): Promise<{ ok: boolean; status: number | null }> {
  const now = deps.now ?? ((): Date => new Date());
  try {
    await markNoDuplicate(deps.client, a, b, deps.types);
    deps.store.audit({ action: "no-duplicate", a, b, writeBack: "ok" }, now());
    return { ok: true, status: null };
  } catch (err) {
    deps.store.audit({ action: "no-duplicate", a, b, writeBack: "failed" }, now());
    return { ok: false, status: err instanceof CtApiError ? err.status : null };
  }
}

/**
 * A pair that no longer loads (404): if the audit holds a `merge-started` without `merge-confirmed`
 * and the duplicate is gone, record the merge as recovered. Returns true when recorded.
 */
export async function recoverUnrecordedMerge(deps: ReviewDeps, a: number, b: number): Promise<boolean> {
  const same = (e: Record<string, unknown>): boolean =>
    (e.survivingId === a && e.loserId === b) || (e.survivingId === b && e.loserId === a);
  let started: Record<string, unknown> | null = null;
  for (const e of deps.store.readAudit()) {
    if (!same(e)) continue;
    if (e.action === "merge-started") started = e;
    if (e.action === MERGE_CONFIRMED) started = null;
  }
  if (!started || (await duplicateGone(deps, Number(started.loserId))) !== true) return false;
  confirm(
    deps,
    Number(started.survivingId),
    Number(started.loserId),
    typeof started.leadingOptigemId === "string" ? started.leadingOptigemId : "",
    typeof started.orphanedOptigemId === "string" ? started.orphanedOptigemId : "",
    { recovered: true },
  );
  return true;
}
