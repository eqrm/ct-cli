import { writeFile } from "node:fs/promises";
import { format as formatPath, parse as parsePath } from "node:path";
import { Command } from "commander";
import { relative } from "node:path";
import { runPlan } from "../application/operations/plan.js";
import { renderPlan } from "../engine/render.js";
import { PLAN_MARKDOWN_LOCALES, renderPlanMarkdown, type PlanMarkdownLocale } from "../engine/markdown.js";
import { renderPermissionPlan } from "../permissions/render.js";
import { info, warn } from "../ui.js";
import { generateSelectedInput } from "../operations/input-projection.js";

export type PlanFormat = "text" | "json" | "markdown";

export interface PlanOutputTarget {
  format: PlanFormat;
  path?: string;
}

interface PlanOptions {
  config?: string;
  state?: string;
  env?: string;
  json?: boolean;
  format?: string[];
  outputBase?: string;
  locale?: string;
  detailedExitcode?: boolean;
  inputSnapshot?: string;
  generator?: string;
}

function collectFormat(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseFormat(value: string): PlanFormat {
  if (value === "text" || value === "json" || value === "markdown") return value;
  throw new Error(`Unknown plan format "${value}". Use text, json, or markdown.`);
}

export function parsePlanLocale(value: string | undefined): PlanMarkdownLocale {
  const locale = value ?? "de-DE";
  if ((PLAN_MARKDOWN_LOCALES as readonly string[]).includes(locale)) return locale as PlanMarkdownLocale;
  throw new Error(`Unknown plan locale "${locale}". Available locales: ${PLAN_MARKDOWN_LOCALES.join(", ")}.`);
}

function planOutputPath(base: string, planFormat: PlanFormat): string {
  const extension: Record<PlanFormat, string> = { text: ".txt", json: ".json", markdown: ".md" };
  const parsed = parsePath(base);
  const knownExtension = [".txt", ".json", ".md", ".markdown"].includes(parsed.ext.toLowerCase());
  return formatPath({
    dir: parsed.dir,
    name: parsed.name,
    ext: knownExtension ? extension[planFormat] : `${parsed.ext}${extension[planFormat]}`,
  });
}

/** Resolve output files before any ChurchTools request, so invalid combinations fail cheaply. */
export function planOutputTargets(
  opts: Pick<PlanOptions, "json" | "format" | "outputBase">,
): PlanOutputTarget[] {
  const explicit = opts.format ?? [];
  if (opts.json && explicit.length > 0) {
    throw new Error("--json is an alias for --format json and cannot be combined with --format.");
  }
  if (opts.json && opts.outputBase) {
    throw new Error(
      "Use --format json with --output-base; the backward-compatible --json alias writes to stdout.",
    );
  }
  const selected = opts.json
    ? ["json" as const]
    : explicit.length > 0
      ? explicit.map(parseFormat)
      : ["text" as const];
  const formats = [...new Set(selected)];
  if (opts.outputBase && explicit.length === 0) {
    throw new Error("--output-base requires at least one explicit --format.");
  }
  if (formats.length > 1 && !opts.outputBase) {
    throw new Error(
      "Multiple --format values require --output-base so every projection has a distinct file.",
    );
  }
  return formats.map((planFormat) => ({
    format: planFormat,
    path: opts.outputBase ? planOutputPath(opts.outputBase, planFormat) : undefined,
  }));
}

export function planCommand(): Command {
  return new Command("plan")
    .description("Show the diff between the desired-state config and ChurchTools (read-only)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--json", "emit the raw plan as JSON instead of the rendered diff")
    .option(
      "--format <format>",
      "output format; repeat for multiple projections: text, json, markdown",
      collectFormat,
      [],
    )
    .option("--output-base <path>", "write selected formats as <path>.txt/.json/.md")
    .option("--locale <locale>", "Markdown language: de-DE or en", "de-DE")
    .option("--input-snapshot <digest>", "generate desired config from this immutable input snapshot")
    .option("--generator <path>", "trusted local process-input generator module")
    .option(
      "--detailed-exitcode",
      "Terraform-style exit code: 0 = no changes, 1 = error, 2 = changes pending (resource or permission)",
    )
    .action(async (opts: PlanOptions) => {
      // Resolved before any ChurchTools request, so an invalid combination fails cheaply.
      const outputTargets = planOutputTargets(opts);
      const locale = parsePlanLocale(opts.locale);
      const selectedInput = await generateSelectedInput(process.cwd(), opts.inputSnapshot, opts.generator);
      const result = await runPlan(
        {
          configPath: opts.config,
          statePath: opts.state,
          environment: opts.env,
        },
        selectedInput
          ? { loadConfig: async () => ({ ...selectedInput.generated, configDir: process.cwd() }) }
          : {},
      );
      const { project, value } = result;
      const catalogPath = value.permissionCatalogPath
        ? relative(project.cwd, value.permissionCatalogPath)
        : null;
      if (catalogPath) info(`permission catalog: ${catalogPath}`);

      // Additive on top of the raw plan/permissions (#24) — existing consumers of `plan`/
      // `permissions` are unaffected. Every projection below consumes this one computation.
      const payload = {
        plan: value.plan,
        permissions: value.permissions,
        summary: value.summary,
      };

      // Under --env, surface the target env name + its CT version (per-env version gate, #22) so a
      // dev/prod version skew is visible before applying. No --env keeps the original header
      // byte-identical.
      const textHeader = project.environment
        ? `env: ${project.environment} · host: ${project.host} · ChurchTools ${value.churchToolsVersion ?? "unknown"} · ` +
          `config: ${project.configDisplayPath} · state host: ${value.stateHost}`
        : `config: ${project.configDisplayPath} · state host: ${value.stateHost}`;
      const textBody = `${renderPlan(value.plan)}${
        value.permissions.length > 0 ? `\n\n${renderPermissionPlan(value.permissions)}` : ""
      }\n`;
      for (const target of outputTargets) {
        const content =
          target.format === "json"
            ? `${JSON.stringify(payload, null, 2)}\n`
            : target.format === "markdown"
              ? renderPlanMarkdown(value.plan, value.permissions, {
                  environment: project.environment,
                  host: project.host,
                  churchToolsVersion: value.churchToolsVersion,
                  configPath: project.configDisplayPath,
                  stateHost: value.stateHost,
                  locale,
                  // Build warnings reached the terminal from inside the builder; the Markdown
                  // report is not a terminal, so it needs them handed over explicitly.
                  warnings: [...value.buildWarnings, ...result.warnings.map((warning) => warning.message)],
                  fetchErrors: value.fetchErrors,
                })
              : textBody;
        if (target.path) {
          await writeFile(target.path, content, "utf8");
          info(`plan ${target.format}: ${target.path}`);
        } else {
          if (target.format === "text") info(textHeader);
          process.stdout.write(content);
        }
      }

      // Permission catalog warnings (#25): stale-version / unknown-authId. Informational — they do
      // not make the plan incomplete (unlike fetchErrors), so they never set a failing exit code.
      for (const warning of result.warnings) warn(warning.message);

      if (!value.complete) {
        warn(
          `Plan is INCOMPLETE — ${value.fetchErrors.length} resource(s) could not be fetched; their diff is missing. Re-run to retry.`,
        );
        // An INCOMPLETE plan is always an error (1) — even under --detailed-exitcode, and even if
        // the (partial) plan has changes. Never demoted to 2: an incomplete diff cannot be trusted
        // enough to report "changes present" instead of "this run failed".
        process.exitCode = 1;
      } else if (opts.detailedExitcode && value.summary.hasChanges) {
        process.exitCode = 2;
      }
    });
}
