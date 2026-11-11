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
  toPersonRecord,
  markNoDuplicate,
  mergePersons,
  type DupesClient,
  type MergePreview,
  type PersonRecord,
  type RelationshipTypeIds,
} from "./ct.js";
import { MERGE_CONFIRMED } from "./finance.js";
import { buildBody, buildModel, optigemOutcome, type EmailRow, type MergeModel } from "./merge-model.js";
import {
  loadDynamicGroupIds,
  loadSharedGroups,
  prepareSharedGroups,
  type GroupProgress,
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
  departmentIds: "departments",
  contactLabelId: "contactLabels",
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

/**
 * ChurchTools' key for a refusal (`messageKey`, on older responses `translationKey`; e.g. on a 403). Only a key that looks
 * like one is returned, never the message, which can echo values.
 */
export function errorKey(err: unknown): string | undefined {
  if (!(err instanceof CtApiError)) return undefined;
  const body = err.body as { messageKey?: unknown; translationKey?: unknown } | null;
  const key = body?.messageKey ?? body?.translationKey;
  return typeof key === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(key) ? key : undefined;
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
        for (const r of rows as Array<{ id?: unknown; name?: unknown; nameTranslated?: unknown }>) {
          const name = typeof r.nameTranslated === "string" && r.nameTranslated ? r.nameTranslated : r.name;
          if (typeof r.id === "number" && typeof name === "string") map.set(r.id, name);
        }
      }
      out[field] = map;
    }
  } catch {
    /* ids are shown instead */
  }
  return out;
}

/**
 * The contact label ("Privat", "Arbeit", ...) of an email row on each side, as ChurchTools shows it
 * next to "E-Mail". Empty when the side has no entry or masterdata has no name for the label.
 */
export function emailTypes(row: EmailRow, labels: Labels): { original: string; duplicate: string } {
  const name = (e: Record<string, unknown> | null): string => {
    const id = e?.contactLabelId;
    return typeof id === "number" ? (labels.contactLabelId?.get(id) ?? "") : "";
  };
  return { original: name(row.originalEntry), duplicate: name(row.duplicateEntry) };
}

/** Row label for an email row: "E-Mail (Privat)", the type the merged address keeps. */
export function emailLabel(row: EmailRow, labels: Labels): string {
  const t = emailTypes(row, labels);
  const type = row.originalEntry ? t.original : t.duplicate;
  return type ? `E-Mail (${type})` : "E-Mail";
}

/** True when the value is a masterdata id (or list of them) that masterdata names: not personal data. */
export function isMasterValue(key: string, v: unknown, labels: Labels): boolean {
  const known = (x: unknown) => typeof x === "number" && labels[key]?.has(x) === true;
  return Array.isArray(v) ? v.length > 0 && v.every(known) : known(v);
}

/** Display text for a person field value. Names for ids where masterdata knows them. */
export function formatValue(key: string, v: unknown, labels: Labels): string {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.map((x) => formatValue(key, x, labels)).join(", ");
  if (typeof v === "number" && labels[key]?.has(v)) return labels[key]!.get(v)!;
  // Dates as ChurchTools shows them: 30.06.1999.
  const date = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (date) return `${date[3]}.${date[2]}.${date[1]}`;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** id -> name, created date and last login for the list: one paginated collection GET. */
export async function loadNames(
  client: DupesClient,
): Promise<Map<number, { first: string; last: string; created?: string; login?: string }>> {
  const out = new Map<number, { first: string; last: string; created?: string; login?: string }>();
  try {
    const { data } = await client.getAll<{
      id: number;
      firstName?: string;
      lastName?: string;
      lastLogin?: string | null;
      meta?: { createdDate?: string };
    }>("/persons");
    for (const p of data)
      out.set(p.id, {
        first: p.firstName ?? "",
        last: p.lastName ?? "",
        created: p.meta?.createdDate ?? "",
        login: p.lastLogin ?? "",
      });
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

/** Which request of `loadPair` failed. */
export type PairLoadStep = "original" | "duplicate" | "preview" | "membership";

/** A pair that did not load, naming the request that failed. */
export class PairLoadError extends Error {
  constructor(
    readonly step: PairLoadStep,
    readonly status: number | null,
    override readonly cause: unknown,
  ) {
    super(`pair load failed at ${step}${status ? ` (HTTP ${status})` : ""}`);
  }

  /** True only when `GET /persons/{id}` itself answered 404: that person is gone. */
  get personGone(): boolean {
    return (this.step === "original" || this.step === "duplicate") && this.status === 404;
  }

  /** German description for the UI. No person data. */
  describe(): string {
    const what =
      this.step === "preview"
        ? "Merge-Vorschau"
        : this.step === "membership"
          ? "Gruppenmitgliedschaft"
          : this.step === "original"
            ? "Original"
            : "Duplikat";
    return `${what}${this.status ? `, HTTP ${this.status}` : ""}`;
  }
}

/** Load both persons and the merge preview for one direction (`originalId` survives). */
export async function loadPair(deps: ReviewDeps, originalId: number, duplicateId: number): Promise<PairData> {
  const { client } = deps;
  const statusOf = (err: unknown): number | null => (err instanceof CtApiError ? err.status : null);
  // One GET per person: the record is derived from the raw object.
  const settled = await Promise.allSettled([
    loadRawPerson(client, originalId),
    loadRawPerson(client, duplicateId),
    loadMergePreview(client, originalId, duplicateId),
  ]);
  const steps: PairLoadStep[] = ["original", "duplicate", "preview"];
  for (const [i, r] of settled.entries())
    if (r.status === "rejected") throw new PairLoadError(steps[i]!, statusOf(r.reason), r.reason);
  const [originalRaw, duplicateRaw, preview] = settled.map(
    (r) => (r as PromiseFulfilledResult<unknown>).value,
  ) as [Record<string, unknown>, Record<string, unknown>, MergePreview];
  let shared: SharedGroup[] = [];
  if (preview.groupsDiff.both.length > 0) {
    try {
      shared = await loadSharedGroups(
        client,
        preview.groupsDiff.both,
        originalId,
        duplicateId,
        await loadDynamicGroupIds(client),
      );
    } catch (err) {
      throw new PairLoadError("membership", statusOf(err), err);
    }
  }
  return {
    original: toPersonRecord(originalRaw, deps.optigemField),
    duplicate: toPersonRecord(duplicateRaw, deps.optigemField),
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
      /** ChurchTools' translation key for the refusal, when it sent one. */
      reason?: string;
      /** Group steps that went through before the failure (they are not rolled back). */
      groupsDone?: GroupStep[];
      /** The group whose clean-up failed (stage "groups"). */
      groupId?: number;
      /** In that group the Original's membership was already rewritten before the failure. */
      groupPatched?: boolean;
      /**
       * The pair re-read after group steps went through, so a retry sees the groups as they are now
       * (the cached `shared` list is stale). Absent when nothing changed or the re-read failed;
       * then `stale` is true if groups were changed and the caller must reload the pair.
       */
      fresh?: PairData;
      stale?: boolean;
    };

async function duplicateGone(deps: ReviewDeps, id: number): Promise<boolean | null> {
  try {
    await loadPerson(deps.client, id, deps.optigemField);
    return false;
  } catch (err) {
    return err instanceof CtApiError && err.status === 404 ? true : null;
  }
}

/** Both persons as they were before the merge, for the finance export (the local store is 0600). */
type MergeParties = Record<"survivingName" | "loserName" | "survivingOptigemId" | "loserOptigemId", string>;

function mergeParties(pair: PairData): MergeParties {
  const name = (p: PersonRecord): string => `${p.firstName} ${p.lastName}`.trim();
  return {
    survivingName: name(pair.original),
    loserName: name(pair.duplicate),
    survivingOptigemId: pair.original.optigem,
    loserOptigemId: pair.duplicate.optigem,
  };
}

function confirm(
  deps: ReviewDeps,
  survivingId: number,
  loserId: number,
  parties: Partial<MergeParties>,
  leading: string,
  orphaned: string,
  extra: Record<string, unknown>,
): void {
  deps.store.audit(
    {
      action: MERGE_CONFIRMED,
      survivingId,
      loserId,
      ...parties,
      leadingOptigemId: leading,
      orphanedOptigemId: orphaned,
      mergedBy: deps.operator.name,
      mergedById: deps.operator.id,
      ...extra,
    },
    (deps.now ?? ((): Date => new Date()))(),
  );
}

/** After a failure that left group changes behind: re-read the pair so retries start from reality. */
async function withFresh(
  deps: ReviewDeps,
  pair: PairData,
  res: Extract<MergeResult, { kind: "failed" }>,
): Promise<MergeResult> {
  const changed = res.groupsDone && res.groupsDone.length > 0;
  if (!changed && !res.groupPatched) return res;
  try {
    return { ...res, fresh: await loadPair(deps, pair.original.id, pair.duplicate.id) };
  } catch {
    return { ...res, stale: true };
  }
}

/**
 * Merge `pair.duplicate` into `pair.original` with the model's choices. The Original is re-read
 * right before the write (one GET): the operator may have taken minutes to decide and the body is
 * built from that object, so a stale copy could overwrite a concurrent edit. The Duplikat comes
 * from the loaded pair.
 */
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
  const parties = mergeParties(pair);

  let built: ReturnType<typeof buildBody>;
  try {
    built = buildBody(await loadRawPerson(deps.client, survivingId), pair.duplicateRaw, model); // fresh: see above
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
      fromDuplicate: model.fields
        .filter((f) => f.choice === "duplicate" || f.choice === "both")
        .map((f) => f.key),
      ...parties,
      leadingOptigemId: leading,
      orphanedOptigemId: orphaned,
    },
    now(),
  );
  const groupsDone: GroupStep[] = [];
  const progress: GroupProgress = {};
  try {
    await prepareSharedGroups(deps.client, shared, survivingId, loserId, groupsDone, progress);
  } catch (err) {
    const failedGroup = progress.groupId;
    store.audit(
      {
        action: "merge-error",
        survivingId,
        loserId,
        stage: "groups",
        groupsDone,
        failedGroup,
        ...(progress.patched ? { failedGroupPatched: true } : {}),
      },
      now(),
    );
    return withFresh(deps, pair, {
      kind: "failed",
      status: status(err),
      stage: "groups",
      groupsDone,
      groupId: failedGroup,
      ...(progress.patched ? { groupPatched: true } : {}),
    });
  }
  if (groupsDone.length > 0)
    store.audit({ action: "groups-prepared", survivingId, loserId, groupsDone }, now());
  try {
    await mergePersons(deps.client, survivingId, loserId, built.body);
  } catch (err) {
    store.audit({ action: "merge-error", survivingId, loserId }, now());
    if ((await duplicateGone(deps, loserId)) === true) {
      confirm(deps, survivingId, loserId, parties, leading, orphaned, { afterError: true });
      return {
        kind: "merged",
        duplicateStillExists: false,
        checkFailed: false,
        afterError: true,
        warnings: built.warnings,
      };
    }
    return withFresh(deps, pair, {
      kind: "failed",
      status: status(err),
      stage: "patch",
      fields: rejectedFields(err),
      reason: errorKey(err),
      groupsDone,
    });
  }
  const gone = await duplicateGone(deps, loserId);
  confirm(deps, survivingId, loserId, parties, leading, orphaned, {
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
  // Only a recovered merge when the surviving person is still there: otherwise the 404 says nothing.
  try {
    await loadRawPerson(deps.client, Number(started.survivingId));
  } catch {
    return false;
  }
  confirm(
    deps,
    Number(started.survivingId),
    Number(started.loserId),
    Object.fromEntries(
      (["survivingName", "loserName", "survivingOptigemId", "loserOptigemId"] as const)
        .filter((k) => typeof started[k] === "string")
        .map((k) => [k, started[k] as string]),
    ),
    typeof started.leadingOptigemId === "string" ? started.leadingOptigemId : "",
    typeof started.orphanedOptigemId === "string" ? started.orphanedOptigemId : "",
    { recovered: true },
  );
  return true;
}
