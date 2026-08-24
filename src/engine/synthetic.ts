/**
 * Generic seam for "synthetic sub-resource fields": pseudo-fields that are not
 * real API columns on a resource (like `parents`), but are folded into the diff
 * on both sides and routed at apply time to a dedicated endpoint. `parents` is
 * the first entry; dynamic groups (and later permission grants) join the same
 * registry so `build.ts`/`execute.ts` never grow per-feature branches.
 */
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import type { DesiredResource, FieldChange, Plan, PlanItem } from "./types.js";
import { applyHierarchy, parentIdsByGroupId, type HierarchyEntry } from "./hierarchy.js";
import { assertNotPeople } from "./guard.js";
import { deepEqual } from "./plan.js";
import { mapConcurrent } from "../util/concurrency.js";
import { info, warn, formatError } from "../ui.js";
import { normalizeDynamic, normalizeRuleset, putRulesetBody, resolveRulesetRef } from "./dynamic.js";
import { formatPortablizeWarnings, scanUnportablized } from "../config/query-refs.js";
import { slug } from "../resources/registry.js";
import {
  actualMemberFieldProps,
  groupScopedRows,
  localKeyOf,
  matchesLocalKey,
  memberFieldIdentity,
  memberFieldItemPath,
  memberFieldLocalKey,
  memberFieldPseudo,
  memberFieldRowId,
  memberFieldsCreatePath,
  memberFieldsReadPath,
  MEMBER_FIELD_PREFIX,
  type MemberFieldRow,
} from "./member-fields.js";
import type { DynamicStatus } from "./types.js";

/** How many dynamic groups to fetch (ruleset + status) from ChurchTools at once. Mirrors build.ts. */
const DYNAMIC_FETCH_CONCURRENCY = 8;

/** The per-group counts CT returns from POST /dynamicgroups/{id}/refresh. */
interface RefreshResult {
  created: number;
  updated: number;
  deleted: number;
}

export interface SyntheticFoldCtx {
  client: Pick<CtClient, "get">;
  state: State;
  desired: DesiredResource[];
  actual: Map<string, Record<string, unknown>>;
  /** Directory of the config file, so `{ ref }` ruleset paths resolve relative to it (not the cwd). */
  configDir?: string;
}
export interface SyntheticApplyCtx {
  client: Pick<CtClient, "request">;
  state: State;
  id: number;
  /**
   * The owning resource's LOGICAL key. Needed by any field whose write produces state a later
   * change has to read back — today the group-scoped member fields (#135), which record each
   * created field's id on the group's state entry so a same-run ruleset reference can resolve.
   */
  key: string;
  change: FieldChange;
}
export interface SyntheticPostApplyCtx {
  client: Pick<CtClient, "request">;
  state: State;
  /** Post-execute id from state (creates already carry their real id). */
  id: number;
  item: PlanItem;
  change: FieldChange;
}
/**
 * What a fold pass produced.
 *
 * `unreadable` is the half that keeps a degraded plan HONEST (#126): the logical keys whose ACTUAL
 * side could not be read. A fold must never fold only the desired side of a field it could not read
 * the actual of — that manufactures an update out of a transient 429. Reporting the key here makes
 * `buildPlan` mark the resource fetch-failed, so it renders as "could not be read" instead of
 * silently joining the `to update` count.
 */
export interface SyntheticFoldResult {
  desired: DesiredResource[];
  errors: string[];
  unreadable?: string[];
}

export interface SyntheticField {
  field: string;
  /**
   * Marks this entry as owning a FAMILY of pseudo-fields sharing a prefix, rather than one fixed
   * name (#135). Group-scoped member fields need it: one declared field folds into one pseudo-field
   * (`memberField:wahl`), so the plan diffs and renders per field instead of as one opaque array —
   * and, crucially, a field dropped from config simply has no desired key, which is what makes
   * `diffFields` (desired-driven) structurally incapable of turning a removal into a delete.
   */
  prefix?: string;
  fold(ctx: SyntheticFoldCtx): Promise<SyntheticFoldResult>;
  apply(ctx: SyntheticApplyCtx): Promise<void>;
  /**
   * Optional opt-in side effect run AFTER the whole plan has applied (e.g. `ct apply --refresh`
   * materializing dynamic-group membership). Keeps field-specific post-apply knowledge in the
   * field, not the command layer. Must swallow its own errors — one field's failure must not
   * abort the others.
   */
  postApply?(ctx: SyntheticPostApplyCtx): Promise<void>;
}

function resolveId(state: State, key: string): number {
  const managed = state.resources[key];
  if (!managed) throw new Error(`Cannot resolve parent "${key}" — not under management yet.`);
  return managed.id;
}

/** `parents`: many-to-many group hierarchy, reconciled per-edge. Wraps the existing hierarchy helpers. */
const parentsField: SyntheticField = {
  field: "parents",
  async fold({ client, state, desired, actual }) {
    // Gate on the DESIRED side, not the pre-apply state: on a fresh state the
    // groups don't exist yet, so a state-side gate returns early and the first
    // apply drops every declared hierarchy edge (flat groups, exit 0). Gating on
    // "some desired group opted into parents" makes the first apply create edges,
    // and still skips the /groups/hierarchies fetch when nobody opts in.
    const optedIn = desired.some((d) => d.type === "group" && d.parents !== undefined);
    if (!optedIn) return { desired, errors: [] };
    try {
      const raw = await client.get<HierarchyEntry[]>("/groups/hierarchies");
      const parentIds = parentIdsByGroupId(Array.isArray(raw) ? raw : []);
      return { desired: applyHierarchy(desired, state, actual, parentIds), errors: [] };
    } catch (err) {
      const message = formatError(err);
      warn(`Failed to fetch group hierarchies: ${message}`);
      // Leave `parents` undiffed rather than fabricate "add all parents" from an empty map — and
      // report every opted-in group as unreadable so the plan says so instead of quietly
      // under-reporting a real hierarchy change as a no-op (#126).
      return {
        desired,
        errors: [`group hierarchies: ${message}`],
        unreadable: desired.filter((d) => d.type === "group" && d.parents !== undefined).map((d) => d.key),
      };
    }
  },
  async apply({ client, state, id, change }) {
    const from = new Set(Array.isArray(change.from) ? (change.from as string[]) : []);
    const to = new Set(Array.isArray(change.to) ? (change.to as string[]) : []);
    for (const key of [...to].filter((k) => !from.has(k))) {
      const path = `/groups/${id}/parents/${resolveId(state, key)}`;
      assertNotPeople(path);
      await client.request("PUT", path);
    }
    for (const key of [...from].filter((k) => !to.has(k))) {
      const path = `/groups/${id}/parents/${resolveId(state, key)}`;
      assertNotPeople(path);
      await client.request("DELETE", path);
    }
  },
};

/** How many groups' member-field lists to read from ChurchTools at once. Mirrors the dynamic fold. */
const MEMBER_FIELD_FETCH_CONCURRENCY = 8;

/** Read one group's group-scoped member fields through a read-only client. */
async function readMemberFields(client: Pick<CtClient, "get">, groupId: number): Promise<MemberFieldRow[]> {
  return groupScopedRows(await client.get<unknown>(memberFieldsReadPath(groupId)));
}

/** Read them through the write client (apply only has `request`; `GET` goes through it just fine). */
async function readMemberFieldsForWrite(
  client: Pick<CtClient, "request">,
  groupId: number,
): Promise<MemberFieldRow[]> {
  return groupScopedRows(await client.request<unknown>("GET", memberFieldsReadPath(groupId)));
}

/**
 * `memberField:<localKey>`: group-scoped member-field DEFINITIONS (#135), one pseudo-field per
 * declared field on the owning group.
 *
 * Three properties of this shape are load-bearing rather than incidental:
 *
 *  1. **Never deletes.** `diffFields` walks the DESIRED side, so a field dropped from config
 *     produces no key, no change and no write — it is structurally impossible for a removal to
 *     become a delete here. The live field is still surfaced as a DELETE CANDIDATE (a warning
 *     naming its portable identity and the explicit `ct destroy --member-field` that removes it),
 *     so "left alone" never means "unnoticed".
 *  2. **Round-trips to a no-op.** The actual side is narrowed to exactly the properties the
 *     declaration names (`actualMemberFieldProps`), so a server-defaulted sibling CT returns can
 *     never make the two sides unequal forever.
 *  3. **Ordered before `dynamic`.** This entry is registered ahead of the dynamic field, so the
 *     folded `memberField:*` keys land in the desired bag before `dynamic`, `diffFields` emits them
 *     in that order, and `applySyntheticFields` therefore creates the fields before installing a
 *     ruleset that may reference them.
 */
const memberFieldsField: SyntheticField = {
  field: MEMBER_FIELD_PREFIX,
  prefix: MEMBER_FIELD_PREFIX,
  async fold({ client, state, desired, actual }) {
    const optedIn = desired.filter((d) => d.type === "group" && d.memberFields !== undefined);
    if (optedIn.length === 0) return { desired, errors: [] };

    // Only groups that are ALREADY managed and were fetched have an actual side to read. A group
    // this run creates has neither — its fields are created by its own apply item — and a vanished
    // one is handled as a recreate by the plain plan.
    const readable = optedIn.filter((d) => {
      const managed = state.resources[d.key];
      return managed?.type === "group" && actual.get(d.key) !== undefined;
    });
    const outcomes = await mapConcurrent(readable, MEMBER_FIELD_FETCH_CONCURRENCY, async (d) => {
      const managed = state.resources[d.key]!;
      try {
        return { key: d.key, rows: await readMemberFields(client, managed.id), errors: [] as string[] };
      } catch (err) {
        // Same honesty rule as the dynamic fold (#126): an unread actual is NOT a known-absent one,
        // so the desired side stays unfolded and the group is reported unreadable rather than having
        // "create every member field" manufactured out of a transient 429.
        return {
          key: d.key,
          rows: undefined,
          errors: [`member fields ${d.key} (#${managed.id}): ${formatError(err)}`],
        };
      }
    });
    const errors = outcomes.flatMap((o) => o.errors);
    const unreadable = outcomes.filter((o) => o.rows === undefined).map((o) => o.key);
    const unreadableKeys = new Set(unreadable);
    const rowsByKey = new Map(outcomes.filter((o) => o.rows !== undefined).map((o) => [o.key, o.rows!]));

    const augmented = desired.map((d) => {
      if (d.type !== "group" || d.memberFields === undefined) return d;
      if (unreadableKeys.has(d.key)) return d;
      const rows = rowsByKey.get(d.key);
      const a = actual.get(d.key);
      const fields = { ...d.fields };
      for (const spec of d.memberFields) {
        const pseudo = memberFieldPseudo(spec.key);
        fields[pseudo] = spec.props;
        if (!a || !rows) continue;
        const matches = rows.filter((row) => matchesLocalKey(row, spec.key));
        // >1 live match means the local key is ambiguous on this host — a blind update would pick
        // one arbitrarily, so leave the actual side absent and let the ambiguity surface where it
        // can be acted on (the apply path refuses it by name).
        if (matches.length === 1) {
          a[pseudo] = actualMemberFieldProps(matches[0]!, Object.keys(spec.props));
        }
      }
      if (rows) {
        const declared = new Set(d.memberFields.map((f) => slug(f.key)));
        for (const row of rows) {
          const local = localKeyOf(row);
          if (!local || declared.has(local)) continue;
          warn(
            `group "${d.key}": member field "${memberFieldIdentity(d.key, local)}" exists in ` +
              `ChurchTools but is not declared — DELETE CANDIDATE, left untouched. ct never removes a ` +
              `member field because it vanished from config; remove it explicitly with ` +
              `\`ct destroy --member-field ${memberFieldIdentity(d.key, local)}\`.`,
          );
        }
      }
      return { ...d, fields };
    });
    return { desired: augmented, errors, unreadable };
  },
  async apply({ client, state, id, key, change }) {
    const local = memberFieldLocalKey(change.field);
    if (local === undefined) return;
    const props = change.to as Record<string, unknown> | undefined;
    // No desired value = the field is not declared. `diffFields` cannot even produce such a change
    // (it walks the desired side), so this is belt-and-braces: apply never deletes a member field.
    if (props === undefined || props === null) return;

    const rows = await readMemberFieldsForWrite(client, id);
    const matches = rows.filter((row) => matchesLocalKey(row, local));
    if (matches.length > 1) {
      throw new Error(
        `group member field "${memberFieldIdentity(key, local)}": ${matches.length} fields on group ` +
          `#${id} answer to the local key "${local}". Rename one in ChurchTools so the key is unique ` +
          `within the group, then re-apply.`,
      );
    }

    const record = (fieldId: number): void => {
      // Record the per-host id on the OWNING GROUP's state entry, so a same-run `<group>::<field>`
      // reference in a ruleset applied later in this very item can be completed (#135).
      const managed = state.resources[key];
      if (!managed) return;
      managed.memberFields = { ...managed.memberFields, [local]: fieldId };
    };

    if (matches.length === 1) {
      const fieldId = memberFieldRowId(matches[0]!);
      if (fieldId === undefined) {
        throw new Error(
          `group member field "${memberFieldIdentity(key, local)}": the matching ChurchTools row ` +
            `carries no numeric id, so it cannot be updated.`,
        );
      }
      const path = memberFieldItemPath(id, fieldId);
      assertNotPeople(path);
      // PATCH is a partial update, so unmanaged sibling properties are left alone (the same reason
      // groups are PATCHed). Instances whose member-field endpoint only implements PUT answer 405/501
      // — fall back rather than fail an apply over a verb.
      try {
        await client.request("PATCH", path, props);
      } catch (err) {
        if (!(err instanceof CtApiError && (err.status === 405 || err.status === 501))) throw err;
        await client.request("PUT", path, props);
      }
      record(fieldId);
      return;
    }

    const createPath = memberFieldsCreatePath(id);
    assertNotPeople(createPath);
    // `referenceName` is the local key, not a managed property: it is CT's own stable, non-numeric
    // handle within the group, and sending it at create is what lets every later run find this
    // field by its portable identity instead of by a host-specific id.
    const created = await client.request<{ id?: number } | undefined>("POST", createPath, {
      ...props,
      referenceName: local,
    });
    const newId = created?.id;
    if (typeof newId !== "number") {
      throw new Error(
        `group member field "${memberFieldIdentity(key, local)}": create returned no numeric id ` +
          `(got ${JSON.stringify(created)}).`,
      );
    }
    record(newId);
  },
};

/** `dynamic`: dynamic-group ruleset + status, reconciled as one synthetic field. */
const dynamicField: SyntheticField = {
  field: "dynamic",
  async fold({ client, state, desired, actual, configDir }) {
    // Single pass over the DESIRED opt-ins (mirrors hierarchy's desired-side gate): a group is
    // folded only if it declared `dynamic` AND is under management AND was fetched. Replaces the
    // old build-a-Set-then-invert-over-state pattern (one predicate, not three).
    const targets = desired.flatMap((d) => {
      if (d.type !== "group" || d.dynamic === undefined) return [];
      const managed = state.resources[d.key];
      if (!managed || managed.type !== "group") return []; // not adopted yet → created by the plain plan
      const a = actual.get(d.key);
      if (!a) return []; // vanished from CT → handled as a recreate by the plain plan
      return [{ managed, a }];
    });
    // Gate on the DESIRED opt-in, not on the readable targets (#135, mirroring `parents`). Returning
    // early whenever nothing is readable ALSO skipped folding the desired side of a group this run
    // CREATES — so a config whose only dynamic group was brand new silently applied no ruleset on
    // its first run, while the same config next to an already-adopted dynamic group applied it fine.
    // With no readable targets there is simply nothing to fetch; the desired-side fold below still runs.
    if (!desired.some((d) => d.type === "group" && d.dynamic !== undefined)) {
      return { desired, errors: [] };
    }
    // Fetch each group's (ruleset, status) concurrently — 2N serial round-trips otherwise dominate
    // plan/apply latency on a config with many dynamic groups. Within a group the two GETs stay
    // sequential: the status GET must run only after the ruleset GET succeeds (a 404 there means
    // "not a dynamic group" and short-circuits). Per-group error strings are collected in input
    // order so the plan-degradation output is deterministic regardless of completion order.
    const perGroupOutcome = await mapConcurrent(
      targets,
      DYNAMIC_FETCH_CONCURRENCY,
      async ({ managed, a }) => {
        // The ruleset GET and the status GET have distinct failure meanings, so they get distinct
        // try/catch blocks: only a ruleset 404 means "not a dynamic group". A status GET that fails
        // AFTER a successful ruleset GET must NOT fabricate the "none" sentinel (that would discard a
        // real ruleset and propose a spurious re-PUT) — it degrades the plan via `errors` instead.
        let ruleset: Record<string, unknown>;
        try {
          ruleset = await client.get<Record<string, unknown>>(`/dynamicgroups/${managed.id}/ruleset`);
        } catch (err) {
          if (err instanceof CtApiError && err.status === 404) {
            // Group exists but is not (yet) a dynamic group — its ruleset 404s. Sentinel so a promote
            // (desired active vs actual none) diffs as a real change and demote-to-none is a clean no-op.
            a.dynamic = { status: "none", ruleset: {} };
            return { errors: [], unreadable: [] };
          }
          // Non-404: we do NOT know this group's ruleset. Folding the desired side now would diff a
          // declared ruleset against an absent actual and manufacture an update out of a 429 (#126).
          return {
            errors: [`dynamic ${managed.key} (#${managed.id}): ${formatError(err)}`],
            unreadable: [managed.key],
          };
        }
        try {
          const statusRes = await client.get<{ dynamicGroupStatus?: string }>(
            `/dynamicgroups/${managed.id}/status`,
          );
          a.dynamic = {
            status: (statusRes?.dynamicGroupStatus ?? "none") as DynamicStatus,
            ruleset: normalizeRuleset(ruleset),
          };
          return { errors: [], unreadable: [] };
        } catch (err) {
          // Same reasoning as the ruleset case: an unknown status is not a known-different status.
          return {
            errors: [`dynamic ${managed.key} status (#${managed.id}): ${formatError(err)}`],
            unreadable: [managed.key],
          };
        }
      },
    );
    const errors = perGroupOutcome.flatMap((o) => o.errors);
    const unreadable = perGroupOutcome.flatMap((o) => o.unreadable);
    const unreadableKeys = new Set(unreadable);
    const augmented = desired.map((d) => {
      if (d.type !== "group" || d.dynamic === undefined) return d;
      // Actual side unknown → leave the desired side unfolded so nothing diffs. `buildPlan` turns
      // the key into a fetch-failed no-op, which is the honest rendering of "I could not read this".
      if (unreadableKeys.has(d.key)) return d;
      // Demote-to-none: fold to the SAME sentinel the actual side uses for a non-dynamic group
      // ({ status: "none", ruleset: {} }). The docs tell users to KEEP the dynamic block when
      // demoting, so their authored ruleset is still present here — but folding it would diff
      // forever against the sentinel actual. Collapsing both sides makes a demoted group converge.
      if (d.dynamic.status === "none") {
        return { ...d, fields: { ...d.fields, dynamic: { status: "none" as DynamicStatus, ruleset: {} } } };
      }
      const resolvedRuleset = resolveRulesetRef(d.dynamic.ruleset, configDir, d.key);
      // Un-portablized ids report at PLAN time too (#101), not only at adoption. A ruleset carrying
      // another host's ids round-trips byte-identically against the host it was written for, so the
      // plan is green and the damage — an auto-group collecting the wrong people — is invisible until
      // someone notices the membership. Warn, never fail: the numeric form stays a valid escape hatch.
      const unportable = scanUnportablized(resolvedRuleset);
      if (unportable.length > 0) {
        warn(
          `dynamic group "${d.key}": ruleset carries ${unportable.length} host-specific id(s) — ` +
            `not portable to another instance:`,
        );
        for (const line of formatPortablizeWarnings(unportable)) info(`    ${line}`);
      }
      const dynamic = normalizeDynamic({ status: d.dynamic.status, ruleset: resolvedRuleset });
      return { ...d, fields: { ...d.fields, dynamic } };
    });
    return { desired: augmented, errors, unreadable };
  },
  async apply({ client, id, change }) {
    const to = change.to as { status: DynamicStatus; ruleset: Record<string, unknown> } | undefined;
    const from = change.from as { status?: DynamicStatus; ruleset?: Record<string, unknown> } | undefined;
    if (!to || to.status === "none") {
      assertNotPeople(`/dynamicgroups/${id}/ruleset`);
      // A group that was never dynamic (or is already demoted) has no ruleset to delete — CT 404s.
      // Tolerate that: the desired end-state (no ruleset) already holds, so treat it as done.
      try {
        await client.request("DELETE", `/dynamicgroups/${id}/ruleset`);
      } catch (err) {
        if (!(err instanceof CtApiError && err.status === 404)) throw err;
      }
      assertNotPeople(`/dynamicgroups/${id}/status`);
      await client.request("PUT", `/dynamicgroups/${id}/status`, { dynamicGroupStatus: "none" });
      return;
    }
    // A pure status flip (active↔inactive) leaves the ruleset byte-identical — skip the re-PUT so we
    // don't rewrite an unchanged ruleset (wasteful, and may trigger a server-side recalculation). A
    // fresh promote (`from` undefined / previously non-dynamic) has no comparable ruleset, so PUT it.
    const rulesetChanged = from?.ruleset === undefined || !deepEqual(from.ruleset, to.ruleset);
    if (rulesetChanged) {
      assertNotPeople(`/dynamicgroups/${id}/ruleset`);
      await client.request("PUT", `/dynamicgroups/${id}/ruleset`, putRulesetBody(to.ruleset));
    }
    assertNotPeople(`/dynamicgroups/${id}/status`);
    await client.request("PUT", `/dynamicgroups/${id}/status`, { dynamicGroupStatus: to.status });
  },
  async postApply({ client, id, item, change }) {
    // `ct apply --refresh`: materialize computed membership for a changed dynamic group. Per-group
    // only — the all-groups /dynamicgroups/refresh endpoint has a huge blast radius and is never
    // called from here. Owns the demote-sentinel knowledge so the command layer stays field-agnostic.
    const to = change.to as { status?: string } | undefined;
    if (to?.status === "none") return; // demoted to a non-dynamic group — nothing to refresh
    const path = `/dynamicgroups/${id}/refresh`;
    assertNotPeople(path);
    try {
      const res = await client.request<RefreshResult[]>("POST", path);
      const r = res?.[0];
      if (r) info(`refreshed ${item.key}: +${r.created} ~${r.updated} -${r.deleted}`);
    } catch (err) {
      warn(`Failed to refresh ${item.key} (#${id}): ${formatError(err)}`);
    }
  },
};

/**
 * Registration ORDER IS APPLY ORDER (#135). Each fold appends its pseudo-fields to the desired bag,
 * `diffFields` walks that bag in insertion order, and `applySyntheticFields` walks the resulting
 * changes in order — so member fields are created before the same group's dynamic ruleset is
 * installed, which is exactly what lets a ruleset reference a field created in the same run.
 */
export const SYNTHETIC_FIELDS: SyntheticField[] = [parentsField, memberFieldsField, dynamicField];

const BY_FIELD = new Map(SYNTHETIC_FIELDS.map((f) => [f.field, f]));
/** Entries owning a whole prefix family (`memberField:<key>`) rather than one fixed field name. */
const BY_PREFIX = SYNTHETIC_FIELDS.filter(
  (f): f is SyntheticField & { prefix: string } => typeof f.prefix === "string",
);
export function isSyntheticField(field: string): boolean {
  return syntheticField(field) !== undefined;
}
export function syntheticField(field: string): SyntheticField | undefined {
  return BY_FIELD.get(field) ?? BY_PREFIX.find((f) => field.startsWith(f.prefix));
}

/**
 * Drive every synthetic field's optional `postApply` hook over an applied plan (e.g. the opt-in
 * `ct apply --refresh` dynamic-group refresh). Runs after `executePlan`, so ids are read from the
 * POST-execute state — a create already carries its real id. Skips no-op/delete items and any item
 * whose key is not (yet) resolvable in state (explicit `undefined` check — CT ids can be `0`). Each
 * hook swallows its own errors, so one field/group failing never blocks the rest.
 */
export async function runPostApplyHooks(
  plan: Plan,
  state: State,
  client: Pick<CtClient, "request">,
): Promise<void> {
  for (const item of plan.items) {
    if (item.action === "no-op" || item.action === "delete") continue;
    for (const change of item.changes) {
      const f = syntheticField(change.field);
      if (!f?.postApply) continue;
      const id = state.resources[item.key]?.id;
      if (id === undefined) continue;
      await f.postApply({ client, state, id, item, change });
    }
  }
}

/** Run every registered fold in order, threading the (immutably) augmented desired through each. */
export async function foldSynthetic(
  ctx: SyntheticFoldCtx,
): Promise<{ desired: DesiredResource[]; errors: string[]; unreadable: Set<string> }> {
  let desired = ctx.desired;
  const errors: string[] = [];
  const unreadable = new Set<string>();
  for (const f of SYNTHETIC_FIELDS) {
    const res = await f.fold({ ...ctx, desired });
    desired = res.desired;
    errors.push(...res.errors);
    for (const key of res.unreadable ?? []) unreadable.add(key);
  }
  return { desired, errors, unreadable };
}
