/**
 * Shared plan building: fetch the actual ChurchTools values of every managed
 * resource, fold group hierarchy into a `parents` set-field, and diff against
 * the desired config + state. Used by both `ct plan` and `ct apply`, so apply
 * fetches exactly once (its `actual` map is reused for the backup).
 */
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import type { DesiredResource, Plan } from "./types.js";
import { RESOURCES } from "../resources/registry.js";
import { computePlan } from "./plan.js";
import { parentIdsByGroupId, applyHierarchy, type HierarchyEntry } from "./hierarchy.js";
import { mapConcurrent } from "../util/concurrency.js";
import { warn } from "../ui.js";

/** How many managed resources to fetch from ChurchTools at once. */
const FETCH_CONCURRENCY = 8;

export interface BuildResult {
  plan: Plan;
  actual: Map<string, Record<string, unknown>>;
  fetchErrors: string[];
}

export async function buildPlan(
  client: Pick<CtClient, "get">,
  state: State,
  desired: DesiredResource[],
): Promise<BuildResult> {
  // Keyed by logical key (globally unique), not CT id (unique only within a type — the Mainz campus is id 0).
  const actual = new Map<string, Record<string, unknown>>();
  const unresolved = new Set<string>();
  const fetchErrors: string[] = [];

  await mapConcurrent(Object.values(state.resources), FETCH_CONCURRENCY, async (managed) => {
    const spec = RESOURCES[managed.type];
    if (!spec) {
      unresolved.add(managed.key);
      warn(
        `No registry entry for managed type "${managed.type}" (${managed.type}.${managed.key} #${managed.id}) — cannot diff; leaving untouched.`,
      );
      return;
    }
    try {
      const raw = await client.get<Record<string, unknown>>(spec.itemPath(managed.id));
      actual.set(managed.key, spec.managedFields(raw));
    } catch (err) {
      if (err instanceof CtApiError && err.status === 404) {
        return; // vanished in CT — the plan will propose recreating (or pruning) it
      }
      // A read-only plan should not abort on one bad fetch: record it, keep going, flag the plan as partial.
      const message = err instanceof Error ? err.message : String(err);
      fetchErrors.push(`${managed.type}.${managed.key} (#${managed.id}): ${message}`);
      warn(`Failed to fetch ${managed.type}.${managed.key} (#${managed.id}): ${message}`);
    }
  });

  // Group hierarchy: one bulk call, folded into each opted-in group's `parents` set-field.
  let parentIds = new Map<number, number[]>();
  let hierarchyOk = true;
  const hasManagedGroups = Object.values(state.resources).some((m) => m.type === "group");
  if (hasManagedGroups) {
    try {
      const raw = await client.get<HierarchyEntry[]>("/groups/hierarchies");
      parentIds = parentIdsByGroupId(Array.isArray(raw) ? raw : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fetchErrors.push(`group hierarchies: ${message}`);
      warn(`Failed to fetch group hierarchies: ${message}`);
      hierarchyOk = false;
    }
  }
  // On a hierarchy-fetch failure, leave `parents` undiffed rather than folding an empty map
  // (which would fabricate spurious "add all parents" changes). The plan is flagged INCOMPLETE.
  const desiredWithHierarchy = hierarchyOk ? applyHierarchy(desired, state, actual, parentIds) : desired;
  const plan = computePlan(desiredWithHierarchy, state, actual, { unresolved });
  return { plan, actual, fetchErrors };
}
