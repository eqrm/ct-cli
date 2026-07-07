import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { loadState, resolveStatePath } from "../state/state.js";
import { info, out } from "../ui.js";

interface StateOptions {
  state?: string;
}

export function stateCommand(): Command {
  const cmd = new Command("state").description("Inspect the managed-resource state file");

  cmd
    .command("list")
    .description("List every resource under management (JSON to stdout)")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .action(async (opts: StateOptions) => {
      const statePath = resolveStatePath(opts.state);
      const state = await loadState(statePath, resolveConfig().host);
      const resources = Object.values(state.resources);
      info(`${resources.length} managed resource(s) in ${statePath} (host ${state.host}).`);
      out(resources);
    });

  return cmd;
}
