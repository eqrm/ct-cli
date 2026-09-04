import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProcessInputGenerator } from "../application/operations/input.js";

function isGenerator(value: unknown): value is ProcessInputGenerator {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProcessInputGenerator>;
  return (
    typeof candidate.id === "string" &&
    Array.isArray(candidate.supportedSchemaVersions) &&
    typeof candidate.validate === "function" &&
    typeof candidate.generate === "function"
  );
}

/** Load only the module path explicitly configured by the server operator. */
export async function loadTrustedProcessGenerator(path: string): Promise<ProcessInputGenerator> {
  const module = (await import(pathToFileURL(resolve(path)).href)) as {
    default?: unknown;
    generator?: unknown;
  };
  const generator = module.default ?? module.generator;
  if (!isGenerator(generator)) {
    throw new Error(
      `Trusted generator ${path} must export { id, supportedSchemaVersions, validate(), generate() }.`,
    );
  }
  return generator;
}
