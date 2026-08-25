import { mkdir, writeFile } from "node:fs/promises";
import { dirname, format, parse, resolve } from "node:path";
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { prepareEnvHost } from "../env/context.js";
import { collectLivePermissions } from "../reports/permissions/collect.js";
import { renderByObject, renderBySubject } from "../reports/permissions/render.js";

interface ReportOptions {
  bySubject?: string | boolean;
  byObject?: string | boolean;
  byBoth?: string;
  env?: string;
}

export interface PermissionReportTarget {
  by: "subject" | "object";
  output: string;
}

const DEFAULT_SUBJECT_OUTPUT = "permissions-by-subject.md";
const DEFAULT_OBJECT_OUTPUT = "permissions-by-object.md";

function selectedOutput(value: string | boolean | undefined, fallback: string): string | undefined {
  if (value === undefined || value === false) return undefined;
  return typeof value === "string" ? value : fallback;
}

function suffixedOutput(base: string, suffix: string): string {
  const parts = parse(base);
  return format({ dir: parts.dir, name: `${parts.name}${suffix}`, ext: parts.ext });
}

export function permissionReportTargets(opts: ReportOptions): PermissionReportTarget[] {
  const subjectOutput = selectedOutput(opts.bySubject, DEFAULT_SUBJECT_OUTPUT);
  const objectOutput = selectedOutput(opts.byObject, DEFAULT_OBJECT_OUTPUT);
  const hasNamedOutputs = subjectOutput !== undefined || objectOutput !== undefined;

  if (opts.byBoth && hasNamedOutputs)
    throw new Error("--by-both cannot be combined with --by-subject or --by-object.");
  if (subjectOutput && objectOutput && subjectOutput === objectOutput)
    throw new Error("--by-subject and --by-object must not write to the same file.");

  if (opts.byBoth)
    return [
      { by: "subject", output: suffixedOutput(opts.byBoth, "_by-subject") },
      { by: "object", output: suffixedOutput(opts.byBoth, "_by-object") },
    ];
  const targets: PermissionReportTarget[] = [];
  if (subjectOutput) targets.push({ by: "subject", output: subjectOutput });
  if (objectOutput) targets.push({ by: "object", output: objectOutput });
  if (targets.length === 0)
    throw new Error("Select --by-subject [file], --by-object [file], or --by-both <base>.");
  return targets;
}

/**
 * Reports are routinely written into a gitignored `reports/` directory that does not exist in a
 * fresh clone. Create the directories up front so that fails immediately, rather than after the
 * full read-only collection has already run.
 */
export async function ensureReportDirectories(targets: PermissionReportTarget[]): Promise<void> {
  for (const target of targets) await mkdir(dirname(resolve(target.output)), { recursive: true });
}

export function reportCommand(): Command {
  const permissions = new Command("permissions")
    .description("Report the complete live permission assignment set (read-only)")
    .option("--by-subject [file]", `write the subject report (default: ${DEFAULT_SUBJECT_OUTPUT})`)
    .option("--by-object [file]", `write the object report (default: ${DEFAULT_OBJECT_OUTPUT})`)
    .option("--by-both <base>", "write both reports with _by-subject/_by-object suffixes")
    .option("-e, --env <name>", "environment profile from ct.envs.json")
    .action(async (opts: ReportOptions) => {
      const targets = permissionReportTargets(opts);
      await ensureReportDirectories(targets);
      await prepareEnvHost(opts);
      const { client } = await authedSession();
      const dataset = await collectLivePermissions(client);
      for (const target of targets) {
        const text = target.by === "subject" ? renderBySubject(dataset) : renderByObject(dataset);
        await writeFile(target.output, text, "utf8");
      }
    });
  return new Command("report").description("Generate read-only reports").addCommand(permissions);
}
