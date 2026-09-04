import { Command } from "commander";
import {
  executePreparedRelease,
  prepareRelease,
  type ReleaseConfirmationProof,
} from "../application/operations/release.js";
import { info, success, warn } from "../ui.js";
import { confirmStateRemoval } from "./state-removal-confirmation.js";

interface ReleaseOptions {
  state?: string;
  env?: string;
  config?: string;
  force?: boolean;
  dryRun?: boolean;
  confirmEnv?: string;
  confirmKey?: string;
}

type ReleaseKind = "managed" | "external";

function noun(kind: ReleaseKind): string {
  return kind === "managed" ? "managed ownership" : "external binding";
}

function commandName(kind: ReleaseKind): "unadopt" | "unuse" {
  return kind === "managed" ? "unadopt" : "unuse";
}

function releaseCommand(kind: ReleaseKind): Command {
  const name = commandName(kind);
  const command = new Command(name)
    .description(
      kind === "managed"
        ? "Stop managing an adopted object without changing it in ChurchTools"
        : "Remove an external read-only binding without changing ChurchTools",
    )
    .argument("<type>", "ct-cli resource type")
    .argument("<key>", "logical key to release")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("-c, --config <path>", "config file to check for declarations and refs (or set CT_CONFIG)")
    .option(
      "--force",
      "allow removal while the key is still declared/referenced or the config cannot be checked",
    )
    .option("--dry-run", "validate and report the removal without writing state")
    .option("--confirm-env <name>", "confirm a named environment non-interactively (must match --env)")
    .option(
      "--confirm-key <key>",
      "confirm a legacy project without --env non-interactively (must match the logical key)",
    );

  return command.action(async (type: string, key: string, opts: ReleaseOptions) => {
    const request = {
      type,
      key,
      kind,
      statePath: opts.state,
      configPath: opts.config,
      environment: opts.env,
      force: opts.force,
    } as const;
    // The person reading the preview may take as long as needed; exact-entry
    // comparison, not wall-clock expiry, rejects stale confirmation.
    const prepared = await prepareRelease(request, { preparedTtlMs: null });
    const preview = prepared.preview;
    for (const warning of preview.warnings) warn(warning.message);
    const entry = preview.value.entry;
    warn(
      `${opts.dryRun ? "Would remove" : "About to remove"} ${noun(kind)} ` +
        `${entry.type}.${entry.key} (#${entry.id}) from ${preview.project.stateDisplayPath}.`,
    );
    info("ChurchTools will not be contacted; the live object will remain unchanged.");
    if (opts.dryRun) return;

    const confirmed = await confirmStateRemoval(preview.project, key, {
      confirmEnv: opts.confirmEnv,
      confirmKey: opts.confirmKey,
    });
    if (!confirmed) {
      warn(`Aborted — ${preview.project.environment ? "environment" : "logical key"} was not confirmed.`);
      process.exitCode = 1;
      return;
    }

    const proof: ReleaseConfirmationProof = preview.project.environment
      ? { type: "environment", value: preview.project.environment }
      : { type: "key", value: key };
    const result = await executePreparedRelease(prepared, proof);
    success(
      `${name}: removed ${noun(kind)} ${entry.type}.${entry.key} (#${entry.id}) from ` +
        `${result.project.stateDisplayPath}.`,
    );
    info("ChurchTools was not contacted.");
  });
}

export function unuseCommand(): Command {
  return releaseCommand("external");
}

export function unadoptCommand(): Command {
  return releaseCommand("managed");
}
