/**
 * `ct ids` — maintaining the committed OpenTofu id map (#181).
 *
 * `ct export tf` writes the map from the state it exports, which covers the cutover itself. What it
 * cannot cover is everything after: once tier-0 belongs to tofu, a resource `tofu apply` creates
 * exists in no ct state file, so no export will ever mention it. `ct ids sync` closes that loop by
 * reading tofu's own state — from a file or from stdin, so `tofu state pull | ct ids sync -e prod
 * --tofu-state -` works against any backend without ct learning to speak S3.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_DIR } from "../../permissions/catalog-store.js";
import { loadIdMap, writeIdMap, type IdMapEntry } from "../../resolve/idMap.js";
import { readTfState } from "../../resolve/tfstate.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

export interface IdsSyncRequest extends ProjectRequest {
  /** Path to a `terraform.tfstate`, or `-` to read it from stdin. */
  tofuState: string;
  dryRun?: boolean;
}

export interface IdsSyncValue {
  path: string;
  entries: IdMapEntry[];
  /** Entries this sync added, changed or dropped, for a report that says what actually moved. */
  added: IdMapEntry[];
  changed: { entry: IdMapEntry; previousId: number }[];
  removed: IdMapEntry[];
  serial: number | null;
  written: boolean;
}

export type IdsSyncResult = OperationResult<IdsSyncValue>;

export interface IdsListValue {
  path: string | null;
  entries: IdMapEntry[];
}

export type IdsListResult = OperationResult<IdsListValue>;

export interface IdsOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadIdMap?: typeof loadIdMap;
  writeIdMap?: typeof writeIdMap;
  readStdin?: () => Promise<string>;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function entryId(entry: { type: string; key: string }): string {
  return `${entry.type}\u0000${entry.key}`;
}

export async function runIdsSync(
  request: IdsSyncRequest,
  dependencies: IdsOperationDependencies = {},
): Promise<IdsSyncResult> {
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const dir = join(project.cwd, CATALOG_DIR);
  const raw =
    request.tofuState === "-"
      ? await (dependencies.readStdin ?? readAllStdin)()
      : await readFile(request.tofuState, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Could not read the tofu state from ${request.tofuState === "-" ? "stdin" : request.tofuState}: ` +
        `not valid JSON (${(err as Error).message}).`,
    );
  }
  // The EXISTING map is the source of the label→key mapping: the exporter relabels keys that are not
  // valid HCL identifiers, many-to-one, so a tofu address can only be mapped back to its ct key with
  // the map that recorded the relabelling. Without one, a label is taken as the key — correct for
  // every key that needed no relabelling, which is all of them on a normal instance.
  const previous = await (dependencies.loadIdMap ?? loadIdMap)(project.host, dir);
  const { entries, unmapped, serial } = readTfState(parsed, previous?.keysByLabel ?? new Map());

  const previousById = new Map((previous?.entries ?? []).map((e) => [entryId(e), e]));
  const nextById = new Map(entries.map((e) => [entryId(e), e]));
  const added = entries.filter((e) => !previousById.has(entryId(e)));
  const changed = entries
    .map((entry) => ({ entry, previousId: previousById.get(entryId(entry))?.id }))
    .filter((row): row is { entry: IdMapEntry; previousId: number } => {
      return row.previousId !== undefined && row.previousId !== row.entry.id;
    });
  // Dropped from tofu's state, so ct must stop claiming to resolve them — keeping a stale id would
  // silently point every reference at whatever now holds that number.
  const removed = (previous?.entries ?? []).filter((e) => !nextById.has(entryId(e)));

  const warnings: CtWarning[] = [];
  if (unmapped.length > 0) {
    warnings.push({
      code: "IDS_TYPE_UNSUPPORTED",
      message:
        `Ignored ${unmapped.length} provider resource type(s) ct has no mapping for: ${unmapped.join(", ")}. ` +
        `References to those cannot resolve through the id map — keep them managed by ct, or use a numeric id.`,
      details: { types: unmapped },
    });
  }
  if (entries.length === 0) {
    warnings.push({
      code: "IDS_EMPTY",
      message:
        `The tofu state holds no churchtools resources ct can map, so the id map would be empty. ` +
        `Check you pulled the state for ${project.host} (\`tofu state pull\` in the right workspace).`,
    });
  }

  const written = !request.dryRun && entries.length > 0;
  const path = written
    ? await (dependencies.writeIdMap ?? writeIdMap)(project.host, entries, dir, "ct ids sync")
    : (previous?.path ?? join(dir, `ids.${project.host}.json`));

  return {
    operation: "ids",
    project,
    warnings,
    value: { path, entries, added, changed, removed, serial, written },
  };
}

export async function runIdsList(
  request: ProjectRequest = {},
  dependencies: IdsOperationDependencies = {},
): Promise<IdsListResult> {
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const map = await (dependencies.loadIdMap ?? loadIdMap)(project.host, join(project.cwd, CATALOG_DIR));
  return {
    operation: "ids",
    project,
    warnings: [],
    value: { path: map?.path ?? null, entries: map?.entries ?? [] },
  };
}
