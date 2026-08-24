import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { CtApiError, type CtClient } from "../api/ctClient.js";
import { resolveConfig } from "../config.js";
import { prepareEnv } from "../env/context.js";
import { loadState, saveState, type State } from "../state/state.js";
import { RESOURCES, type CtWriteClient } from "../resources/registry.js";
import { assertNotPeople } from "../engine/guard.js";
import { orderKeys } from "../engine/graph.js";
import { fetchActual } from "../engine/build.js";
import { parentIdsByGroupId, managedParentKeys, type HierarchyEntry } from "../engine/hierarchy.js";
import type { DesiredResource } from "../engine/types.js";
import { writeBackup } from "../engine/backup.js";
import {
  groupScopedRows,
  memberFieldStateKey,
  matchesLocalKey,
  memberFieldItemPath,
  memberFieldRowId,
  memberFieldsReadPath,
  parseMemberFieldIdentity,
} from "../engine/member-fields.js";
import { resolveBackupDir } from "./apply.js";
import { confirmTyped, confirmEnv } from "../ui/prompt.js";
import { info, warn, success, error, formatError } from "../ui.js";

interface DestroyOptions {
  target?: string[];
  /** Group-scoped member fields to delete, by their portable `<groupKey>::<fieldKey>` identity (#135). */
  memberField?: string[];
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
    warn(
      `Failed to fetch group hierarchies for destroy ordering: ${formatError(err)}. Falling back to tier-only order.`,
    );
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
/** One `--member-field` target, resolved against state. */
export interface MemberFieldTarget {
  /** The portable `<groupKey>::<fieldKey>` identity, as typed. */
  identity: string;
  groupKey: string;
  fieldKey: string;
  groupId: number;
}

/**
 * Resolve `--member-field <group>::<field>` targets against the state file (#135).
 *
 * This is the EXPLICIT destructive operation a group member field can only ever be removed by.
 * `apply` never deletes one — a field dropped from config produces no desired key at all, so the
 * diff engine is structurally unable to propose it (see engine/synthetic.ts) — and `ct destroy
 * --target` addresses whole managed resources, which a member field is not: it has no state entry
 * of its own because it belongs to exactly one group.
 *
 * Guardrails are the group's: the owning group must be managed, and `preventDestroy` on it blocks
 * its fields too — protecting a group protects what it owns.
 */
export function resolveMemberFieldTargets(state: State, raw: string[]): MemberFieldTarget[] {
  const out: MemberFieldTarget[] = [];
  for (const identity of parseTargets(raw)) {
    const parsed = parseMemberFieldIdentity(identity);
    if (!parsed) {
      throw new Error(
        `"${identity}" is not a group member field identity. Use "<groupKey>::<fieldKey>" ` +
          `(e.g. "ojbp_2026_27_praktikum_1::wahl").`,
      );
    }
    const managed = state.resources[parsed.group];
    if (!managed || managed.type !== "group") {
      throw new Error(
        `"${identity}": no managed group "${parsed.group}" in the state file. A member field can only ` +
          `be destroyed through the group that owns it.`,
      );
    }
    if (managed.preventDestroy) {
      throw new Error(
        `preventDestroy is set (in state) for group "${parsed.group}", which owns "${identity}". ` +
          `Clear the protection first — protecting a group protects its member fields too.`,
      );
    }
    out.push({
      identity,
      groupKey: parsed.group,
      fieldKey: parsed.field,
      groupId: managed.id,
    });
  }
  return out;
}

/**
 * Delete each resolved member field, dropping its id from the owning group's state entry and saving
 * after every success. A field that is already gone in ChurchTools (no live row, or a 404 on the
 * DELETE) is success-with-note, mirroring `runDeleteLoop`; any other error stops the run with state
 * saved up to that point.
 *
 * Returns `false` if ANY target failed — including the ones that only skip ahead to the next target
 * — so the caller can hold back the group deletes that follow. That gate matters: the groups being
 * destroyed are the very groups these fields belong to, so carrying on would delete a field the run
 * just reported it could not delete, and the printed "Nothing further was deleted" would be a lie.
 */
export async function runMemberFieldDeleteLoop(ctx: {
  client: Pick<CtClient, "get" | "request">;
  state: State;
  statePath: string;
  targets: MemberFieldTarget[];
  save?: (path: string, state: State) => Promise<void>;
}): Promise<boolean> {
  const { client, state, statePath, targets } = ctx;
  const save = ctx.save ?? saveState;
  let ok = true;
  for (const target of targets) {
    const forget = async (): Promise<void> => {
      const managed = state.resources[target.groupKey];
      // Slugged, exactly as the apply that wrote it keyed the entry (`memberFieldStateKey`) and as
      // `matchesLocalKey` matched the live row — otherwise `--member-field g::Wahl` deletes the
      // field in ChurchTools but leaves `memberFields.wahl` pointing at the id it just destroyed.
      const stateKey = memberFieldStateKey(target.fieldKey);
      if (managed?.memberFields && stateKey in managed.memberFields) {
        const rest = { ...managed.memberFields };
        delete rest[stateKey];
        if (Object.keys(rest).length > 0) managed.memberFields = rest;
        else delete managed.memberFields;
      }
      await save(statePath, state);
    };
    let fieldId: number | undefined;
    try {
      const rows = groupScopedRows(await client.get(memberFieldsReadPath(target.groupId)));
      const matches = rows.filter((row) => matchesLocalKey(row, target.fieldKey));
      if (matches.length > 1) {
        error(
          `${target.identity}: ${matches.length} member fields on group #${target.groupId} answer to ` +
            `"${target.fieldKey}" — refusing to guess which one to delete. Rename one in ChurchTools first.`,
        );
        process.exitCode = 1;
        ok = false;
        continue;
      }
      fieldId = matches.length === 1 ? memberFieldRowId(matches[0]!) : undefined;
    } catch (err) {
      error(`Stopped at ${target.identity}: ${formatError(err)}. Nothing further was deleted.`);
      process.exitCode = 1;
      return false;
    }
    if (fieldId === undefined) {
      await forget();
      success(`${target.identity} already absent in ChurchTools — nothing to delete`);
      continue;
    }
    const path = memberFieldItemPath(target.groupId, fieldId);
    assertNotPeople(path);
    try {
      await client.request("DELETE", path);
    } catch (err) {
      if (err instanceof CtApiError && err.status === 404) {
        await forget();
        success(`${target.identity} (#${fieldId}) already deleted in ChurchTools`);
        continue;
      }
      error(
        `Stopped at ${target.identity}: ${formatError(err)}. State saved up to this point — re-run to resume.`,
      );
      process.exitCode = 1;
      return false;
    }
    await forget();
    success(`Destroyed group member field ${target.identity} (#${fieldId})`);
  }
  return ok;
}

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
    .option("--target <keys...>", "logical key(s) to destroy (repeatable or comma-separated)")
    .option(
      "--member-field <identities...>",
      "group member field(s) to destroy, by portable identity <groupKey>::<fieldKey> (#135) — the " +
        "ONLY way one is ever deleted; apply never removes a field that vanished from config",
    )
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--confirm-env <name>", "confirm a protected env non-interactively (must match --env exactly)")
    .option("--backup-dir <path>", "directory for the pre-destroy backup (or set CT_BACKUP_DIR)")
    .option(
      "--force",
      "skip the typed confirmation (preventDestroy — and a type-level destroy warning, e.g. person-status — is still enforced)",
    )
    .action(async (opts: DestroyOptions) => {
      const targets = parseTargets(opts.target ?? []);
      const memberFieldArgs = parseTargets(opts.memberField ?? []);
      if (targets.length === 0 && memberFieldArgs.length === 0) {
        throw new Error("No --target or --member-field given. Destroy never deletes implicitly.");
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

      // Member fields (#135) are resolved against state BEFORE any network call, so a malformed
      // identity, an unmanaged group or a preventDestroy'd owner stops the run without touching CT.
      const memberFieldTargets = resolveMemberFieldTargets(state, memberFieldArgs);

      const { client } = await authedSession();

      const parentEdges = await fetchParentEdges(client, state, targets);
      const ordered = orderDestroy(state, targets, parentEdges);

      // Backup: fetch each target's current actual values via the same fetchActual as plan/apply
      // (404 → skip: already gone in CT, nothing to back up). A non-404 failure must ABORT before
      // any DELETE — proceeding would irreversibly delete a target with no backup of its state.
      const { actual, fetchErrors } = await fetchActual(
        client,
        ordered.map((k) => state.resources[k]!),
      );
      if (fetchErrors.length > 0) {
        error(
          `Backup fetch failed for: ${fetchErrors.join("; ")}. ` +
            `Nothing was deleted — resolve the error (or wait out the outage) and re-run.`,
        );
        process.exitCode = 1;
        return;
      }
      // Member-field definitions go into the SAME backup, under their portable identity, so an
      // explicit teardown of one is as recoverable as any managed resource.
      for (const target of memberFieldTargets) {
        try {
          const rows = groupScopedRows(await client.get(memberFieldsReadPath(target.groupId)));
          const match = rows.find((row) => matchesLocalKey(row, target.fieldKey));
          if (match) actual.set(target.identity, match);
        } catch (err) {
          error(
            `Backup fetch failed for ${target.identity}: ${formatError(err)}. Nothing was deleted — ` +
              `resolve the error and re-run.`,
          );
          process.exitCode = 1;
          return;
        }
      }
      const backupPath = await writeBackup(resolveBackupDir(opts.backupDir, statePath), config.host, actual);
      info(`Backup written: ${backupPath}`);

      warn(`About to DELETE: ${[...ordered, ...memberFieldTargets.map((t) => t.identity)].join(", ")}`);
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
      const expected =
        targets.length === 1 && memberFieldTargets.length === 0
          ? targets[0]!
          : targets.length === 0 && memberFieldTargets.length === 1
            ? memberFieldTargets[0]!.identity
            : "destroy";
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

      // Member fields FIRST: they are owned by their group, so deleting the group would take them
      // with it and the explicit per-field record would be lost.
      if (memberFieldTargets.length > 0) {
        const fieldsDone = await runMemberFieldDeleteLoop({
          client,
          state,
          statePath,
          targets: memberFieldTargets,
        });
        if (!fieldsDone) {
          // A field that could not be deleted must not be deleted anyway as collateral of its
          // owning group's destroy — and the user was just told nothing further would happen.
          if (ordered.length > 0) {
            error(`Not destroying ${ordered.join(", ")} — a member field on it could not be deleted first.`);
          }
          return;
        }
      }
      if (ordered.length > 0) {
        await runDeleteLoop({ client, state, statePath, ordered });
      }
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
      // Skipped, not destroyed: the resource is still in ChurchTools AND still in state, so exit
      // non-zero like every other failure below — a `ct destroy` that reports success while its
      // targets survive is the one outcome a caller must never see.
      error(`No write spec for type "${managed.type}" — skipping ${key}.`);
      process.exitCode = 1;
      continue;
    }
    const path = spec.itemPath(managed.id);
    assertNotPeople(path);
    try {
      if (spec.writer) {
        // A type whose writes are not REST (#108: Bereiche). Without a `remove` it has no delete path
        // at all — say so instead of issuing a DELETE the endpoint does not implement, which would
        // 404/405 and read as "already deleted".
        if (!spec.writer.remove) {
          error(
            `${managed.type}.${key} (#${managed.id}) cannot be deleted by \`ct\` — ChurchTools exposes ` +
              `no delete for this type. Remove it in the ChurchTools admin UI, then re-run to drop it ` +
              `from state.`,
          );
          // Still in ChurchTools and still in state — a skip, not a success. Exit non-zero.
          process.exitCode = 1;
          continue;
        }
        await spec.writer.remove({ client: client as CtWriteClient, id: managed.id });
      } else {
        await client.request("DELETE", path);
      }
    } catch (err) {
      if (err instanceof CtApiError && err.status === 404) {
        delete state.resources[key];
        await save(statePath, state);
        success(
          `${managed.type}.${key} (#${managed.id}) already deleted in ChurchTools — removed from state`,
        );
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
