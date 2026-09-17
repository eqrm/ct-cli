/** Orchestration for `ct export tf`: state in, .tf files out. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertLabelsUnique, hclLabel, hclType, renderResource } from "../../export/hcl.js";
import { renderImports, type ImportTarget } from "../../export/imports.js";
import { EXPORTABLE_TYPES, fileForType, OWNED_FILES } from "../../export/layout.js";
import { renderVersions } from "../../export/provider.js";
import { loadState } from "../../state/state.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { resolveProject } from "../project.js";

export interface ExportTfRequest extends ProjectRequest {
  only?: string[];
  outDir: string;
}

export interface ExportTfValue {
  files: string[];
  imported: number;
  /** Keys that could not be used verbatim as an HCL identifier. */
  relabelled: { key: string; label: string }[];
  /** Managed types the provider has no mapping for yet, with how many were skipped. */
  skipped: { type: string; count: number }[];
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

  const byFile = new Map<string, string[]>();
  const imports: ImportTarget[] = [];
  const relabelled: { key: string; label: string }[] = [];

  for (const resource of [...selected].sort((a, b) => {
    const left = address(a.type, a.key);
    const right = address(b.type, b.key);
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    const block = renderResource(resource.type, resource.key, resource.fields, {
      preventDestroy: resource.preventDestroy,
    });
    const file = fileForType(resource.type);
    byFile.set(file, [...(byFile.get(file) ?? []), block]);
    imports.push({ type: resource.type, key: resource.key, id: resource.id });

    // The label the renderer actually produced, read back out of the block so
    // the report cannot drift from what was written.
    const label = block.split('"')[3];
    if (label !== undefined && label !== resource.key) relabelled.push({ key: resource.key, label });
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
  await writeFile(join(outDir, "versions.tf"), renderVersions(), "utf8");
  written.push("versions.tf");

  // Prune only what this command owns, and only what it did not just write.
  for (const file of OWNED_FILES) {
    if (written.includes(file)) continue;
    await rm(join(outDir, file), { force: true });
  }

  const warnings: CtWarning[] = skipped.map(({ type, count }) => ({
    code: "EXPORT_TYPE_UNSUPPORTED",
    message:
      `${count} ${type} resource(s) were NOT exported: terraform-provider-churchtools has no ` +
      `${type} resource yet. \`tofu plan\` will propose creating them — keep managing them with ct until then.`,
    details: { type, count },
  }));

  return {
    operation: "export-tf",
    project,
    value: { files: written, imported: imports.length, relabelled, skipped },
    warnings,
  };
}
