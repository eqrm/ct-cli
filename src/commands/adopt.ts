import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { resourceType, configSnippet } from "../resources/registry.js";
import { loadState, saveState, resolveStatePath, upsert } from "../state/state.js";
import { success, info, warn, out } from "../ui.js";

interface AdoptOptions {
  key?: string;
  state?: string;
  dryRun?: boolean;
}

export function adoptCommand(): Command {
  return new Command("adopt")
    .description("Put one existing ChurchTools resource under management (adds it to the state file)")
    .argument("<type>", "resource type, e.g. campus | group | group-type")
    .argument("<id>", "ChurchTools id of the resource")
    .option("-k, --key <key>", "logical key (defaults to a slug of the resource name)")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("--dry-run", "preview the config entry and state change without writing")
    .action(async (type: string, rawId: string, opts: AdoptOptions) => {
      const spec = resourceType(type);
      if (!/^\d+$/.test(rawId.trim())) {
        throw new Error(`Invalid id "${rawId}" — expected a non-negative integer.`);
      }
      const id = Number.parseInt(rawId, 10);

      // Load + validate the state file (host guard included) BEFORE any network
      // call, so a state file recorded against another instance never triggers a
      // live authenticated request against the wrong ChurchTools host.
      const config = resolveConfig();
      const statePath = resolveStatePath(opts.state);
      const state = await loadState(statePath, config.host);

      const { client } = await authedSession();
      const resource = await client.get<Record<string, unknown>>(spec.itemPath(id));

      const key = opts.key?.trim() || spec.deriveKey(resource);
      if (!key) {
        throw new Error("Could not derive a logical key — pass --key explicitly.");
      }
      const fields = spec.managedFields(resource);
      const snippet = configSnippet(type, key, fields);

      if (opts.dryRun) {
        info(`Would adopt ${type} #${id} as "${key}". Generated config entry:`);
        out({ key, type, id, fields, config: snippet });
        return;
      }

      const now = new Date().toISOString();
      const action = upsert(state, { type, id, key, fields }, now);
      await saveState(statePath, state);

      success(`${action === "created" ? "Adopted" : "Updated"} ${type} #${id} as "${key}" → ${statePath}`);
      info(`Config entry: ${snippet}`);
      if (action === "updated") {
        warn("This resource was already managed — its snapshot was refreshed.");
      }
    });
}
