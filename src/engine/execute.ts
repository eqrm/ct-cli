/**
 * The executor: walk a computed plan and make it real. Field-agnostic — every
 * resource's write path/verb comes from the registry, so adding a type never
 * touches this file. State is saved after each successful action, so a crash
 * mid-apply leaves a consistent, resumable state file.
 *
 * apply NEVER deletes: delete items are recorded and skipped. Synthetic
 * sub-resource fields (group hierarchy's `parents`, …) are reconciled through
 * their own dedicated endpoints, not the owning resource's body — see synthetic.ts.
 */
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import type { ManagedResource, State } from "../state/state.js";
import { upsert, saveState } from "../state/state.js";
import type { FieldChange, Plan, PlanItem } from "./types.js";
import { RESOURCES, type CtWriteClient } from "../resources/registry.js";
import { assertNotPeople } from "./guard.js";
import { isSyntheticField, syntheticField } from "./synthetic.js";
import { reresolvePendingValue } from "../resolve/resolver.js";
import { hasPendingRef } from "../resolve/refs.js";
import { formatError } from "../ui.js";

/**
 * The messageKey CT's `POST /groups` 400s with when a same-named group already exists and the
 * body did not carry `force: true` (#75). Confirmed against the ChurchTools OpenAPI spec's
 * analogous `POST /persons` duplicate-guard error envelope (`forbidden.duplicate.person`, the
 * same `{ message, messageKey, translatedMessage, args, errors }` shape) and the live 400 text
 * observed against a dev rehearsal instance (issue #75): "Duplicate found. Use force flag to
 * create group with same name." `POST /groups` itself is undocumented beyond "Bad Request" in the
 * spec, so both the messageKey AND a text fallback are checked below.
 */
const DUPLICATE_GROUP_MESSAGE_KEY = "forbidden.duplicate.group";

/** Detect CT's same-name group-creation guard (#75) from a caught create error. */
function isDuplicateGroupNameError(err: unknown): boolean {
  if (!(err instanceof CtApiError) || err.status !== 400) return false;
  const body = err.body;
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.messageKey === DUPLICATE_GROUP_MESSAGE_KEY) return true;
  const message = b.message;
  return (
    typeof message === "string" &&
    /duplicate/i.test(message) &&
    /force flag/i.test(message) &&
    /group/i.test(message)
  );
}

/**
 * Append actionable guidance (#75) to an otherwise-formatted stop message when a group create
 * failed on CT's same-name guard without the `allowDuplicateName` opt-in: point at adopting the
 * existing group (the usual accident) or opting in (the rare intentional-duplicate case). Reuses
 * `formatError`'s output verbatim — never forks the HTTP status/body formatting.
 */
function withDuplicateGroupGuidance(message: string, item: PlanItem): string {
  return (
    `${message}\n` +
    `Guidance: a group named like "${item.key}" likely already exists in ChurchTools. If it should ` +
    `be managed by this tool, adopt it instead of creating a new one: ` +
    `\`ct adopt group <id> --env <env> --key ${item.key}\` (find its id with \`ct get groups\`). ` +
    `If two groups sharing this name is intentional, set \`allowDuplicateName: true\` on this ` +
    `group's declaration and re-apply`
  );
}

export interface ExecuteDeps {
  client: Pick<CtClient, "request">;
  state: State;
  statePath: string;
  now?: () => string;
  save?: (path: string, state: State) => Promise<void>;
}

export interface ExecuteResult {
  created: string[];
  updated: string[];
  skippedDeletes: string[];
  failed?: { key: string; message: string };
}

/** Mirror the config's `preventDestroy` onto a state entry (kept absent, not `false`, when unset). */
function mirrorPreventDestroy(entry: ManagedResource, flag: boolean | undefined): void {
  if (flag) entry.preventDestroy = true;
  else delete entry.preventDestroy;
}

/** The managed field snapshot after a write: base ∪ changed fields, minus any synthetic sub-resource fields. */
function snapshotFromChanges(base: Record<string, unknown>, changes: FieldChange[]): Record<string, unknown> {
  const snap = { ...base };
  for (const c of changes) if (!isSyntheticField(c.field)) snap[c.field] = c.to;
  for (const f of Object.keys(snap)) if (isSyntheticField(f)) delete snap[f];
  return snap;
}

/**
 * Apply every synthetic sub-resource field of one item, IN CHANGE ORDER.
 *
 * Each change's pending references are re-resolved immediately BEFORE that change is applied, not
 * once up front (#135). That matters because synthetic fields on one resource can depend on each
 * other: a group's member fields are created here, and the same group's dynamic ruleset — the next
 * change in the same loop — may name one of them by its portable `<group>::<field>` identity. Up-front
 * re-resolution would look for an id that the very next statement is about to mint. The write BODY is
 * still built from the up-front re-resolved changes in `executePlan`; only synthetic writes are late-bound.
 */
async function applySyntheticFields(
  client: Pick<CtClient, "request">,
  state: State,
  id: number,
  key: string,
  changes: FieldChange[],
): Promise<void> {
  for (const c of changes) {
    const f = syntheticField(c.field);
    if (!f) continue;
    const change = hasPendingRef(c.to) ? { ...c, to: reresolvePendingValue(c.to, state) } : c;
    await f.apply({ client, state, id, key, change });
  }
}

export async function executePlan(plan: Plan, deps: ExecuteDeps): Promise<ExecuteResult> {
  const { client, state, statePath } = deps;
  // Re-resolve every pending logical reference (#20) in an item's changes against the current state,
  // up front — so both the write body AND synthetic-field writes (a dynamic ruleset's `var` value can
  // reference a same-run resource) see real ids, never a pending sentinel. Tier ordering guarantees a
  // referenced target (e.g. a same-run campus, tier 0) is already in state by the time its referencer
  // (a group, tier 1) applies. No-op when nothing is pending.
  // SYNTHETIC fields are deliberately excluded here and late-bound instead (#135): their writes can
  // depend on state an earlier synthetic write on the SAME item produces (a group's dynamic ruleset
  // naming a member field created moments earlier in that item), so resolving them up front would
  // look for an id that has not been minted yet. `applySyntheticFields` re-resolves each of them
  // immediately before applying it.
  const reresolveChanges = (changes: FieldChange[]): FieldChange[] =>
    changes.map((c) =>
      !isSyntheticField(c.field) && hasPendingRef(c.to)
        ? { ...c, to: reresolvePendingValue(c.to, state) }
        : c,
    );
  const now = deps.now ?? (() => new Date().toISOString());
  const save = deps.save ?? saveState;
  const created: string[] = [];
  const updated: string[] = [];
  const skippedDeletes: string[] = [];

  for (const item of plan.items) {
    if (item.action === "delete") {
      skippedDeletes.push(item.key);
      continue;
    }
    if (item.action === "no-op") {
      // A preventDestroy toggle alone yields a no-op plan (the flag is never a diffed field),
      // so reconcile it here too — otherwise adding protection wouldn't reach state until some
      // other field changed. Only clean (note-less) no-ops are desired-side and safe to touch;
      // stale/unresolved/fetch-failed no-ops are delete-side or undiffable — leave them alone.
      const entry = state.resources[item.key];
      if (!item.note && entry && entry.preventDestroy !== (item.preventDestroy || undefined)) {
        mirrorPreventDestroy(entry, item.preventDestroy);
        await save(statePath, state);
      }
      continue;
    }
    const spec = RESOURCES[item.type];
    if (!spec) {
      return {
        created,
        updated,
        skippedDeletes,
        failed: { key: item.key, message: `No write spec for type "${item.type}".` },
      };
    }

    try {
      // Resolve any same-run pending references now that earlier tiers have applied (see above).
      const changes = reresolveChanges(item.changes);
      if (item.action === "create") {
        const body = snapshotFromChanges({}, changes);
        // CT requires fields at CREATE that the tool does not manage for diffing (#73). Merge the
        // registry's deterministic create-defaults UNDER the declared body (declared values always
        // win) for the POST ONLY. State still records `body` (the managed fields), so the defaults
        // stay unmanaged — a later plan neither diffs nor reverts them. A field still missing after
        // this surfaces as CT's HTTP 400 (#71), not a silent omission.
        // `{ ...body }` last so a DECLARED value always wins — but an explicitly-`undefined` declared
        // field must not knock out a default CT requires (that turns into an HTTP 400 at create for
        // no reason), so undefined entries are dropped from the winning side.
        const declared = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
        const defaultedBody = spec.createDefaults ? { ...spec.createDefaults(body), ...declared } : body;
        // CT's same-name group-creation guard (#75): opt-in only, via `force: true` on the POST body.
        // Never a managed field — not in `body`/state, so it never diffs and never touches update.
        const createBody = item.allowDuplicateName ? { ...defaultedBody, force: true } : defaultedBody;
        // A caller-assigned-id type (#110: security levels) POSTs to the DECLARED id, not the
        // collection — `createPath` reads it out of the body. Everything else posts to the collection.
        const createTarget = spec.createPath ? spec.createPath(createBody) : spec.collectionPath;
        assertNotPeople(createTarget);
        // A type whose writes are not REST (#108: Bereiche, via the legacy master-data endpoint)
        // supplies its own writer and returns the new id itself. Everything else POSTs.
        let newId: number;
        if (spec.writer) {
          newId = await spec.writer.create({ client: client as CtWriteClient, body: createBody });
        } else {
          const res = await client.request<{ id: number }>("POST", createTarget, createBody);
          newId = res.id;
        }
        if (typeof newId !== "number") {
          throw new Error(`create returned no numeric id (got ${JSON.stringify(newId)})`);
        }
        const res = { id: newId };
        // A "recreate" create item (resource vanished from CT but still in state) leaves the
        // stale entry — with the *old* id — under this key. upsert would read the new id as a
        // key collision and throw, so the just-created resource never lands in state and every
        // re-run POSTs another duplicate. Drop the stale entry: a create owns its key outright.
        delete state.resources[item.key];
        upsert(state, { type: item.type, id: res.id, key: item.key, fields: body }, now());
        mirrorPreventDestroy(state.resources[item.key]!, item.preventDestroy);
        await save(statePath, state);
        // Raw `item.changes`, not the up-front re-resolved copy: synthetic writes are late-bound so
        // one can see state another just produced (see applySyntheticFields).
        await applySyntheticFields(client, state, res.id, item.key, item.changes);
        // Synthetic writes can add to the state entry (member-field ids, #135) — persist that too,
        // so a crash after this point does not lose the id↔identity mapping.
        await save(statePath, state);
        created.push(item.key);
      } else {
        const id = item.id;
        if (id === null) {
          throw new Error("update item has no id");
        }
        // Base the write body on the FETCHED ACTUAL, not the stale state snapshot: a field that
        // drifted in the CT UI but isn't in `changes` must pass through, never be reverted (#27).
        // The post-write snapshot (actual ∪ changes) is what CT holds afterward, so state records
        // exactly that regardless of verb.
        const actualFields = item.actual ?? state.resources[item.key]?.fields ?? {};
        const snapshot = snapshotFromChanges(actualFields, changes);
        const hasFieldChange = changes.some((c) => !isSyntheticField(c.field));
        if (hasFieldChange) {
          const path = spec.itemPath(id);
          assertNotPeople(path);
          if (spec.writer) {
            // Non-REST write path (#108). Always handed the FULL snapshot, never just the changed
            // fields: the legacy master-data endpoint writes the columns it is given and is closer to
            // a PUT than a PATCH, so sending a subset would blank the untouched ones.
            await spec.writer.update({ client: client as CtWriteClient, body: snapshot, id });
          } else {
            // PATCH resources take only the changed fields (unchanged/drifted siblings are left alone);
            // PUT resources replace the whole object, so send actual ∪ changes to preserve those siblings.
            const body = spec.updateMethod === "PATCH" ? snapshotFromChanges({}, changes) : snapshot;
            await client.request(spec.updateMethod, path, body);
          }
        }
        upsert(state, { type: item.type, id, key: item.key, fields: snapshot }, now());
        mirrorPreventDestroy(state.resources[item.key]!, item.preventDestroy);
        await save(statePath, state);
        await applySyntheticFields(client, state, id, item.key, item.changes);
        await save(statePath, state);
        updated.push(item.key);
      }
    } catch (err) {
      // Route through the same formatter the top-level handler uses (#50) so a mid-apply
      // CtApiError's HTTP status + response body survive into the "Stopped at" line (#71) —
      // without it, the stop message was undiagnosable ("... failed", no status/body).
      let message = formatError(err);
      // #75: a group create that hit CT's same-name guard without opting in gets actionable
      // guidance appended — most often this is an unmanaged existing group that should be
      // adopted, not an intentional duplicate.
      if (
        item.action === "create" &&
        item.type === "group" &&
        !item.allowDuplicateName &&
        isDuplicateGroupNameError(err)
      ) {
        message = withDuplicateGroupGuidance(message, item);
      }
      return {
        created,
        updated,
        skippedDeletes,
        failed: { key: item.key, message },
      };
    }
  }

  return { created, updated, skippedDeletes };
}
