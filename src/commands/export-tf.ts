import { relative } from "node:path";
import { Command } from "commander";
import { runExportTf } from "../application/operations/export-tf.js";
import { info, warn } from "../ui.js";

interface ExportTfOptions {
  state?: string;
  env?: string;
  only?: string[];
  out: string;
  versions: boolean;
  ids: boolean;
}

export function exportCommand(): Command {
  const tf = new Command("tf")
    .description("Render the managed state as OpenTofu HCL plus import blocks")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--only <types...>", "restrict to these resource types (e.g. campus group-type)")
    .option("-o, --out <dir>", "output directory", "tofu")
    .option(
      "--no-versions",
      "do not write or prune versions.tf — use when your repo owns it (e.g. to pin a provider version)",
    )
    .option(
      "--no-ids",
      "do not write .ct/ids.<host>.json — the key→id map ct resolves leftover references through once these resources leave its state",
    )
    .action(async (opts: ExportTfOptions) => {
      const { value, warnings } = await runExportTf({
        statePath: opts.state,
        environment: opts.env,
        only: opts.only,
        outDir: opts.out,
        writeVersions: opts.versions,
        writeIds: opts.ids,
      });
      for (const file of value.files) info(`wrote ${opts.out}/${file}`);
      for (const r of value.relabelled) {
        info(`relabelled "${r.key}" -> "${r.label}" (HCL references must be identifiers)`);
      }
      if (value.idMapPath) info(`wrote ${relative(process.cwd(), value.idMapPath)}`);
      info(`${value.imported} resources exported`);
      // Printed last, after the success line, so the gap is the final thing on
      // screen rather than scrolled off above a list of written files.
      for (const w of warnings) warn(w.message);
    });

  return new Command("export").description("Export managed state to other formats").addCommand(tf);
}
