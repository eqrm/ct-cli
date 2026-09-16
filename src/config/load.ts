/**
 * Load a desired-state config file (`.ts`, `.mjs`, or `.js`) at runtime.
 *
 * `jiti` transpiles TypeScript on the fly so the compiled CLI can import a
 * user's `.ts` config directly. The config must default-export a
 * {@link ConfigModule}; we run it against a fresh context and return the
 * declared resources.
 */
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";
import { warnConfigDeprecated } from "./deprecation.js";
import { evaluateConfig, type ConfigModule } from "./context.js";
import type { DesiredResource } from "../engine/types.js";
import type { DesiredPermission } from "../permissions/types.js";
import { resolveWithEnv } from "../util/resolve.js";

export const DEFAULT_CONFIG_PATH = "ct.config.ts";

export function resolveConfigPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveWithEnv(explicit, env.CT_CONFIG, DEFAULT_CONFIG_PATH);
}

export async function loadConfig(
  path: string,
): Promise<{ resources: DesiredResource[]; permissions: DesiredPermission[]; configDir: string }> {
  const resolved = resolve(path);
  // Directory of the config file, so relative `{ ref }` ruleset paths resolve against the config
  // (not wherever `ct` happens to be invoked). Threaded through buildPlan → foldSynthetic.
  const configDir = dirname(resolved);
  // Surface a friendly message rather than jiti's raw ERR_MODULE_NOT_FOUND stack.
  try {
    await access(resolved);
  } catch {
    throw new Error(
      `Config file not found: ${path} (default: ${DEFAULT_CONFIG_PATH}). ` +
        `Create it — it must default-export a function (ct) => { ... }.`,
    );
  }
  warnConfigDeprecated();
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const mod = await jiti.import<ConfigModule>(resolved, { default: true });
  if (typeof mod !== "function") {
    throw new Error(`Config ${path} must default-export a function (ct) => { ... }.`);
  }
  return { ...(await evaluateConfig(mod)), configDir };
}
