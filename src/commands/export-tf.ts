import { Command } from "commander";
import { runExportTf } from "../application/operations/export-tf.js";
import { info } from "../ui.js";

interface ExportTfOptions {
  state?: string;
  env?: string;
  only?: string[];
  out: string;
}

export function exportCommand(): Command {
  const tf = new Command("tf")
    .description("Render the managed state as OpenTofu HCL plus import blocks")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--only <types...>", "restrict to these resource types (e.g. campus group-type)")
    .option("-o, --out <dir>", "output directory", "tofu")
    .action(async (opts: ExportTfOptions) => {
      const { value } = await runExportTf({
        statePath: opts.state,
        environment: opts.env,
        only: opts.only,
        outDir: opts.out,
      });
      for (const file of value.files) info(`wrote ${opts.out}/${file}`);
      for (const r of value.relabelled) {
        info(`relabelled "${r.key}" -> "${r.label}" (HCL references must be identifiers)`);
      }
      info(`${value.imported} resources exported`);
    });

  return new Command("export").description("Export managed state to other formats").addCommand(tf);
}
