import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonValue } from "../contracts.js";
import type { DesiredResource } from "../../engine/types.js";
import type { DesiredPermission } from "../../permissions/types.js";

export interface ProcessInputDocument {
  schemaVersion: string;
  clientRevision: string;
  payload: JsonValue;
}

export interface ProcessInputSnapshot extends ProcessInputDocument {
  digest: string;
  createdAt: string;
}

export interface CreateInputSnapshotRequest extends ProcessInputDocument {
  cwd?: string;
  persist?: boolean;
}

export interface InputSnapshotResult {
  operation: "input";
  value: ProcessInputSnapshot;
  persisted: boolean;
}

export interface ListInputSnapshotsResult {
  operation: "input";
  snapshots: ProcessInputSnapshot[];
}

export interface ValidateInputResult {
  operation: "input";
  valid: boolean;
  errors: { path: string; message: string }[];
  digest: string | null;
}

export interface InputOperationDependencies {
  now?: () => Date;
}

export interface ProcessInputValidation {
  valid: boolean;
  errors: { path: string; message: string }[];
}

export interface GeneratedProcessConfig {
  resources: DesiredResource[];
  permissions: DesiredPermission[];
}

/** Installed by the operator; process input can select data, never executable code. */
export interface ProcessInputGenerator {
  id: string;
  supportedSchemaVersions: readonly string[];
  validate(document: ProcessInputDocument): ProcessInputValidation | Promise<ProcessInputValidation>;
  generate(document: ProcessInputDocument): GeneratedProcessConfig | Promise<GeneratedProcessConfig>;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(",")}}`;
}

function documentDigest(document: ProcessInputDocument): string {
  return createHash("sha256")
    .update(canonical(document as unknown as JsonValue))
    .digest("hex");
}

function snapshotDirectory(cwd: string): string {
  return join(resolve(cwd), ".ct", "process-input", "snapshots");
}

export function validateProcessInput(document: unknown): ValidateInputResult {
  const errors: { path: string; message: string }[] = [];
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return {
      operation: "input",
      valid: false,
      errors: [{ path: "", message: "expected an object" }],
      digest: null,
    };
  }
  const candidate = document as Record<string, unknown>;
  if (typeof candidate.schemaVersion !== "string" || candidate.schemaVersion.trim() === "") {
    errors.push({ path: "/schemaVersion", message: "must be a non-empty string" });
  }
  if (typeof candidate.clientRevision !== "string" || candidate.clientRevision.trim() === "") {
    errors.push({ path: "/clientRevision", message: "must be a non-empty string" });
  }
  if (!("payload" in candidate)) errors.push({ path: "/payload", message: "is required" });
  if (errors.length > 0) return { operation: "input", valid: false, errors, digest: null };
  const normalized: ProcessInputDocument = {
    schemaVersion: candidate.schemaVersion as string,
    clientRevision: candidate.clientRevision as string,
    payload: candidate.payload as JsonValue,
  };
  return { operation: "input", valid: true, errors: [], digest: documentDigest(normalized) };
}

export async function createInputSnapshot(
  request: CreateInputSnapshotRequest,
  dependencies: InputOperationDependencies = {},
): Promise<InputSnapshotResult> {
  const validation = validateProcessInput(request);
  if (!validation.valid || !validation.digest) {
    throw new Error(
      `Invalid process input: ${validation.errors.map((item) => `${item.path} ${item.message}`).join(", ")}`,
    );
  }
  let value: ProcessInputSnapshot = {
    schemaVersion: request.schemaVersion,
    clientRevision: request.clientRevision,
    payload: request.payload,
    digest: validation.digest,
    createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
  };
  const persisted = request.persist !== false;
  if (persisted) {
    const directory = snapshotDirectory(request.cwd ?? process.cwd());
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${value.digest}.json`);
    try {
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (caught) {
      if (!(
        typeof caught === "object" &&
        caught !== null &&
        (caught as NodeJS.ErrnoException).code === "EEXIST"
      )) {
        throw caught;
      }
      value = JSON.parse(await readFile(path, "utf8")) as ProcessInputSnapshot;
    }
  }
  return { operation: "input", value, persisted };
}

export async function getInputSnapshot(cwd: string, digest: string): Promise<InputSnapshotResult> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid snapshot digest.");
  const path = join(snapshotDirectory(cwd), `${digest}.json`);
  const value = JSON.parse(await readFile(path, "utf8")) as ProcessInputSnapshot;
  return { operation: "input", value, persisted: true };
}

export async function listInputSnapshots(cwd: string): Promise<ListInputSnapshotsResult> {
  const directory = snapshotDirectory(cwd);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (caught) {
    if (
      typeof caught === "object" &&
      caught !== null &&
      (caught as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { operation: "input", snapshots: [] };
    }
    throw caught;
  }
  const snapshots = await Promise.all(
    names
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as ProcessInputSnapshot),
  );
  snapshots.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { operation: "input", snapshots };
}
