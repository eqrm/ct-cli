import { relative } from "node:path";
import { Command } from "commander";
import {
  executePreparedApply,
  prepareApply,
  resolveBackupDir,
  type ConfirmationProof,
} from "../application/operations/apply.js";
import { CtApplicationError } from "../application/errors.js";
import { renderPlan } from "../engine/render.js";
import { renderPermissionPlan } from "../permissions/render.js";
import { confirm, confirmEnv } from "../ui/prompt.js";
import { cliObserver } from "./observer.js";
import { info, warn, success, error } from "../ui.js";
import { generateSelectedInput } from "../operations/input-projection.js";

interface ApplyOptions {
  config?: string;
  state?: string;
  env?: string;
  confirmEnv?: string;
  backupDir?: string;
  autoApprove?: boolean;
  refresh?: boolean;
  inputSnapshot?: string;
  generator?: string;
}

// Retain this command-module export for callers that used it before the application extraction.
export { resolveBackupDir };

export function applyCommand(): Command {
  return new Command("apply")
    .description("Apply the plan: idempotent create + update in dependency order (never deletes)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--confirm-env <name>", "confirm a protected env non-interactively (must match --env exactly)")
    .option("--backup-dir <path>", "directory for the pre-apply backup (or set CT_BACKUP_DIR)")
    .option("-y, --auto-approve", "skip the confirmation prompt")
    .option("--input-snapshot <digest>", "generate desired config from this immutable input snapshot")
    .option("--generator <path>", "trusted local process-input generator module")
    .option(
      "--refresh",
      "after a successful apply, POST /dynamicgroups/{id}/refresh for each changed dynamic group (per-group only)",
    )
    .action(async (opts: ApplyOptions) => {
      let prepared;
      try {
        const selectedInput = await generateSelectedInput(process.cwd(), opts.inputSnapshot, opts.generator);
        prepared = await prepareApply(
          {
            configPath: opts.config,
            statePath: opts.state,
            environment: opts.env,
            backupDir: opts.backupDir,
            refresh: opts.refresh,
            // No wall-clock expiry: the confirmation below blocks on stdin for as long as the
            // operator needs to read the rendered diff (#156 review). Staleness is caught by the
            // state fingerprint at execute time, not by a timer.
          },
          {
            preparedTtlMs: null,
            ...(selectedInput
              ? { loadConfig: async () => ({ ...selectedInput.generated, configDir: process.cwd() }) }
              : {}),
          },
        );
      } catch (caught) {
        if (caught instanceof CtApplicationError && caught.code === "PLAN_INCOMPLETE") {
          const details = caught.details ?? {};
          const catalog = details.permissionCatalogPath;
          const cwd = typeof details.cwd === "string" ? details.cwd : process.cwd();
          if (typeof catalog === "string") info(`permission catalog: ${relative(cwd, catalog)}`);
          if (Array.isArray(details.warnings)) {
            for (const warning of details.warnings) if (typeof warning === "string") warn(warning);
          }
          error(caught.message);
          process.exitCode = 1;
          return;
        }
        throw caught;
      }

      const { project, value } = prepared.plan;
      if (value.permissionCatalogPath) {
        info(`permission catalog: ${relative(project.cwd, value.permissionCatalogPath)}`);
      }
      for (const warning of prepared.plan.warnings) warn(warning.message);

      process.stdout.write(`${renderPlan(value.plan)}\n`);
      if (value.permissions.length > 0) {
        process.stdout.write(`\n${renderPermissionPlan(value.permissions)}\n`);
      }

      const deletes = value.plan.items.filter((item) => item.action === "delete");
      if (deletes.length > 0) {
        warn(`${deletes.length} resource(s) dropped from config will NOT be deleted by apply:`);
        for (const item of deletes) {
          info(`    ${item.type}.${item.key} (#${item.id}) — run: ct destroy --target ${item.key}`);
        }
      }

      if (prepared.changeCount === 0) {
        success("No changes to apply.");
        return;
      }

      let proof: ConfirmationProof | undefined;
      let confirmed = false;
      if (prepared.confirmation.type === "environment") {
        confirmed = await confirmEnv(prepared.confirmation.environment, { confirmFlag: opts.confirmEnv });
        if (confirmed) proof = { type: "environment", value: prepared.confirmation.environment };
      } else if (prepared.confirmation.type === "yes") {
        confirmed = await confirm(`Apply ${prepared.changeCount} change(s)?`, {
          assumeYes: opts.autoApprove,
        });
        if (confirmed) proof = { type: "yes" };
      } else {
        confirmed = true;
      }

      if (!confirmed) {
        warn(
          prepared.confirmation.type === "environment"
            ? `Aborted — protected environment "${prepared.confirmation.environment}" was not confirmed (no changes made).`
            : "Aborted — no changes made.",
        );
        process.exitCode = 1;
        return;
      }

      // The observer prints `Backup written: …` the moment the backup lands, so the path is on
      // screen even when a later step throws — the exact case the backup exists for (#156 review).
      const result = await executePreparedApply(prepared, proof, { observer: cliObserver() });
      const applied = result.value;
      success(
        `Applied: ${applied.resources.created.length} created, ${applied.resources.updated.length} updated.`,
      );
      if (applied.resources.failed) {
        error(
          `Stopped at ${applied.resources.failed.key}: ${applied.resources.failed.message}. State saved up to this point — re-run to resume.`,
        );
        process.exitCode = 1;
        return;
      }

      if (applied.permissions.granted > 0 || applied.permissions.deleted > 0) {
        success(
          `Permissions applied: ${applied.permissions.granted} granted, ${applied.permissions.deleted} deleted.`,
        );
      }
      if (applied.permissions.failed.length > 0) {
        error(
          `${applied.permissions.failed.length} permission write(s) failed — re-run to resume (grant reconciliation is idempotent):`,
        );
        for (const failure of applied.permissions.failed) {
          info(
            `    ${failure.method} ${failure.path} (authId ${failure.authId}${failure.dataId.length ? ` dataId ${failure.dataId.join(",")}` : ""}): ${failure.message}`,
          );
        }
        process.exitCode = 1;
        return;
      }

      if (!opts.refresh && applied.dynamicGroupKeys.length > 0) {
        info(
          `${applied.dynamicGroupKeys.length} dynamic group(s) written and activated — ChurchTools materializes their ` +
            `membership on its own schedule, so they may be empty for now. Force it with ` +
            `\`ct refresh --group ${applied.dynamicGroupKeys[0]}\` (or re-run apply with --refresh).`,
        );
      }
    });
}
