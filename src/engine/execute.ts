/**
 * The executor: walk a computed plan and make it real. Field-agnostic — every
 * resource's write path/verb comes from the registry, so adding a type never
 * touches this file. State is saved after each successful action, so a crash
 * mid-apply leaves a consistent, resumable state file.
 *
 * apply NEVER deletes: delete items are recorded and skipped. Group hierarchy is
 * reconciled through the parents endpoints, not the group body.
 */
import type { CtClient } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import { upsert, saveState } from "../state/state.js";
import type { FieldChange, Plan } from "./types.js";
import { RESOURCES } from "../resources/registry.js";
import { assertNotPeople } from "./guard.js";

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

/** The managed field snapshot after a write: base ∪ changed fields, minus the hierarchy `parents` set-field. */
function snapshotFromChanges(
  base: Record<string, unknown>,
  changes: FieldChange[],
): Record<string, unknown> {
  const snap = { ...base };
  for (const c of changes) {
    if (c.field !== "parents") {
      snap[c.field] = c.to;
    }
  }
  delete snap.parents;
  return snap;
}

function parentEdges(from: unknown, to: unknown): { added: string[]; removed: string[] } {
  const f = new Set(Array.isArray(from) ? (from as string[]) : []);
  const t = new Set(Array.isArray(to) ? (to as string[]) : []);
  return {
    added: [...t].filter((k) => !f.has(k)),
    removed: [...f].filter((k) => !t.has(k)),
  };
}

function resolveId(state: State, key: string): number {
  const managed = state.resources[key];
  if (!managed) {
    throw new Error(`Cannot resolve parent "${key}" — not under management yet.`);
  }
  return managed.id;
}

async function applyParentEdges(
  client: Pick<CtClient, "request">,
  state: State,
  childId: number,
  changes: FieldChange[],
): Promise<void> {
  const change = changes.find((c) => c.field === "parents");
  if (!change) {
    return;
  }
  const { added, removed } = parentEdges(change.from, change.to);
  for (const key of added) {
    const path = `/groups/${childId}/parents/${resolveId(state, key)}`;
    assertNotPeople(path);
    await client.request("PUT", path);
  }
  for (const key of removed) {
    const path = `/groups/${childId}/parents/${resolveId(state, key)}`;
    assertNotPeople(path);
    await client.request("DELETE", path);
  }
}

export async function executePlan(plan: Plan, deps: ExecuteDeps): Promise<ExecuteResult> {
  const { client, state, statePath } = deps;
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
      if (item.action === "create") {
        const body = snapshotFromChanges({}, item.changes);
        assertNotPeople(spec.collectionPath);
        const res = await client.request<{ id: number }>("POST", spec.collectionPath, body);
        if (typeof res.id !== "number") {
          throw new Error(`create returned no numeric id (got ${JSON.stringify(res.id)})`);
        }
        upsert(state, { type: item.type, id: res.id, key: item.key, fields: body }, now());
        await save(statePath, state);
        await applyParentEdges(client, state, res.id, item.changes);
        created.push(item.key);
      } else {
        const id = item.id;
        if (id === null) {
          throw new Error("update item has no id");
        }
        const base = state.resources[item.key]?.fields ?? {};
        const snapshot = snapshotFromChanges(base, item.changes);
        const hasFieldChange = item.changes.some((c) => c.field !== "parents");
        if (hasFieldChange) {
          const path = spec.itemPath(id);
          assertNotPeople(path);
          await client.request(spec.updateMethod, path, snapshot);
        }
        upsert(state, { type: item.type, id, key: item.key, fields: snapshot }, now());
        await save(statePath, state);
        await applyParentEdges(client, state, id, item.changes);
        updated.push(item.key);
      }
    } catch (err) {
      return {
        created,
        updated,
        skippedDeletes,
        failed: { key: item.key, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  return { created, updated, skippedDeletes };
}
