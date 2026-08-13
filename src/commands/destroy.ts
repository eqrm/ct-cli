import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { CtApiError, type CtClient } from "../api/ctClient.js";
import { resolveConfig } from "../config.js";
import { prepareEnv } from "../env/context.js";
import { loadState, saveState, type State } from "../state/state.js";
import { RESOURCES } from "../resources/registry.js";
import { assertNotPeople } from "../engine/guard.js";
import { orderKeys } from "../engine/graph.js";
import { fetchActual } from "../engine/build.js";
import { parentIdsByGroupId, managedParentKeys, type HierarchyEntry } from "../engine/hierarchy.js";
import type { DesiredResource } from "../engine/types.js";
import { writeBackup } from "../engine/backup.js";
import { resolveBackupDir } from "./apply.js";
import { confirmTyped, confirmEnv } from "../ui/prompt.js";
import { info, warn, success, error, formatError } from "../ui.js";

interface DestroyOptions {
  target?: string[];
  state?: string;
  env?: string;
  confirmEnv?: string;
  backupDir?: string;
  force?: boolean;
}

/** Flatten repeated/comma-separated `--target` values into a deduped key list. */
export function parseTargets(raw: string[]): string[] {
  const out: string[] = [];
  for (const chunk of raw) {
    for (const part of chunk.split(",")) {
      const key = part.trim();
      if (key && !out.includes(key)) {
        out.push(key);
      }
    }
  }
  return out;
}

/**
 * Reverse dependency order for destroy: highest tier first (leaves before their
 * base metadata) and, within the group tier, a child before its parent.
 *
 * The state file carries no hierarchy edges (the synthetic `parents` field is
 * stripped from snapshots — see execute.ts), so the caller passes `parentKeysByKey`
 * discovered live from `/groups/hierarchies` (managed groups only). We reuse
 * `orderKeys` — the very topological apply order plan uses — with those edges,
 * then reverse it, so destroy is the exact inverse of apply and honours intra-tier
 * parent edges. Pass an empty map (or omit) to fall back to tier-only ordering.
 */
export function orderDestroy(
  state: State,
  keys: string[],
  parentKeysByKey: Map<string, string[]> = new Map(),
): string[] {
  const entries: DesiredResource[] = keys.map((key) => ({
    type: state.resources[key]!.type,
    key,
    fields: {},
    dependsOn: parentKeysByKey.get(key) ?? [],
  }));
  return orderKeys(entries).reverse();
}

/**
 * Discover managed group→parent edges from the live `/groups/hierarchies`, so
 * `orderDestroy` can put a child before its parent. Only the group targets need
 * edges; every managed group is mapped id→key so a parent edge to a not-targeted
 * managed group is still resolvable (harmless — `orderKeys` ignores deps outside
 * the target set). Best-effort: a fetch failure warns and returns no edges, so
 * ordering degrades to tier-only rather than aborting the destroy.
 */
async function fetchParentEdges(
  client: Pick<CtClient, "get">,
  state: State,
  keys: string[],
): Promise<Map<string, string[]>> {
  const groupKeys = keys.filter((k) => state.resources[k]?.type === "group");
  if (groupKeys.length === 0) return new Map();
  const groupIdToKey = new Map<number, string>();
  for (const m of Object.values(state.resources)) {
    if (m.type === "group") groupIdToKey.set(m.id, m.key);
  }
  try {
    const raw = await client.get<HierarchyEntry[]>("/groups/hierarchies");
    const parentIds = parentIdsByGroupId(Array.isArray(raw) ? raw : []);
    const edges = new Map<string, string[]>();
    for (const key of groupKeys) {
      edges.set(key, managedParentKeys(parentIds.get(state.resources[key]!.id) ?? [], groupIdToKey));
    }
    return edges;
  } catch (err) {
    warn(`Failed to fetch group hierarchies for destroy ordering: ${formatError(err)}. Falling back to tier-only order.`);
    return new Map();
  }
}

/**
 * Type-level teardown warnings for the targets of this run (#99 review) — one line per target whose
 * resource type declares a `destroyWarning`. A non-empty result also means `--force` must NOT skip
 * the typed confirmation: these are the deletes whose blast radius leaves the managed surface (today:
 * `person-status`, whose deletion mutates every person carrying it), so an unattended `--force`
 * teardown is exactly the run that should stop and ask.
 */
export function destroyWarnings(state: State, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const type = state.resources[key]?.type;
    const warning = type ? RESOURCES[type]?.destroyWarning : undefined;
    if (warning) out.push(`${type}.${key}: ${warning}`);
  }
  return out;
}

export function destroyCommand(): Command {
  return new Command("destroy")
    .description("Explicitly delete managed resources (protected; never implicit)")
    .requiredOption("--target <keys...>", "logical key(s) to destroy (repeatable or comma-separated)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option(
      "--confirm-env <name>",
      "confirm a protected env non-interactively (must match --env exactly)",
    )
    .option("--backup-dir <path>", "directory for the pre-destroy backup (or set CT_BACKUP_DIR)")
    .option(
      "--force",
      "skip the typed confirmation (preventDestroy — and a type-level destroy warning, e.g. person-status — is still enforced)",
    )
    .action(async (opts: DestroyOptions) => {
      const targets = parseTargets(opts.target ?? []);
      if (targets.length === 0) {
        throw new Error("No --target given. Destroy never deletes implicitly.");
      }

      const cmdEnv = await prepareEnv(opts);
      const config = await resolveConfig();
      const statePath = cmdEnv.statePath;
      const state = await loadState(statePath, config.host);

      for (const key of targets) {
        if (!state.resources[key]) {
          throw new Error(`"${key}" is not managed (not in the state file). Nothing to destroy.`);
        }
      }

      // preventDestroy guard: read from STATE, never the config. A resource dropped from config
      // (the real destroy scenario) has lost its config flag, but its state entry still carries the
      // protection apply mirrored there — so it survives the drop. destroy loads no config file at
      // all, so a config eval error (e.g. a sibling still referencing the dropped target) can't
      // block a teardown either (items 2 + 3).
      const blocked = targets.filter((k) => state.resources[k]!.preventDestroy);
      if (blocked.length > 0) {
        throw new Error(
          `preventDestroy is set (in state) for: ${blocked.join(", ")}. ` +
            `Set preventDestroy:false in config and re-apply (or clear it in the state file) first.`,
        );
      }

      const { client } = await authedSession();

      const parentEdges = await fetchParentEdges(client, state, targets);
      const ordered = orderDestroy(state, targets, parentEdges);

      // Backup: fetch each target's current actual values via the same fetchActual as plan/apply
      // (404 → skip: already gone in CT, nothing to back up). A non-404 failure must ABORT before
      // any DELETE — proceeding would irreversibly delete a target with no backup of its state.
      const { actual, fetchErrors } = await fetchActual(client, ordered.map((k) => state.resources[k]!));
      if (fetchErrors.length > 0) {
        error(
          `Backup fetch failed for: ${fetchErrors.join("; ")}. ` +
            `Nothing was deleted — resolve the error (or wait out the outage) and re-run.`,
        );
        process.exitCode = 1;
        return;
      }
      const backupPath = await writeBackup(resolveBackupDir(opts.backupDir, statePath), config.host, actual);
      info(`Backup written: ${backupPath}`);

      warn(`About to DELETE: ${ordered.join(", ")}`);
      // Type-level risk (see `destroyWarnings`): surfaced before the prompt, and it takes `--force`
      // away for this run so the delete cannot go through unattended.
      const risky = destroyWarnings(state, ordered);
      for (const line of risky) {
        warn(`RISK — ${line}`);
      }
      if (risky.length > 0 && opts.force) {
        warn("--force does NOT skip confirmation for the target(s) above. Confirm interactively.");
      }
      // Protected env (#22): typed confirmation of the env NAME is mandatory and --force does NOT bypass
      // it (--confirm-env <name> substitutes in CI). Otherwise the usual per-target typed confirmation.
      const expected = targets.length === 1 ? targets[0]! : "destroy";
      const ok = cmdEnv.protected
        ? await confirmEnv(cmdEnv.name!, { confirmFlag: opts.confirmEnv })
        : await confirmTyped(expected, { force: opts.force && risky.length === 0 });
      if (!ok) {
        warn(
          cmdEnv.protected
            ? `Aborted — protected environment "${cmdEnv.name}" was not confirmed. Nothing deleted.`
            : "Aborted — nothing deleted.",
        );
        process.exitCode = 1;
        return;
      }

      await runDeleteLoop({ client, state, statePath, ordered });
    });
}

export interface DeleteLoopCtx {
  client: Pick<CtClient, "request">;
  state: State;
  statePath: string;
  ordered: string[];
  /** Injection seam for tests; defaults to the real state writer. */
  save?: (path: string, state: State) => Promise<void>;
}

/**
 * Delete each ordered target, removing it from state and saving after each success.
 *
 * A 404 means the target was already deleted in ChurchTools (e.g. by hand in the UI):
 * treat it as success-with-note — drop the state entry, save, and continue to the next
 * target. Any non-404 error stops the run with state saved up to that point, so a re-run
 * can resume with the remaining targets. (Mirrors the backup loop's 404 tolerance.)
 */
export async function runDeleteLoop(ctx: DeleteLoopCtx): Promise<void> {
  const { client, state, statePath, ordered } = ctx;
  const save = ctx.save ?? saveState;
  for (const key of ordered) {
    const managed = state.resources[key]!;
    const spec = RESOURCES[managed.type];
    if (!spec) {
      error(`No write spec for type "${managed.type}" — skipping ${key}.`);
      continue;
    }
    const path = spec.itemPath(managed.id);
    assertNotPeople(path);
    try {
      await client.request("DELETE", path);
    } catch (err) {
      if (err instanceof CtApiError && err.status === 404) {
        delete state.resources[key];
        await save(statePath, state);
        success(`${managed.type}.${key} (#${managed.id}) already deleted in ChurchTools — removed from state`);
        continue;
      }
      // Same formatter the top-level handler uses (#50) so a non-404 CtApiError's HTTP status +
      // response body survive into the stop message (#71), not just the bare "... failed" text.
      error(
        `Stopped at ${key}: ${formatError(err)}. State saved up to this point — re-run with the remaining targets to resume.`,
      );
      process.exitCode = 1;
      return;
    }
    delete state.resources[key];
    await save(statePath, state);
    success(`Destroyed ${managed.type}.${key} (#${managed.id})`);
  }
}
