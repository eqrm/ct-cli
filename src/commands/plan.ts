import { writeFile } from "node:fs/promises";
import { format as formatPath, parse as parsePath } from "node:path";
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { prepareEnv } from "../env/context.js";
import { loadState } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { buildPlan } from "../engine/build.js";
import { Resolver } from "../resolve/resolver.js";
import { renderPlan } from "../engine/render.js";
import { PLAN_MARKDOWN_LOCALES, renderPlanMarkdown, type PlanMarkdownLocale } from "../engine/markdown.js";
import { summarize } from "../engine/types.js";
import { buildPermissionPlan } from "../permissions/plan.js";
import { loadHostCatalog } from "../permissions/catalog-store.js";
import { renderPermissionPlan } from "../permissions/render.js";
import { info, warn } from "../ui.js";

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
    .option(
      "--detailed-exitcode",
      "Terraform-style exit code: 0 = no changes, 1 = error, 2 = changes pending (resource or permission)",
    )
    .action(async (opts: PlanOptions) => {
      const outputTargets = planOutputTargets(opts);
      const locale = parsePlanLocale(opts.locale);
      // Resolve the env FIRST — it wires the target host/token into the process env before resolveConfig.
      const cmdEnv = await prepareEnv(opts);
      const config = await resolveConfig();
      const configPath = resolveConfigPath(opts.config);
      // A per-instance permission catalog this repo committed for THIS host wins over the one bundled
      // with the release (#105). Loaded BEFORE loadConfig, not just before the plan: config evaluation
      // validates `preserveUnknown` dimensions against the active catalog's KNOWN_SCOPE_FIELDS, so
      // loading it later would validate against the bundled catalog and plan against the captured one.
      const hostCatalog = await loadHostCatalog(config.host);
      if (hostCatalog) info(`permission catalog: ${hostCatalog}`);
      const { resources: desired, permissions, configDir } = await loadConfig(configPath);
      // loadState already refuses a host mismatch (state.ts) — no second guard needed here.
      const state = await loadState(cmdEnv.statePath, config.host);

      const { client } = await authedSession();
      // One shared resolver (#20): buildPlan and buildPermissionPlan run concurrently, so a single
      // instance means each master-data catalog is fetched at most once (cache is Promise-keyed).
      const resolver = new Resolver({ client, state, desired, host: config.host });
      // Independent fetches run concurrently (see commands/apply.ts).
      const [
        { plan, fetchErrors, warnings: resourceWarnings = [] },
        { items: permItems, fetchErrors: permFetchErrors, warnings: permWarnings },
      ] = await Promise.all([
        buildPlan(client, state, desired, { configDir, resolver }),
        buildPermissionPlan(client, state, permissions, desired, resolver, client.version ?? undefined),
      ]);
      // "Changes present" for --detailed-exitcode / the JSON summary: anything `ct apply` would
      // actually act on — a resource item whose action isn't a no-op, OR a permission item with a
      // grant/revoke to write. Drift by itself does NOT count: an item can carry `drift` while
      // staying a no-op (the field drifted but isn't managed by config, or coincidentally matches
      // desired again), and apply would write nothing for it — see docs/README "CI usage".
      const hasResourceChanges = plan.items.some((i) => i.action !== "no-op");
      const hasPermissionChanges = permItems.some(
        (i) => i.diff.toPut.length > 0 || i.diff.toDelete.length > 0,
      );
      const hasChanges = hasResourceChanges || hasPermissionChanges;

      // Additive on top of the raw plan/permissions (#24) — existing consumers of `plan`/`permissions`
      // are unaffected. Every projection below consumes this one computation.
      const payload = {
        plan,
        permissions: permItems,
        summary: {
          resources: summarize(plan),
          drifted: plan.items.filter((i) => i.drift && i.drift.length > 0).length,
          // Non-zero means the plan is PARTIAL: these resources could not be read, so their diff
          // is missing rather than empty. A machine consumer must not treat the plan as complete
          // while this is > 0 (#126) — `ct plan` also exits 1 in that case.
          unreadable: plan.items.filter((i) => i.note === "fetch-failed").length,
          permissions: {
            toPut: permItems.reduce((n, i) => n + i.diff.toPut.length, 0),
            toDelete: permItems.reduce((n, i) => n + i.diff.toDelete.length, 0),
            preserved: permItems.reduce((n, i) => n + i.diff.preserved.length, 0),
          },
          hasChanges,
        },
      };

      const textHeader = cmdEnv.name
        ? `env: ${cmdEnv.name} · host: ${config.host} · ChurchTools ${client.version ?? "unknown"} · ` +
          `config: ${configPath} · state host: ${state.host}`
        : `config: ${configPath} · state host: ${state.host}`;
      const textBody = `${renderPlan(plan)}${permItems.length > 0 ? `\n\n${renderPermissionPlan(permItems)}` : ""}\n`;
      for (const target of outputTargets) {
        const content =
          target.format === "json"
            ? `${JSON.stringify(payload, null, 2)}\n`
            : target.format === "markdown"
              ? renderPlanMarkdown(plan, permItems, {
                  environment: cmdEnv.name,
                  host: config.host,
                  churchToolsVersion: client.version,
                  configPath,
                  stateHost: state.host,
                  locale,
                  warnings: [...resourceWarnings, ...permWarnings],
                  fetchErrors: [...fetchErrors, ...permFetchErrors],
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
      for (const w of permWarnings) warn(w);

      const allFetchErrors = [...fetchErrors, ...permFetchErrors];
      if (allFetchErrors.length > 0) {
        warn(
          `Plan is INCOMPLETE — ${allFetchErrors.length} resource(s) could not be fetched; their diff is missing. Re-run to retry.`,
        );
        // An INCOMPLETE plan is always an error (1) — even under --detailed-exitcode, and even if
        // the (partial) plan has changes. Never demoted to 2: an incomplete diff cannot be trusted
        // enough to report "changes present" instead of "this run failed".
        process.exitCode = 1;
      } else if (opts.detailedExitcode && hasChanges) {
        process.exitCode = 2;
      }
    });
}
