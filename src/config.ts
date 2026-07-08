/**
 * Runtime configuration for the CLI.
 *
 * The ChurchTools host is bound to the login: it is captured at `ct auth login`
 * (stored in the Keychain with the token) and resolved from there, so the same
 * binary can target prod, a test instance, or any instance without a hardcoded
 * default. `CT_HOST` overrides the stored value for CI / one-off use. The host
 * never carries a trailing slash and never includes the `/api` suffix — callers
 * add path segments themselves.
 */
import { readStoredHost } from "./auth/tokenStore.js";

export interface CtConfig {
  /** Base host, e.g. `https://eqrm.church.tools` (no trailing slash, no `/api`). */
  host: string;
}

/** Strip trailing slashes so `host + "/api" + path` is always well-formed. */
export function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "");
}

/**
 * Resolve the ChurchTools host. Precedence: `CT_HOST` env → stored login host.
 * There is no default: with neither, this throws, directing the user to log in.
 * `readHost` is injectable so the resolution is testable without the Keychain.
 */
export async function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  readHost: () => Promise<string | null> = readStoredHost,
): Promise<CtConfig> {
  const host = env.CT_HOST?.trim() || (await readHost());
  if (!host) {
    throw new Error(
      "No ChurchTools host configured. Run `ct auth login --host <url> --token <token>` (or set CT_HOST).",
    );
  }
  return { host: normalizeHost(host) };
}
