import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { loadState, resolveStatePath } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { buildPlan } from "../engine/build.js";
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
      const configPath = resolveConfigPath(opts.config);
      const desired = await loadConfig(configPath);
      const state = await loadState(resolveStatePath(opts.state), config.host);
      if (state.host !== config.host) {
        throw new Error(`State host (${state.host}) does not match CT_HOST (${config.host}).`);
      }

      const { client } = await authedSession();
      const { plan, fetchErrors } = await buildPlan(client, state, desired);
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
