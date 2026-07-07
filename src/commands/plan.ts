import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { CtApiError } from "../api/ctClient.js";
import { resolveConfig } from "../config.js";
import { RESOURCES } from "../resources/registry.js";
import { loadState, resolveStatePath } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { computePlan } from "../engine/plan.js";
import { renderPlan } from "../engine/render.js";
import { parentIdsByGroupId, applyHierarchy, type HierarchyEntry } from "../engine/hierarchy.js";
import { mapConcurrent } from "../util/concurrency.js";
import { info, warn, out } from "../ui.js";

interface PlanOptions {
  config?: string;
  state?: string;
  json?: boolean;
}

/** How many managed resources to fetch from ChurchTools at once. */
const FETCH_CONCURRENCY = 8;

export function planCommand(): Command {
  return new Command("plan")
    .description("Show the diff between the desired-state config and ChurchTools (read-only)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("--json", "emit the raw plan as JSON instead of the rendered diff")
    .action(async (opts: PlanOptions) => {
      const config = resolveConfig();
      const configPath = resolveConfigPath(opts.config);
      const desired = await loadConfig(configPath);
      const state = await loadState(resolveStatePath(opts.state), config.host);
      if (state.host !== config.host) {
        throw new Error(`State host (${state.host}) does not match CT_HOST (${config.host}).`);
      }

      const { client } = await authedSession();
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

      // Group hierarchy: one bulk call, folded into each managed group's `parents` set-field.
      let parentIds = new Map<number, number[]>();
      const hasManagedGroups = Object.values(state.resources).some((m) => m.type === "group");
      if (hasManagedGroups) {
        try {
          const raw = await client.get<HierarchyEntry[]>("/groups/hierarchies");
          parentIds = parentIdsByGroupId(Array.isArray(raw) ? raw : []);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          fetchErrors.push(`group hierarchies: ${message}`);
          warn(`Failed to fetch group hierarchies: ${message}`);
        }
      }
      const desiredWithHierarchy = applyHierarchy(desired, state, actual, parentIds);

      const plan = computePlan(desiredWithHierarchy, state, actual, { unresolved });
      if (opts.json) {
        out(plan);
      } else {
        info(`config: ${configPath} · state host: ${state.host}`);
        process.stdout.write(`${renderPlan(plan)}\n`);
      }

      if (fetchErrors.length > 0) {
        warn(
          `Plan is INCOMPLETE — ${fetchErrors.length} resource(s) could not be fetched; their diff is missing. Re-run to retry.`,
        );
        process.exitCode = 1;
      }
    });
}
