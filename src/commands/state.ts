import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { prepareEnv } from "../env/context.js";
import { loadState, saveState } from "../state/state.js";
import { resourceType } from "../resources/registry.js";
import { collectRefs, isRef, type Ref } from "../resolve/refs.js";
import { info, out, success, warn } from "../ui.js";

interface StateOptions {
  state?: string;
  env?: string;
}

interface StateRmOptions extends StateOptions {
  config?: string;
  force?: boolean;
  dryRun?: boolean;
}

export function stateCommand(): Command {
  const cmd = new Command("state").description("Inspect the managed-resource state file");

  cmd
    .command("list")
    .description("List every resource under management (JSON to stdout)")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .action(async (opts: StateOptions) => {
      const cmdEnv = await prepareEnv(opts);
      const statePath = cmdEnv.statePath;
      const state = await loadState(statePath, (await resolveConfig()).host);
      const resources = Object.values(state.resources);
      info(`${resources.length} managed resource(s) in ${statePath} (host ${state.host}).`);
      out(resources);
    });

  // `ct state rm` — the missing inverse of `ct adopt` (#122).
  //
  // `ct adopt` writes an entry; nothing removed one. `ct destroy` is the opposite of what un-adopting
  // means (it deletes the resource IN ChurchTools), so backing out an adoption meant hand-editing
  // `ct-state.<env>.json` with a text editor or a `node -e` one-liner — the very file the tool
  // insists is its own. Adopt-then-declare is the documented loop, so an adoption that turns out to
  // be wrong is normal rather than exotic; leaving the entry in makes `plan` report a DESTROY for a
  // resource where nothing is wrong, and the offline config-matches-state check cannot be satisfied
  // without editing the file the check is checking.
  cmd
    .command("rm")
    .description("Un-adopt: remove a resource from the state file. Never touches ChurchTools.")
    .argument("<type>", "resource type, e.g. campus | group | group-role")
    .argument("<key>", "logical key of the entry to remove")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("-c, --config <path>", "config file to check the key against (or set CT_CONFIG)")
    .option("--force", "remove even though the key is still declared in the config")
    .option("--dry-run", "report what would be removed without writing")
    .action(async (type: string, key: string, opts: StateRmOptions) => {
      // Validate the type against the registry first, so a typo is a clear error rather than a
      // confusing "not in state" for an entry that could never have existed.
      resourceType(type);

      const cmdEnv = await prepareEnv(opts);
      const statePath = cmdEnv.statePath;
      const state = await loadState(statePath, (await resolveConfig()).host);

      const entry = state.resources[key];
      if (!entry) {
        throw new Error(`No entry "${key}" in ${statePath}. List them with \`ct state list\`.`);
      }
      if (entry.type !== type) {
        throw new Error(
          `"${key}" in ${statePath} is a ${entry.type} (#${entry.id}), not a ${type}. ` +
            `Pass the right type, or list them with \`ct state list\`.`,
        );
      }

      // Removing an entry the config still declares turns the next plan into a CREATE for a resource
      // that already exists on the host — which then 400s on a duplicate name, or worse, succeeds and
      // leaves a second copy. So it is refused by default; --force is there for the case where the
      // declaration is being deleted in the same change.
      if (!opts.force) {
        const declared = await declaredKeys(opts.config);
        if (declared?.has(key)) {
          throw new Error(
            `"${key}" is still declared in the config, so removing it from state would make the next ` +
              `plan propose CREATING a resource that already exists on this host. Remove the ` +
              `declaration first, or pass --force if you are deleting both in the same change.`,
          );
        }
      }

      if (opts.dryRun) {
        info(`Would remove ${entry.type}.${key} (#${entry.id}) from ${statePath}.`);
        return;
      }

      delete state.resources[key];
      await saveState(statePath, state);
      success(`Removed ${entry.type}.${key} (#${entry.id}) from ${statePath}.`);
      // The single most important thing to say: nothing happened in ChurchTools. Someone reaching for
      // this command has usually just been told that `ct destroy` is the wrong tool.
      info(
        `ChurchTools was not contacted — #${entry.id} still exists there, now unmanaged. ` +
          `Re-adopt it with \`ct adopt ${type} ${entry.id}\`.`,
      );
    });

  return cmd;
}

/**
 * The logical keys the config declares, or `undefined` when the config cannot be read.
 *
 * A missing/broken config must not block an un-adopt: backing out an adoption is exactly what you do
 * when the config is mid-edit. So a load failure downgrades the guard to a warning rather than
 * failing the command.
 */
/**
 * Every logical key the config still names — as a declared resource, AND as a reference from a
 * permission declaration.
 *
 * The permission half matters because a key can be referenced without being declared as a resource in
 * the same breath: a `ct.groupRole({ group: "<key>" })` domain, or a group-dimension
 * `scope: ["<key>"]`. Removing such a key from state passes a resources-only guard and then hard-errors
 * on the next `ct plan` in `resolveScope` ("does not resolve to a managed group") — which is precisely
 * the broken-config outcome this guard exists to catch before the write, not after it.
 *
 * Embedded `{ __ctRef }` markers are collected structurally, so a new referencing position is covered
 * the day it is added; compound refs contribute the key they actually name (`group-role` a group,
 * `group-type-role` a group type). The scope sugar (`{ group: "x" }`) and the bare-string group key
 * are NOT refs, so they are picked up explicitly — leniently, since a malformed entry is `ct plan`'s
 * to report, and this guard must not turn it into a failure to read the config at all.
 */
async function declaredKeys(configOpt: string | undefined): Promise<Set<string> | undefined> {
  try {
    const { resources, permissions } = await loadConfig(resolveConfigPath(configOpt));
    const keys = new Set(resources.map((r) => r.key));
    const addRef = (r: Ref): void => {
      if (r.kind === "group-role") keys.add(r.group);
      else if (r.kind === "group-type-role") keys.add(r.groupType);
      // A group-scoped member field (#135) is owned by a group, so the key it keeps alive is that
      // group's — the field itself has no state entry of its own.
      else if (r.kind === "group-member-field") keys.add(r.group);
      else keys.add(r.key);
    };
    for (const ref of collectRefs(permissions)) addRef(ref);
    for (const p of permissions) {
      for (const g of p.grants) {
        if (typeof g === "string" || !Array.isArray(g.scope)) continue;
        for (const entry of g.scope) {
          // A bare string is a logical GROUP key; one-field sugar names a key on its dimension.
          if (typeof entry === "string" && entry.length > 0) keys.add(entry);
          else if (entry !== null && typeof entry === "object" && !isRef(entry)) {
            const values = Object.values(entry as Record<string, unknown>);
            if (values.length === 1 && typeof values[0] === "string" && values[0].length > 0) {
              keys.add(values[0]);
            }
          }
        }
      }
    }
    return keys;
  } catch (err) {
    warn(
      `Could not read the config to check whether "${configOpt ?? "the default config"}" still ` +
        `declares this key (${err instanceof Error ? err.message : String(err)}) — removing anyway.`,
    );
    return undefined;
  }
}
