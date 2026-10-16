/** Orchestration for `ct export tf`: state in, .tf files out. */
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertLabelsUnique, hclLabel, hclType, REFERENCE_FIELDS, renderResource } from "../../export/hcl.js";
import { renderImports, type ImportTarget } from "../../export/imports.js";
import { EXPORTABLE_TYPES, fileForType } from "../../export/layout.js";
import { renderVersions } from "../../export/provider.js";
import { CATALOG_DIR } from "../../permissions/catalog-store.js";
import { loadIdMap, writeIdMap, type IdMap, type IdMapEntry } from "../../resolve/idMap.js";
import { loadState, type ManagedResource } from "../../state/state.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { resolveProject } from "../project.js";

export interface ExportTfRequest extends ProjectRequest {
  only?: string[];
  outDir: string;
  /**
   * Write (and own) `versions.tf`. Default true: the output is then a runnable
   * root module, which is what a first-time migration needs.
   *
   * Set false when the consumer owns that file. A provider VERSION CONSTRAINT
   * lives inside `required_providers` and has nowhere else to go, so owning
   * the file unconditionally makes pinning impossible — and a consumer who
   * puts a backend there loses it silently on the next export.
   *
   * When false, `versions.tf` is neither written nor touched.
   */
  writeVersions?: boolean;
  /**
   * Also write `.ct/ids.<host>.json`, the committed key→id map ct resolves leftover references
   * through once these resources are no longer in its state (#181). Default true: every export is a
   * step towards ct not declaring these any more, and that is exactly when the map becomes load-bearing.
   *
   * Written OUTSIDE `outDir`, beside the per-instance permission catalog, because it is ct's input,
   * not part of the tofu root module.
   */
  writeIds?: boolean;
}

export interface ExportTfValue {
  files: string[];
  imported: number;
  /** Keys that could not be used verbatim as an HCL identifier. */
  relabelled: { key: string; label: string }[];
  /** Managed types the provider has no mapping for yet, with how many were skipped. */
  skipped: { type: string; count: number }[];
  /** Path of the id map written beside the export, or null when `--no-ids` was passed. */
  idMapPath: string | null;
}

export type ExportTfResult = OperationResult<ExportTfValue>;

/**
 * Sort key for both the resource blocks and the import blocks.
 *
 * The two files MUST agree, and both must be byte-stable across runs: state is
 * a JSON object, so its iteration order shifts when a resource is re-keyed
 * (`upsert` re-inserts at the end) and integer-like keys sort ahead of the rest
 * regardless of insertion order. Plain byte order, never `localeCompare` —
 * locale collation puts "a-b" after "a_b" while bytes put it before, so a
 * locale-sorted golden cannot pin what is written.
 */
function address(type: string, key: string): string {
  return `${hclType(type)}.${hclLabel(key)}`;
}

/**
 * Keep the id-map entries a PARTIAL export never looked at (#181).
 *
 * `--only campus` describes campuses and nothing else, but the map it writes is the whole file — so
 * rewriting it from this run's entries alone drops every `person-status`, `group-type` and
 * `department` id the previous export put there. Those are exactly the entries that keep a leftover
 * `personStatus: "status_unbekannt"` resolving once tier-0 leaves ct's state, and their keys are not
 * name-derived, so the live-name fallback cannot cover for them: the next `ct plan` hard-errors.
 *
 * So the export UPSERTS: an entry this run exported replaces the previous entry with the same key or
 * the same id, and every other previous entry is carried over untouched. It never drops an id on its
 * own. Neither "selected but absent from state" nor "absent while others of its type are present"
 * means the id is dead: after a tier's cutover tofu owns those rows, and a single row of the type
 * coming back into ct's state (an adopt, a straggler on one host) must not wipe the rest of the type.
 * Pruning ids that really are gone is `ct ids sync --tofu-state`'s job, which reads the authoritative
 * source. The cost is that an id ct deleted outright lingers until that sync, and a reference to it
 * then fails at plan time rather than at export.
 */
async function carryOverUncoveredIds(
  host: string,
  dir: string,
  fresh: readonly IdMapEntry[],
): Promise<IdMapEntry[]> {
  const previous = await loadIdMap(host, dir);
  if (!previous) return [...fresh];
  const keys = new Set(fresh.map((e) => `${e.type}\u0000${e.key}`));
  const ids = new Set(fresh.map((e) => `${e.type}\u0000${e.id}`));
  const kept = previous.entries.filter(
    (e) => !keys.has(`${e.type}\u0000${e.key}`) && !ids.has(`${e.type}\u0000${e.id}`),
  );
  return [...kept, ...fresh];
}

/**
 * Resolves the id in a reference field ({@link REFERENCE_FIELDS}) to the tofu address of the
 * resource it points at.
 *
 * ct's own state first, then the committed id map — which, after a tier's cutover, is the only
 * place ct can still learn that campus 6 is `churchtools_campus.nord` on this host. The map is
 * loaded only when state cannot answer, so an export that needs no reference never reads it (and a
 * corrupt map fails only the export that depends on it).
 *
 * A miss is collected, not guessed at: falling back to the number would export an HCL file that is
 * right on this host and silently wrong on the other one.
 */
function referenceResolver(rows: readonly ManagedResource[], loadMap: () => Promise<IdMap | null>) {
  const fromState = new Map<string, string>();
  for (const r of rows) fromState.set(`${r.type}\u0000${r.id}`, r.key);
  let map: Promise<Map<string, string>> | null = null;
  const fromMap = () =>
    (map ??= loadMap().then((loaded) => {
      const byId = new Map<string, string>();
      // The label the map recorded is the address tofu actually has; re-deriving it from the key
      // would agree today, but only for as long as hclLabel never changes.
      for (const e of loaded?.entries ?? []) byId.set(`${e.type}\u0000${e.id}`, e.label ?? hclLabel(e.key));
      return byId;
    }));
  return async (type: string, id: number): Promise<string | null> => {
    const fromStateKey = fromState.get(`${type}\u0000${id}`);
    const label =
      fromStateKey !== undefined ? hclLabel(fromStateKey) : (await fromMap()).get(`${type}\u0000${id}`);
    return label === undefined ? null : `${hclType(type)}.${label}.id`;
  };
}

export async function runExportTf(request: ExportTfRequest): Promise<ExportTfResult> {
  // resolveProject gives the env profile's state path AND the host the state
  // must belong to; loadState asserts that pairing, so an export can never
  // silently mix instances. No network and no auth: this reads state only.
  const project = await resolveProject(request);
  const state = await loadState(project.statePath, project.host);

  // An unknown --only value used to filter everything out, write an empty
  // imports.tf over a good one and exit 0 saying "0 resources exported".
  const unknown = (request.only ?? []).filter((type) => !EXPORTABLE_TYPES.includes(type));
  if (unknown.length > 0) {
    throw new Error(
      `export: unknown resource type(s) ${unknown.map((t) => `"${t}"`).join(", ")}. ` +
        `Exportable types: ${EXPORTABLE_TYPES.join(", ")}.`,
    );
  }
  const types = request.only?.length ? request.only : EXPORTABLE_TYPES;

  const rows = Object.values(state.resources);
  const selected = rows.filter((r) => types.includes(r.type));
  assertLabelsUnique(selected);

  // Types the export has no provider mapping for are NOT the same as types the
  // user filtered out with --only: the first is a gap the user has to be told
  // about, because their `tofu plan` would propose creating every one of them.
  const skippedCounts = new Map<string, number>();
  for (const resource of rows) {
    if (EXPORTABLE_TYPES.includes(resource.type)) continue;
    skippedCounts.set(resource.type, (skippedCounts.get(resource.type) ?? 0) + 1);
  }
  const skipped = [...skippedCounts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, count]) => ({ type, count }));

  const catalogDir = join(project.cwd, CATALOG_DIR);
  const resolveReference = referenceResolver(rows, () => loadIdMap(project.host, catalogDir));
  const unresolved: string[] = [];
  // A group adopted before campus was a managed field has no `campusId` in state at all. The export
  // can only write "no campus" for it, and if the live group HAS a campus, `tofu plan` then proposes
  // clearing it — exactly what the zero-change gate is there to catch, so say so up front.
  const campusUnknown = selected
    .filter((r) => r.type === "group" && !("campusId" in r.fields))
    .map((r) => r.key);

  const byFile = new Map<string, string[]>();
  const imports: ImportTarget[] = [];
  const relabelled: { key: string; label: string }[] = [];
  const idEntries: IdMapEntry[] = [];

  for (const resource of [...selected].sort((a, b) => {
    const left = address(a.type, a.key);
    const right = address(b.type, b.key);
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    const references: Record<string, string> = {};
    for (const [field, target] of Object.entries(REFERENCE_FIELDS[resource.type] ?? {})) {
      const id = resource.fields[field];
      if (id === null || id === undefined) continue; // omitted by the renderer, nothing to point at
      // Anything else that is not a number would be written as a literal by the renderer — the
      // cross-host bug references exist to prevent — so it is an error, not a skip.
      if (typeof id !== "number") {
        unresolved.push(
          `${resource.type} "${resource.key}": ${field} = ${JSON.stringify(id)} is not a numeric id`,
        );
        continue;
      }
      const expr = await resolveReference(target, id);
      if (expr === null) unresolved.push(`${resource.type} "${resource.key}": ${field} = ${id} (${target})`);
      else references[field] = expr;
    }
    const block = renderResource(resource.type, resource.key, resource.fields, {
      preventDestroy: resource.preventDestroy,
      references,
    });
    const file = fileForType(resource.type);
    byFile.set(file, [...(byFile.get(file) ?? []), block]);
    imports.push({ type: resource.type, key: resource.key, id: resource.id });

    // The label the renderer actually produced, read back out of the block so
    // the report cannot drift from what was written.
    const label = block.split('"')[3];
    if (label !== undefined && label !== resource.key) relabelled.push({ key: resource.key, label });
    // The id map is built from the same loop, so it cannot describe a different set of resources
    // than the HCL and the import blocks do. The label rides along so a later `ct ids sync` can map
    // a tofu address back to the ct key (the relabelling is many-to-one, #181).
    idEntries.push({
      type: resource.type,
      key: resource.key,
      id: resource.id,
      ...(label !== undefined && label !== resource.key ? { label } : {}),
    });
  }

  if (unresolved.length > 0) {
    throw new Error(
      `export: ${unresolved.length} reference(s) cannot be written: the id is not numeric, or is neither in ct's state nor in ` +
        `the id map for ${project.host}:\n  ${unresolved.join("\n  ")}\n` +
        `Refresh the map from tofu first (\`tofu state pull | ct ids sync --tofu-state -\`). A literal id ` +
        `would be right on this host and wrong on the other one, so the export does not fall back to it.`,
    );
  }

  const outDir = isAbsolute(request.outDir) ? request.outDir : join(project.cwd, request.outDir);
  await mkdir(outDir, { recursive: true });

  const written: string[] = [];
  for (const [file, blocks] of [...byFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    await writeFile(join(outDir, file), blocks.join("\n"), "utf8");
    written.push(file);
  }
  await writeFile(join(outDir, "imports.tf"), renderImports(imports), "utf8");
  written.push("imports.tf");
  const writeVersions = request.writeVersions ?? true;
  if (writeVersions) {
    await writeFile(join(outDir, "versions.tf"), renderVersions(), "utf8");
    written.push("versions.tf");
  }

  // No pruning. A type's file that this run did not write is left alone: once a tier has moved to
  // OpenTofu its resources are no longer in ct's state, so "not exported this run" means "owned by
  // tofu now", not "stale". Deleting `campuses.tf` because tier 0 left ct's state would ask tofu to
  // destroy every campus (#109) — the same reason the id map below is never emptied.

  let idMapPath: string | null = null;
  let idMapKept = false;
  if (request.writeIds ?? true) {
    const entries = await carryOverUncoveredIds(project.host, catalogDir, idEntries);
    const existing = idEntries.length === 0 ? await loadIdMap(project.host, catalogDir) : null;
    // Never replace a POPULATED map with an empty one — the same guard `ct ids sync` has, for the
    // same reason, and the case is not exotic here: it is the END STATE. Once tier-0 has left
    // `ct.config.ts` and the state file, ct holds none of these resources, so a re-run of
    // `ct export tf` (a `make export`, a CI regen, exporting a second env) selects every type,
    // finds nothing, and would write `entries: 0` over the map that is the only thing still
    // resolving every leftover `campus:`/`personStatus:` reference. An export that exports nothing
    // has learned nothing, and must therefore forget nothing.
    if (existing && existing.entries.length > 0) {
      idMapPath = existing.path;
      idMapKept = true;
    } else {
      idMapPath = await writeIdMap(project.host, entries, catalogDir);
    }
  }

  const warnings: CtWarning[] = skipped.map(({ type, count }) => ({
    code: "EXPORT_TYPE_UNSUPPORTED",
    message:
      `${count} ${type} resource(s) were NOT exported: terraform-provider-churchtools has no ` +
      `${type} resource yet. \`tofu plan\` will propose creating them — keep managing them with ct until then.`,
    details: { type, count },
  }));

  if (campusUnknown.length > 0) {
    warnings.push({
      code: "EXPORT_CAMPUS_UNKNOWN",
      message:
        `${campusUnknown.length} group(s) have no campusId in ct's state and were exported without a ` +
        `campus: ${campusUnknown.join(", ")}. If one has a campus in ChurchTools, \`tofu plan\` will ` +
        `propose clearing it — check those groups in the plan before applying.`,
      details: { keys: campusUnknown },
    });
  }

  if (idMapKept) {
    warnings.push({
      code: "IDS_KEPT",
      message:
        `This export holds no resources ct can map, so ${idMapPath} was left as it is rather than ` +
        `emptied. That is expected once these resources belong to OpenTofu — refresh the map from ` +
        `tofu instead (\`tofu state pull | ct ids sync --tofu-state -\`).`,
      details: { path: idMapPath },
    });
  }

  return {
    operation: "export-tf",
    project,
    value: { files: written, imported: imports.length, relabelled, skipped, idMapPath },
    warnings,
  };
}
