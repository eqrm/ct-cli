/** Orchestration for `ct export tf`: state in, .tf files out. */
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { renderResource } from "../../export/hcl.js";
import { renderImports, type ImportTarget } from "../../export/imports.js";
import { EXPORTABLE_TYPES, fileForType } from "../../export/layout.js";
import { loadState } from "../../state/state.js";
import type { OperationResult, ProjectRequest } from "../contracts.js";
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
}

export type ExportTfResult = OperationResult<ExportTfValue>;

export async function runExportTf(request: ExportTfRequest): Promise<ExportTfResult> {
  // resolveProject gives the env profile's state path AND the host the state
  // must belong to; loadState asserts that pairing, so an export can never
  // silently mix instances. No network and no auth: this reads state only.
  const project = await resolveProject(request);
  const state = await loadState(project.statePath, project.host);
  const types = request.only?.length ? request.only : EXPORTABLE_TYPES;

  const byFile = new Map<string, string[]>();
  const imports: ImportTarget[] = [];
  const relabelled: { key: string; label: string }[] = [];

  for (const resource of Object.values(state.resources)) {
    if (!types.includes(resource.type)) continue;
    const block = renderResource(resource.type, resource.key, resource.fields);
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
  for (const [file, blocks] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    await writeFile(join(outDir, file), blocks.sort().join("\n"), "utf8");
    written.push(file);
  }
  await writeFile(join(outDir, "imports.tf"), renderImports(imports), "utf8");
  written.push("imports.tf");

  return {
    operation: "export-tf",
    project,
    value: { files: written, imported: imports.length, relabelled },
    warnings: [],
  };
}
