import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { CtApiError } from "../api/ctClient.js";
import { resolveConfig } from "../config.js";
import { loadState, resolveStatePath, saveState, type State } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { RESOURCES } from "../resources/registry.js";
import { assertNotPeople } from "../engine/guard.js";
import { tierOf } from "../engine/graph.js";
import { writeBackup } from "../engine/backup.js";
import { resolveBackupDir } from "./apply.js";
import { confirmTyped } from "../ui/prompt.js";
import { info, warn, success, error } from "../ui.js";

interface DestroyOptions {
  target?: string[];
  config?: string;
  state?: string;
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

/** Reverse dependency order: highest tier first (leaves before their base metadata). */
export function orderDestroy(state: State, keys: string[]): string[] {
  return [...keys].sort((a, b) => tierOf(state.resources[b]!.type) - tierOf(state.resources[a]!.type));
}

export function destroyCommand(): Command {
  return new Command("destroy")
    .description("Explicitly delete managed resources (protected; never implicit)")
    .requiredOption("--target <keys...>", "logical key(s) to destroy (repeatable or comma-separated)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("--backup-dir <path>", "directory for the pre-destroy backup (or set CT_BACKUP_DIR)")
    .option("--force", "skip the typed confirmation (preventDestroy is still enforced)")
    .action(async (opts: DestroyOptions) => {
      const targets = parseTargets(opts.target ?? []);
      if (targets.length === 0) {
        throw new Error("No --target given. Destroy never deletes implicitly.");
      }

      const config = resolveConfig();
      const statePath = resolveStatePath(opts.state);
      const state = await loadState(statePath, config.host);

      for (const key of targets) {
        if (!state.resources[key]) {
          throw new Error(`"${key}" is not managed (not in the state file). Nothing to destroy.`);
        }
      }

      // preventDestroy guard: a target still declared with the flag is blocked.
      const desired = await loadConfig(resolveConfigPath(opts.config));
      const protectedKeys = new Set(desired.filter((d) => d.preventDestroy).map((d) => d.key));
      const blocked = targets.filter((k) => protectedKeys.has(k));
      if (blocked.length > 0) {
        throw new Error(
          `preventDestroy is set for: ${blocked.join(", ")}. Remove the flag in config first.`,
        );
      }

      const ordered = orderDestroy(state, targets);
      const { client } = await authedSession();

      // Backup: fetch each target's current actual values (best-effort; 404 → skip).
      const actual = new Map<string, Record<string, unknown>>();
      for (const key of ordered) {
        const managed = state.resources[key]!;
        const spec = RESOURCES[managed.type];
        if (!spec) {
          continue;
        }
        try {
          const raw = await client.get<Record<string, unknown>>(spec.itemPath(managed.id));
          actual.set(key, spec.managedFields(raw));
        } catch (err) {
          if (!(err instanceof CtApiError && err.status === 404)) {
            throw err;
          }
        }
      }
      const backupPath = await writeBackup(resolveBackupDir(opts.backupDir, statePath), config.host, actual);
      info(`Backup written: ${backupPath}`);

      warn(`About to DELETE: ${ordered.join(", ")}`);
      const expected = targets.length === 1 ? targets[0]! : "destroy";
      const ok = await confirmTyped(expected, { force: opts.force });
      if (!ok) {
        warn("Aborted — nothing deleted.");
        process.exitCode = 1;
        return;
      }

      for (const key of ordered) {
        const managed = state.resources[key]!;
        const spec = RESOURCES[managed.type];
        if (!spec) {
          error(`No write spec for type "${managed.type}" — skipping ${key}.`);
          continue;
        }
        const path = spec.itemPath(managed.id);
        assertNotPeople(path);
        await client.request("DELETE", path);
        delete state.resources[key];
        await saveState(statePath, state);
        success(`Destroyed ${managed.type}.${key} (#${managed.id})`);
      }
    });
}
