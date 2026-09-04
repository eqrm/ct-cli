import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { authedSession, type AuthedSession } from "../../api/session.js";
import type { CtClient } from "../../api/ctClient.js";
import { assertNotPeople } from "../../engine/guard.js";
import { buildAdoptedGrants, type AdoptedGrantsBlock } from "../../permissions/adopt.js";
import type { DomainType, RawPermission } from "../../permissions/grants.js";
import { fetchPermissionRows, type PermissionReader } from "../../permissions/fetch.js";
import { CATALOG_DIR, loadHostCatalog } from "../../permissions/catalog-store.js";
import { declarability, decodeGroupsWithRoles, type RoleInstance } from "../../coverage/report.js";
import { slug } from "../../resources/registry.js";
import { loadState, type State } from "../../state/state.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";
import { noopObserver, type OperationObserver } from "../ports.js";

export interface AdoptGrantsRequest extends ProjectRequest {
  domainType?: string;
  domainId?: string;
  group?: string;
  allDeclarable?: boolean;
  write?: string;
}

export type AdoptGrantsResult = OperationResult<{
  blocks: AdoptedGrantsBlock[];
  text: string;
  writtenPath: string | null;
  permissionCatalogPath: string | null;
  summary: string | null;
}>;

interface BulkEmission {
  blocks: AdoptedGrantsBlock[];
  warnings: CtWarning[];
  summary: string;
}

/** Accept the DSL's `group_role` and the hyphenated CLI-friendly `group-role`; reject anything else. */
function normalizeDomainType(raw: string): DomainType {
  const t = raw.trim().replace(/-/g, "_");
  if (t === "group_role" || t === "group_type_role" || t === "status") return t;
  throw new Error(
    `Invalid domain type "${raw}" — expected "group_role", "group_type_role" or "status" (people domains are never managed).`,
  );
}

/**
 * `ct adopt grants` — read live permission rows and print paste-ready config blocks. Grants are NOT
 * state-tracked, so this prints config only; it never writes the state file (contrast `ct adopt`).
 *
 * Single form (unchanged): `ct adopt grants group_role 44675`.
 *
 * Bulk forms (#104): adopting the declarable estate of a real instance meant 44 invocations and 44
 * manual pastes, each needing its `key` renamed and its emitted numeric `id:` swapped for the portable
 * `group` + `role` pair — exactly the two edits a human forgets on the 30th paste. So:
 *
 *  - `--group <keyOrId>` emits every role instance of one group, `--all-declarable` every declarable
 *    one on the host;
 *  - the portable `group` + `role` form is emitted by default whenever the group is managed, and the
 *    key is derived from (group key, role name) rather than being `group_role_44675`;
 *  - a block that would REVOKE live grants is never emitted silently in bulk — it is skipped and
 *    summarised, because the WARNING footer that protects the single form cannot protect a 44-block
 *    paste that nobody reads to the end.
 */
export interface AdoptGrantsDependencies {
  observer?: OperationObserver;
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadState?: typeof loadState;
  loadHostCatalog?: typeof loadHostCatalog;
  authedSession?: () => Promise<AuthedSession>;
  appendFile?: typeof appendFile;
}

export async function runAdoptGrants(
  opts: AdoptGrantsRequest,
  dependencies: AdoptGrantsDependencies = {},
): Promise<AdoptGrantsResult> {
  const bulk = opts.group !== undefined || opts.allDeclarable === true;
  if (bulk && (opts.domainType !== undefined || opts.domainId !== undefined)) {
    throw new Error(
      "Specify either a <domainType> <domainId> pair or a bulk selector (--group / --all-declarable), not both.",
    );
  }
  if (opts.group !== undefined && opts.allDeclarable) {
    throw new Error("Specify only one of: --group, --all-declarable.");
  }

  // Load + validate the state file (host guard) BEFORE any network call, mirroring `ct adopt`,
  // so a state file recorded against another instance never triggers a request to the wrong host.
  const project = await (dependencies.resolveProject ?? resolveProject)(opts, dependencies.project);
  const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
  // Bulk selection runs the same declarability verdict as `ct coverage` (over the effective
  // rather than the authored rows — see the call below), so it needs this host's catalog for
  // the same reason (#105): under the bundled one, `--all-declarable`
  // silently SKIPS role instances `ct plan` would manage, filed under an authId the active
  // catalog can name perfectly well.
  const hostCatalog = await (dependencies.loadHostCatalog ?? loadHostCatalog)(
    project.host,
    resolve(project.cwd, CATALOG_DIR),
  );
  const { client } = await (dependencies.authedSession ?? authedSession)();

  const bulkEmission = bulk ? await emitBulk(client, state, opts) : null;
  const emitted = bulkEmission?.blocks ?? [await emitSingle(client, state, opts.domainType, opts.domainId)];

  const text = `${emitted.map((e) => e.block).join("\n\n")}\n`;
  // Assembled and reported BEFORE the append: a failing `--write` must not swallow the record of
  // what the emission silently skipped (#156 review).
  const warnings = [...(bulkEmission?.warnings ?? [])];
  if (emitted.some((e) => e.omitted > 0)) {
    warnings.push({
      code: "ADOPT_GRANT_OMITTED",
      message:
        "Any grant left as a WARNING/NOTE comment in the block is still LIVE on the instance but absent " +
        "from the declaration — applying the block will REVOKE it. Resolve every comment first; `ct plan` " +
        "is only a no-op once none remain.",
    });
  }
  const observer = dependencies.observer ?? noopObserver;
  for (const warning of warnings) observer.emit({ type: "warning", warning });

  let writtenPath: string | null = null;
  if (opts.write) {
    writtenPath = resolve(project.cwd, opts.write);
    await (dependencies.appendFile ?? appendFile)(writtenPath, text, "utf8");
  }
  return {
    operation: "adopt",
    project,
    warnings,
    value: {
      blocks: emitted,
      text,
      writtenPath,
      permissionCatalogPath: hostCatalog,
      summary: bulkEmission?.summary ?? null,
    },
  };
}

/** The original single-domain form: `ct adopt grants <domainType> <domainId>`. */
async function emitSingle(
  client: PermissionReader,
  state: State,
  rawType: string | undefined,
  rawId: string | undefined,
): Promise<AdoptedGrantsBlock> {
  if (rawType === undefined || rawId === undefined) {
    throw new Error(
      "Specify <domainType> <domainId>, or a bulk selector (--group <keyOrId> / --all-declarable).",
    );
  }
  const domainType = normalizeDomainType(rawType);
  if (!/^\d+$/.test(rawId.trim())) {
    throw new Error(`Invalid domainId "${rawId}" — expected a non-negative integer.`);
  }
  const domainId = Number.parseInt(rawId, 10);
  const path = `/permissions/${domainType}/${domainId}`;
  assertNotPeople(path); // belt-and-suspenders: the domain-type guard already excludes people
  const rows = await fetchPermissionRows(client, path);
  return buildAdoptedGrants({ domainType, domainId, rows, state });
}

/**
 * Bulk emission (#104). Selects role instances, then emits each one in the portable form.
 *
 * Blocks that would revoke live grants are dropped and summarised rather than printed: in bulk the
 * per-block WARNING header stops being a safeguard and becomes noise the reader scrolls past.
 */
async function emitBulk(
  client: PermissionReader & Pick<CtClient, "getAll">,
  state: State,
  opts: AdoptGrantsRequest,
): Promise<BulkEmission> {
  const [groupRows, roleDefRows] = await Promise.all([
    // `?include[]=roles` turns one role lookup per group into a handful of paged calls (#103).
    client.getAll<Record<string, unknown>>("/groups?include[]=roles"),
    client.getAll<Record<string, unknown>>("/group/roles"),
  ]);
  const roleNamesById = new Map<number, string>();
  for (const r of roleDefRows.data) {
    const id = Number(r.id);
    if (Number.isFinite(id) && typeof r.name === "string") roleNamesById.set(id, r.name);
  }
  const groups = decodeGroupsWithRoles(groupRows.data, roleNamesById);
  // Guarded read (see permissions/fetch.ts): a silent first page here would drop most role instances
  // into the "no authored grants" bucket, which reads identically to a correct run.
  const permissions = await fetchPermissionRows(client, "/permissions/group_role");
  const rowsByDomainId = new Map<number, RawPermission[]>();
  for (const row of permissions) {
    const list = rowsByDomainId.get(row.domainId);
    if (list) list.push(row);
    else rowsByDomainId.set(row.domainId, [row]);
  }

  const managedKeyByGroupId = new Map<number, string>();
  for (const r of Object.values(state.resources)) {
    if (r.type === "group") managedKeyByGroupId.set(r.id, r.key);
  }

  let candidates: RoleInstance[];
  if (opts.group !== undefined) {
    const groupId = resolveGroupSelector(opts.group, groups, state);
    candidates = groups.filter((g) => g.id === groupId).flatMap((g) => g.roles);
    if (candidates.length === 0) {
      throw new Error(`--group "${opts.group}" resolved to group #${groupId}, which has no role instances.`);
    }
  } else {
    candidates = groups.flatMap((g) => g.roles);
  }

  const blocks: AdoptedGrantsBlock[] = [];
  const skippedUndeclarable: string[] = [];
  const skippedWouldRevoke: string[] = [];
  let skippedEmpty = 0;

  for (const role of candidates) {
    const rows = rowsByDomainId.get(role.domainId) ?? [];
    // Judged on the EFFECTIVE set, because that is what `buildAdoptedGrants` emits (#114/#119). An
    // owned-rows verdict here would disagree with the emitter in both directions: it would skip a
    // domain whose rights are all inherited on THIS host (18 of 63 group_role domains, measured) and
    // leave them undeclared for the other one to revoke, and it would wave through an inherited grant
    // on a dimension with no logical form, which the gate below exists to stop.
    const verdict = declarability(rows, { scope: "effective" });
    if (verdict.grantCount === 0) {
      skippedEmpty += 1;
      continue; // nothing authored on this domain — an empty block is not worth a paste
    }
    const label = `${role.groupName} / ${role.roleName} (domainId ${role.domainId})`;
    // Skipped in EVERY bulk mode, not just --all-declarable: a role instance with a grant on a
    // dimension ct has no resource for can only be written as a host-specific number, and a bulk paste
    // is exactly where that quietly becomes a cross-environment misgrant. The single form
    // (`ct adopt grants group_role <domainId>`) still emits it, deliberately, one domain at a time.
    if (!verdict.declarable) {
      skippedUndeclarable.push(
        `${label}: blocked by ${[...verdict.blockedBy, ...verdict.unknownAuthIds.map((a) => `authId ${a}`)].join(", ")}`,
      );
      continue;
    }
    const groupKey = managedKeyByGroupId.get(role.groupId);
    const built = buildAdoptedGrants({
      domainType: "group_role",
      domainId: role.domainId,
      rows,
      state,
      domain: groupKey ? { group: groupKey, role: role.roleName } : undefined,
      key: groupKey ? `${groupKey}_${slug(role.roleName)}` : undefined,
    });
    if (built.omitted > 0) {
      skippedWouldRevoke.push(`${label}: ${built.omitted} live grant(s) cannot be expressed as config`);
      continue;
    }
    blocks.push(built);
  }

  if (blocks.length === 0 && skippedWouldRevoke.length === 0 && skippedUndeclarable.length === 0) {
    throw new Error("No role instance with authored grants matched — nothing to emit.");
  }

  const summary =
    `${blocks.length} block(s) emitted · ${skippedWouldRevoke.length} skipped (would revoke live grants) · ` +
    `${skippedUndeclarable.length} skipped (not declarable) · ${skippedEmpty} skipped (no authored grants)`;
  const warnings: CtWarning[] = [];
  // Never a silent cap: what was NOT emitted is listed, so "44 blocks" can't quietly mean "44 of 59".
  for (const line of skippedWouldRevoke) {
    warnings.push({
      code: "ADOPT_GRANT_SKIPPED",
      message: `skipped ${line} — adopt the missing scope target(s), then re-run for this domain`,
    });
  }
  for (const line of skippedUndeclarable) {
    warnings.push({
      code: "ADOPT_GRANT_SKIPPED",
      message:
        `skipped ${line} — own the rest with \`preserveUnknown: [<dimension>]\` (#102), or emit it ` +
        `deliberately with the single form`,
    });
  }
  return { blocks, warnings, summary };
}

/** Resolve `--group` to a live group id: numeric id, adopted-state logical key, or live name/slug. */
function resolveGroupSelector(
  raw: string,
  groups: Array<{ id: number; name: string }>,
  state: State,
): number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const managed = state.resources[trimmed];
  if (managed && managed.type === "group") return managed.id;
  const bySlug = groups.filter((g) => slug(g.name) === slug(trimmed));
  const candidates = bySlug.length > 0 ? bySlug : groups.filter((g) => g.name === trimmed);
  if (candidates.length === 0) {
    throw new Error(
      `--group "${raw}": not adopted (no state entry) and no live group matches (checked by slug and exact name).`,
    );
  }
  if (candidates.length > 1) {
    const listed = candidates.map((c) => `${JSON.stringify(c.name)} (#${c.id})`).join(", ");
    throw new Error(`--group "${raw}" is ambiguous: ${candidates.length} live groups match — ${listed}.`);
  }
  return candidates[0]!.id;
}
