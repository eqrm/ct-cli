import { Command } from "commander";
import { CtApiError } from "../api/ctClient.js";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { prepareEnvHost } from "../env/context.js";
import { loadEnvProfile, resolveEnvsPath, type EnvProfile } from "../env/envs.js";
import {
  DEFAULT_OPTIGEM_FIELD,
  buildCandidates,
  loadActivePersons,
  loadRelationState,
  resolveRelationshipTypes,
} from "../dupes/ct.js";
import { buildFinanceExport, financeMerges, toCsv } from "../dupes/finance.js";
import { assertHumanSession } from "../dupes/guard.js";
import { makeRedactor, type Redactor } from "../dupes/redact.js";
import { DupesStore, SCAN_SCHEMA, carryStates } from "../dupes/store.js";
import { info, success, warn } from "../ui.js";

interface CommonOptions {
  env?: string;
  redact?: boolean;
  optigemField?: string;
}

interface Session {
  host: string;
  store: DupesStore;
  redactor: Redactor;
  optigemField: string;
}

/** Neutral one-line error text: never a response body, never a person value. */
export function safeErrorText(err: unknown, redactor: Redactor): string {
  if (err instanceof CtApiError) return `ChurchTools request failed (HTTP ${err.status}).`;
  const msg = err instanceof Error ? err.message : "unknown error";
  return redactor.text(msg).slice(0, 200);
}

async function loadProfile(env?: string): Promise<EnvProfile | null> {
  return env ? loadEnvProfile(env, resolveEnvsPath()) : null;
}

/** Guard first (before any network or keychain access), then wire the env. */
async function openSession(opts: CommonOptions): Promise<Session> {
  const profile = await loadProfile(opts.env);
  assertHumanSession({
    profile,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    env: process.env,
  });
  await prepareEnvHost({ env: opts.env });
  const { host } = await resolveConfig();
  const store = new DupesStore(host);
  const optigemField = opts.optigemField ?? process.env.CT_DUPES_OPTIGEM_FIELD ?? DEFAULT_OPTIGEM_FIELD;
  const redactor = makeRedactor(opts.redact === true, opts.redact ? store.redactSecret() : "");
  return { host, store, redactor, optigemField };
}

async function run(opts: CommonOptions, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const redactor = makeRedactor(opts.redact === true, "error-text");
    process.stderr.write(`ct dupes: ${safeErrorText(err, redactor)}\n`);
    process.exitCode = 1;
  }
}

function addCommon(cmd: Command): Command {
  return cmd
    .option("-e, --env <name>", "environment profile from ct.envs.json")
    .option("--redact", "replace names and ids in all output with stable pseudonyms")
    .option(
      "--optigem-field <key>",
      `person property holding the Optigem ID (or CT_DUPES_OPTIGEM_FIELD; default ${DEFAULT_OPTIGEM_FIELD})`,
    );
}

export function dupesCommand(): Command {
  const dupes = new Command("dupes").description(
    "Find and resolve duplicate persons (interactive; touches person data, never run by agents)",
  );

  addCommon(
    dupes
      .command("scan")
      .description("Scan non-archived persons for duplicate candidates and store them locally"),
  ).action((opts: CommonOptions) =>
    run(opts, async () => {
      const s = await openSession(opts);
      const { client } = await authedSession();
      const persons = await loadActivePersons(client, s.optigemField);
      const rel = await loadRelationState(client);
      const candidates = buildCandidates(persons, rel);
      s.store.saveScan({
        schema: SCAN_SCHEMA,
        host: s.host,
        scannedAt: new Date().toISOString(),
        personsScanned: persons.length,
        candidates: carryStates(s.store.loadScan(), candidates),
      });
      const by = (t: string): number => candidates.filter((c) => c.tier === t).length;
      success(
        `Scanned ${persons.length} persons: ${candidates.length} candidates ` +
          `(T1 ${by("T1")}, T2 ${by("T2")}, T3 ${by("T3")}); ` +
          `${rel.suppressed.size} pairs suppressed by existing relationships.`,
      );
      info(`Stored in ${s.store.dir}`);
    }),
  );

  addCommon(
    dupes
      .command("review")
      .description("Review stored candidates in a full-screen view: merge, not a duplicate, skip"),
  ).action((opts: CommonOptions) =>
    run(opts, async () => {
      const s = await openSession(opts);
      const scan = s.store.loadScan();
      if (!scan) throw new Error("No scan found. Run `ct dupes scan` first.");
      const { client, me } = await authedSession();
      const types = await resolveRelationshipTypes(client);
      // Lazy: Ink and React load only for this command.
      const [{ runReviewTui }, { loadLabels }] = await Promise.all([
        import("../dupes/tui/run.js"),
        import("../dupes/actions.js"),
      ]);
      const labels = await loadLabels(client);
      await runReviewTui(
        {
          client,
          store: s.store,
          host: s.host,
          redactor: s.redactor,
          optigemField: s.optigemField,
          types,
          operator: { id: me.id, name: `${me.firstName ?? ""} ${me.lastName ?? ""}`.trim() },
          labels,
        },
        scan,
      );
      const by = (st: string): number => scan.candidates.filter((c) => c.state === st).length;
      info(`Done: ${by("merged")} merged, ${by("dismissed")} not duplicates, ${by("open")} still open.`);
    }),
  );

  addCommon(
    dupes
      .command("export-finance")
      .description("Write CSV and JSON of merges where both persons had an Optigem ID")
      .option("--since <date>", "only merges on or after this date (YYYY-MM-DD)")
      .option("--out <dir>", "output directory (default: the local dupes store)"),
  ).action((opts: CommonOptions & { since?: string; out?: string }) =>
    run(opts, async () => {
      if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
        throw new Error("--since must be a date like 2026-01-31.");
      }
      const s = await openSession(opts);
      const merges = financeMerges(s.store.readAudit(), opts.since);
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const data = buildFinanceExport(merges, s.host, opts.since, now);
      const csv = toCsv(merges);
      const json = `${JSON.stringify(data, null, 2)}\n`;
      let csvPath: string;
      let jsonPath: string;
      if (opts.out) {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        mkdirSync(opts.out, { recursive: true, mode: 0o700 });
        csvPath = join(opts.out, `optigem-merges-${day}.csv`);
        jsonPath = join(opts.out, `optigem-merges-${day}.json`);
        writeFileSync(csvPath, csv, { mode: 0o600 });
        writeFileSync(jsonPath, json, { mode: 0o600 });
      } else {
        csvPath = s.store.writeExport(`optigem-merges-${day}.csv`, csv);
        jsonPath = s.store.writeExport(`optigem-merges-${day}.json`, json);
      }
      if (merges.length === 0) warn("No merges with two Optigem IDs found; wrote empty files.");
      success(`${merges.length} merge(s) exported.`);
      info(csvPath);
      info(jsonPath);
    }),
  );

  return dupes;
}
