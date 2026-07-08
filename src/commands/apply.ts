import { dirname, join } from "node:path";
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { loadState, resolveStatePath, saveState } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { buildPlan } from "../engine/build.js";
import { executePlan } from "../engine/execute.js";
import { writeBackup } from "../engine/backup.js";
import { renderPlan } from "../engine/render.js";
import { summarize } from "../engine/types.js";
import { confirm } from "../ui/prompt.js";
import { info, warn, success, error } from "../ui.js";

interface ApplyOptions {
  config?: string;
  state?: string;
  backupDir?: string;
  autoApprove?: boolean;
}

/** backups/ dir: explicit flag → CT_BACKUP_DIR → `backups/` beside the state file. */
export function resolveBackupDir(
  explicit: string | undefined,
  statePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return explicit?.trim() || env.CT_BACKUP_DIR?.trim() || join(dirname(statePath), "backups");
}

export function applyCommand(): Command {
  return new Command("apply")
    .description("Apply the plan: idempotent create + update in dependency order (never deletes)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("--backup-dir <path>", "directory for the pre-apply backup (or set CT_BACKUP_DIR)")
    .option("-y, --auto-approve", "skip the confirmation prompt")
    .action(async (opts: ApplyOptions) => {
      const config = await resolveConfig();
      const configPath = resolveConfigPath(opts.config);
      const statePath = resolveStatePath(opts.state);
      const desired = await loadConfig(configPath);
      const state = await loadState(statePath, config.host);

      const { client } = await authedSession();
      const { plan, actual, fetchErrors } = await buildPlan(client, state, desired);

      if (fetchErrors.length > 0) {
        error(
          `Aborting: ${fetchErrors.length} resource(s) could not be fetched — the plan is incomplete. Re-run when resolved.`,
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`${renderPlan(plan)}\n`);

      const deletes = plan.items.filter((i) => i.action === "delete");
      if (deletes.length > 0) {
        warn(`${deletes.length} resource(s) dropped from config will NOT be deleted by apply:`);
        for (const d of deletes) {
          info(`    ${d.type}.${d.key} (#${d.id}) — run: ct destroy --target ${d.key}`);
        }
      }

      const s = summarize(plan);
      const changeCount = s.create + s.update;
      if (changeCount === 0) {
        success("No changes to apply.");
        return;
      }

      const ok = await confirm(`Apply ${changeCount} change(s)?`, { assumeYes: opts.autoApprove });
      if (!ok) {
        warn("Aborted — no changes made.");
        process.exitCode = 1;
        return;
      }

      const backupPath = await writeBackup(
        resolveBackupDir(opts.backupDir, statePath),
        config.host,
        actual,
      );
      info(`Backup written: ${backupPath}`);

      const result = await executePlan(plan, { client, state, statePath, save: saveState });
      success(`Applied: ${result.created.length} created, ${result.updated.length} updated.`);
      if (result.failed) {
        error(
          `Stopped at ${result.failed.key}: ${result.failed.message}. State saved up to this point — re-run to resume.`,
        );
        process.exitCode = 1;
      }
    });
}
