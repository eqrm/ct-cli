import { Command } from "commander";
import { listState, rekeyStateEntry, removeStateEntry } from "../application/operations/state.js";
import { info, out, success, warn } from "../ui.js";
import { confirmStateRemoval } from "./state-removal-confirmation.js";

interface StateOptions {
  state?: string;
  env?: string;
  managed?: boolean;
  external?: boolean;
}

interface StateRmOptions extends StateOptions {
  config?: string;
  force?: boolean;
  dryRun?: boolean;
  confirmEnv?: string;
  confirmKey?: string;
}

export function stateCommand(): Command {
  const cmd = new Command("state").description("Inspect managed and external ct-cli resource state");

  cmd
    .command("list")
    .description("List managed and external entries together (JSON to stdout)")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--managed", "show managed entries only")
    .option("--external", "show external entries only")
    .action(async (opts: StateOptions) => {
      const result = await listState({
        statePath: opts.state,
        environment: opts.env,
        managed: opts.managed,
        external: opts.external,
      });
      info(
        `${result.value.entries.length} state entr${result.value.entries.length === 1 ? "y" : "ies"} in ${result.project.stateDisplayPath} (host ${result.project.host}).`,
      );
      out(result.value.entries.map(({ kind, ownership, entry }) => ({ kind, ownership, ...entry })));
    });

  cmd
    .command("rm")
    .description("Remove a managed or external entry from state. Never touches ChurchTools.")
    .argument("<type>", "resource type, e.g. campus | group | group-role")
    .argument("<key>", "logical key of the entry to remove")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("-c, --config <path>", "config file to check the key against (or set CT_CONFIG)")
    .option("--force", "remove even though the key is still declared/referenced or config is unreadable")
    .option("--dry-run", "report what would be removed without writing")
    .option("--confirm-env <name>", "confirm a named environment non-interactively (must match --env)")
    .option(
      "--confirm-key <key>",
      "confirm a legacy project without --env non-interactively (must match the logical key)",
    )
    .action(async (type: string, key: string, opts: StateRmOptions) => {
      const request = {
        type,
        key,
        statePath: opts.state,
        environment: opts.env,
        configPath: opts.config,
        force: opts.force,
      } as const;
      const preview = await removeStateEntry({ ...request, dryRun: true });
      for (const warning of preview.warnings) warn(warning.message);
      const entry = preview.value.entry;
      if (opts.dryRun) {
        info(
          `Would remove ${preview.value.kind} ${entry.type}.${key} (#${entry.id}) from ${preview.project.stateDisplayPath}.`,
        );
        return;
      }
      warn(
        `About to remove ${preview.value.kind} ${entry.type}.${key} (#${entry.id}) from ` +
          `${preview.project.stateDisplayPath}. Prefer ct ${preview.value.kind === "managed" ? "unadopt" : "unuse"} for normal lifecycle changes.`,
      );
      const confirmed = await confirmStateRemoval(preview.project, key, {
        confirmEnv: opts.confirmEnv,
        confirmKey: opts.confirmKey,
      });
      if (!confirmed) {
        warn(`Aborted — ${preview.project.environment ? "environment" : "logical key"} was not confirmed.`);
        process.exitCode = 1;
        return;
      }
      const result = await removeStateEntry({ ...request, expectedEntry: entry });
      success(
        `Removed ${result.value.kind} ${entry.type}.${key} (#${entry.id}) from ${result.project.stateDisplayPath}.`,
      );
      info(
        `ChurchTools was not contacted — #${entry.id} still exists there. ` +
          (result.value.kind === "managed"
            ? `Re-adopt it with \`ct adopt ${type} ${entry.id}\`.`
            : `Re-bind it with \`ct use ${type} ${entry.id} --key ${key}\`.`),
      );
    });

  cmd
    .command("rekey")
    .description("Change the logical key of a managed or external state entry")
    .argument("<type>", "resource type")
    .argument("<old-key>", "current logical key")
    .argument("<new-key>", "new globally unique logical key")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--dry-run", "report the rekey without writing")
    .action(
      async (type: string, oldKey: string, newKey: string, opts: StateOptions & { dryRun?: boolean }) => {
        const result = await rekeyStateEntry({
          type,
          oldKey,
          newKey,
          statePath: opts.state,
          environment: opts.env,
          dryRun: opts.dryRun,
        });
        for (const warning of result.warnings) warn(warning.message);
        if (opts.dryRun) {
          info(`Would rekey ${result.value.kind} ${type}.${oldKey} to ${type}.${newKey}.`);
        } else if (!result.value.changed) {
          info(`${result.value.kind} ${type}.${oldKey} already has that key; state is unchanged.`);
        } else {
          success(`Rekeyed ${result.value.kind} ${type}.${oldKey} to ${type}.${newKey}.`);
        }
        info("ChurchTools was not contacted.");
      },
    );

  return cmd;
}
