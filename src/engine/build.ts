/**
 * Shared plan building: fetch the actual ChurchTools values of every managed
 * resource, fold synthetic sub-resource fields (group hierarchy's `parents`, …)
 * into the diff, and diff against the desired config + state. Used by both
 * `ct plan` and `ct apply`, so apply fetches exactly once (its `actual` map is
 * reused for the backup).
 */
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import type { ManagedResource, State } from "../state/state.js";
import type { DesiredResource, Plan } from "./types.js";
import { RESOURCES, type CtWriteClient } from "../resources/registry.js";
import { computePlan } from "./plan.js";
import { foldSynthetic } from "./synthetic.js";
import { Resolver } from "../resolve/resolver.js";
import { collectPendingRefKeys } from "../resolve/refs.js";
import { mapConcurrent } from "../util/concurrency.js";
import { warn, formatError } from "../ui.js";

/** How many managed resources to fetch from ChurchTools at once. */
const FETCH_CONCURRENCY = 8;

export interface BuildResult {
  plan: Plan;
  actual: Map<string, Record<string, unknown>>;
  fetchErrors: string[];
  /** Informational registry/portability warnings already printed to stderr. */
  warnings?: string[];
}

export interface FetchActualResult {
  /** Managed fields per logical key, for every resource that fetched cleanly (a 404 is omitted, not an error). */
  actual: Map<string, Record<string, unknown>>;
  /** Keys whose managed type has no registry entry — cannot be fetched/diffed, so left untouched. */
  unresolved: Set<string>;
  /** Keys whose fetch errored (non-404), mapped to a short status descriptor for the plan render. */
  fetchFailed: Map<string, string>;
  /** Human-readable fetch-error lines (non-404), one per failed key. */
  fetchErrors: string[];
  warnings?: string[];
}

/**
 * Fetch the actual ChurchTools values of a set of managed resources, concurrently.
 *
 * Shared by `buildPlan` (plan/apply) and `destroy` (its pre-delete backup) so the
 * two read actuals identically and cannot drift. A 404 means the resource vanished
 * in CT — omitted from `actual` (the plan recreates/prunes; the backup skips it).
 * A non-404 error is recorded (never thrown) so one bad fetch neither aborts a
 * read-only plan nor blocks tearing down the other targets.
 */
export async function fetchActual(
  client: Pick<CtClient, "get">,
  resources: readonly ManagedResource[],
): Promise<FetchActualResult> {
  const actual = new Map<string, Record<string, unknown>>();
  const unresolved = new Set<string>();
  const fetchFailed = new Map<string, string>();
  const fetchErrors: string[] = [];
  const warnings: string[] = [];

  await mapConcurrent(resources, FETCH_CONCURRENCY, async (managed) => {
    const spec = RESOURCES[managed.type];
    if (!spec) {
      unresolved.add(managed.key);
      const warning = `No registry entry for managed type "${managed.type}" (${managed.type}.${managed.key} #${managed.id}) — cannot diff; leaving untouched.`;
      warnings.push(warning);
      warn(warning);
      return;
    }
    try {
      // A type with no `GET {itemPath}` (#108: Bereiche have only the collection) reads through its
      // own `fetchOne`, which returns null for "genuinely absent" — the same meaning a 404 carries
      // below. Without this the default read 404s on every plan and the resource looks vanished, so
      // apply proposes creating it again forever.
      const raw = spec.fetchOne
        ? await spec.fetchOne(client as CtWriteClient, managed.id)
        : await client.get<Record<string, unknown>>(spec.itemPath(managed.id));
      if (raw === null) return; // absent in CT — same handling as a 404
      actual.set(managed.key, spec.managedFields(raw));
    } catch (err) {
      if (err instanceof CtApiError && err.status === 404) {
        return; // vanished in CT — the plan will propose recreating (or pruning) it
      }
      // A read-only plan should not abort on one bad fetch: record it, keep going, flag the plan as partial.
      // Track the key separately from a real 404 so computePlan renders it as a fetch failure, not a recreate.
      const message = formatError(err);
      const status = err instanceof CtApiError ? String(err.status) : "error";
      fetchFailed.set(managed.key, status);
      fetchErrors.push(`${managed.type}.${managed.key} (#${managed.id}): ${message}`);
      warn(`Failed to fetch ${managed.type}.${managed.key} (#${managed.id}): ${message}`);
    }
  });

  return {
    actual,
    unresolved,
    fetchFailed,
    fetchErrors,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export interface BuildOptions {
  /** Directory of the config file — `{ ref }` ruleset paths resolve relative to it (not the cwd). */
  configDir?: string;
  /**
   * Shared per-host reference resolver (#20). The command layer constructs ONE instance and passes
   * it to both `buildPlan` and `buildPermissionPlan` (they run concurrently) so each master-data
   * catalog is fetched at most once per run. Omitted → a private resolver is built from this call's
   * client/state/desired (fine for tests and single-surface use).
   */
  resolver?: Resolver;
}

export async function buildPlan(
  client: Pick<CtClient, "get">,
  state: State,
  desired: DesiredResource[],
  opts: BuildOptions = {},
): Promise<BuildResult> {
  // Keyed by logical key (globally unique), not CT id (unique only within a type — the Mainz campus is id 0).
  const {
    actual,
    unresolved,
    fetchFailed,
    fetchErrors,
    warnings: fetchWarnings = [],
  } = await fetchActual(client, Object.values(state.resources));

  // Synthetic sub-resource fields (parents, dynamic, …) fold into the diff on both sides.
  const folded = await foldSynthetic({ client, state, desired, actual, configDir: opts.configDir });
  fetchErrors.push(...folded.errors);
  // A synthetic field whose ACTUAL side could not be read makes its resource undiffable, exactly
  // like a failed top-level GET. Marking it fetch-failed is what stops a transient 429 on
  // `/dynamicgroups/{id}/ruleset` from surfacing as a fabricated `to update` (#126).
  for (const key of folded.unreadable) {
    if (!fetchFailed.has(key)) fetchFailed.set(key, "sub-resource read failed");
  }

  // Resolution pass (#20): rewrite Ref-valued fields (and the dynamic ruleset, walked deeply) to
  // numbers / pending markers AFTER folding, BEFORE computePlan — so the diff stays number↔number.
  // Unknown/ambiguous refs THROW here (a config error, not a degrade-and-continue fetch error).
  const resolver = opts.resolver ?? new Resolver({ client, state, desired });
  const resolved = await Promise.all(
    folded.desired.map(async (d) => {
      const fields = await resolver.resolveValue(d.fields, `${d.type} "${d.key}"`);
      return fields === d.fields ? d : { ...d, fields: fields as Record<string, unknown> };
    }),
  );

  // A pending ref names a resource created in this same run, but tier ordering alone doesn't put
  // the target first when both share a tier (e.g. a group's ruleset ref.group()-ing another group:
  // declaration order would apply the referencer first and the pending id could never resolve).
  // Inject the dependency edge so orderKeys sequences the target before the referencer.
  const desiredKeys = new Set(resolved.map((d) => d.key));
  const ordered = resolved.map((d) => {
    const targets = [
      ...new Set(collectPendingRefKeys(d.fields).filter((k) => k !== d.key && desiredKeys.has(k))),
    ].filter((k) => !d.dependsOn.includes(k));
    return targets.length === 0 ? d : { ...d, dependsOn: [...d.dependsOn, ...targets] };
  });

  const plan = computePlan(ordered, state, actual, { unresolved, fetchFailed });
  const warnings = [...fetchWarnings, ...(folded.warnings ?? [])];
  return { plan, actual, fetchErrors, ...(warnings.length > 0 ? { warnings } : {}) };
}
