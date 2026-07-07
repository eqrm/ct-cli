import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { CtApiError } from "../api/ctClient.js";
import { resolveConfig } from "../config.js";
import { RESOURCES } from "../resources/registry.js";
import { loadState, resolveStatePath } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { computePlan } from "../engine/plan.js";
import { renderPlan } from "../engine/render.js";
import { info, warn, out } from "../ui.js";

interface PlanOptions {
  config?: string;
  state?: string;
  json?: boolean;
}

export function planCommand(): Command {
  return new Command("plan")
    .description("Show the diff between the desired-state config and ChurchTools (read-only)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("--json", "emit the raw plan as JSON instead of the rendered diff")
    .action(async (opts: PlanOptions) => {
      const config = resolveConfig();
      const desired = await loadConfig(resolveConfigPath(opts.config));
      const state = await loadState(resolveStatePath(opts.state), config.host);
      if (state.host !== config.host) {
        throw new Error(`State host (${state.host}) does not match CT_HOST (${config.host}).`);
      }

      const { client } = await authedSession();
      const actualById = new Map<number, Record<string, unknown>>();
      for (const managed of Object.values(state.resources)) {
        const spec = RESOURCES[managed.type];
        if (!spec) {
          warn(`No registry entry for managed type "${managed.type}" (#${managed.id}) — skipping.`);
          continue;
        }
        try {
          const raw = await client.get<Record<string, unknown>>(spec.itemPath(managed.id));
          actualById.set(managed.id, spec.managedFields(raw));
        } catch (err) {
          if (err instanceof CtApiError && err.status === 404) {
            continue; // vanished in CT — the plan will propose recreating it
          }
          throw err;
        }
      }

      const plan = computePlan(desired, state, actualById);
      if (opts.json) {
        out(plan);
        return;
      }
      info(`config: ${resolveConfigPath(opts.config)} · state host: ${state.host}`);
      process.stdout.write(`${renderPlan(plan)}\n`);
    });
}
