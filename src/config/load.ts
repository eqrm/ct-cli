/**
 * Load a desired-state config file (`.ts`, `.mjs`, or `.js`) at runtime.
 *
 * `jiti` transpiles TypeScript on the fly so the compiled CLI can import a
 * user's `.ts` config directly. The config must default-export a
 * {@link ConfigModule}; we run it against a fresh context and return the
 * declared resources.
 */
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import { evaluateConfig, type ConfigModule } from "./context.js";
import type { DesiredResource } from "../engine/types.js";

export const DEFAULT_CONFIG_PATH = "ct.config.ts";

export function resolveConfigPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit?.trim() || env.CT_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
}

export async function loadConfig(path: string): Promise<DesiredResource[]> {
  const resolved = resolve(path);
  // Surface a friendly message rather than jiti's raw ERR_MODULE_NOT_FOUND stack.
  try {
    await access(resolved);
  } catch {
    throw new Error(
      `Config file not found: ${path} (default: ${DEFAULT_CONFIG_PATH}). ` +
        `Create it — it must default-export a function (ct) => { ... }.`,
    );
  }
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const mod = await jiti.import<ConfigModule>(resolved, { default: true });
  if (typeof mod !== "function") {
    throw new Error(`Config ${path} must default-export a function (ct) => { ... }.`);
  }
  return evaluateConfig(mod);
}
