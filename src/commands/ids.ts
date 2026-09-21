import { relative } from "node:path";
import { Command } from "commander";
import { runIdsList, runIdsSync } from "../application/operations/ids.js";
import { error, formatError, info, out, success, warn } from "../ui.js";

/**
 * `ct ids` — the committed OpenTofu id map (#181).
 *
 * The map is what keeps `campus: "mainz"` and `personStatus: "status_unbekannt"` resolving after
 * those resources move to terraform-provider-churchtools and leave ct's state. `ct export tf` writes
 * it during the cutover; this command keeps it current afterwards, when tofu is the only place new
 * ids appear.
 */
export function idsCommand(): Command {
  const cmd = new Command("ids").description(
    "Maintain the committed key→id map ct resolves OpenTofu-owned resources through",
  );

  cmd
    .command("sync")
    .description("Rewrite .ct/ids.<host>.json from an OpenTofu state file (or stdin)")
    .requiredOption(
      "--tofu-state <path>",
      'path to a terraform.tfstate, or "-" for stdin (e.g. `tofu state pull | ct ids sync -e prod --tofu-state -`)',
    )
    .option("-e, --env <name>", "environment profile from ct.envs.json (decides which host's map)")
    .option("--dry-run", "report what would change without writing the map")
    .action(async (opts: { tofuState: string; env?: string; dryRun?: boolean }) => {
      try {
        const { value, warnings, project } = await runIdsSync({
          tofuState: opts.tofuState,
          environment: opts.env,
          dryRun: opts.dryRun,
        });
        const where = relative(project.cwd, value.path);
        for (const entry of value.added) info(`+ ${entry.type}.${entry.key} = ${entry.id}`);
        for (const { entry, previousId } of value.changed) {
          info(`~ ${entry.type}.${entry.key} = ${entry.id} (was ${previousId})`);
        }
        for (const entry of value.removed) info(`- ${entry.type}.${entry.key} (was ${entry.id})`);
        for (const w of warnings) warn(w.message);
        const serial = value.serial === null ? "" : ` (tofu state serial ${value.serial})`;
        if (value.written) {
          success(`${where}: ${value.entries.length} ids from ${project.host}${serial}.`);
        } else {
          info(`Would write ${where}: ${value.entries.length} ids from ${project.host}${serial}.`);
        }
        // An empty read never overwrites a good map — the likeliest cause is the wrong workspace,
        // and replacing 50 working ids with nothing would break every reference at once.
        if (!value.written && !opts.dryRun) process.exitCode = 1;
      } catch (caught) {
        error(formatError(caught));
        process.exitCode = 1;
      }
    });

  cmd
    .command("list")
    .description("Show the id map ct would resolve through for this host")
    .option("-e, --env <name>", "environment profile from ct.envs.json (decides which host's map)")
    .option("--json", "emit the entries as JSON")
    .action(async (opts: { env?: string; json?: boolean }) => {
      try {
        const { value, project } = await runIdsList({ environment: opts.env });
        if (opts.json) {
          out(value.entries);
          return;
        }
        if (!value.path) {
          info(
            `No id map for ${project.host}. One is written by \`ct export tf\`, or by ` +
              `\`ct ids sync --tofu-state <path>\`.`,
          );
          return;
        }
        info(`${relative(project.cwd, value.path)} — ${value.entries.length} ids for ${project.host}`);
        for (const entry of value.entries) {
          process.stdout.write(`${entry.type}.${entry.key} = ${entry.id}\n`);
        }
      } catch (caught) {
        error(formatError(caught));
        process.exitCode = 1;
      }
    });

  return cmd;
}
