/**
 * Helper: build an authenticated {@link CtClient} from the stored token.
 * Centralised so every command fails the same friendly way when logged out.
 */
import { CtClient, type WhoAmI } from "./ctClient.js";
import { readCredentials } from "../auth/tokenStore.js";
import { keychainSessionCache } from "../auth/sessionStore.js";
import { normalizeHost, resolveConfig } from "../config.js";

export interface AuthedSession {
  client: CtClient;
  me: WhoAmI;
}

/**
 * Build an authenticated {@link CtClient} from the stored credentials.
 *
 * Enforces the host↔token binding BEFORE any network call: the stored token is
 * bound to the host it was captured against (`tokenStore` stores them together).
 * If the resolved host (which gives `CT_HOST` precedence) differs from the host
 * the stored token belongs to, we refuse — otherwise the secret would be sent
 * (as a `login_token` URL query param) to a foreign server and land in its logs,
 * even on a failed login. See issue #30.
 *
 * An explicit `CT_LOGINTOKEN` env token carries no stored-host binding, so the
 * caller owns pairing it with the intended `CT_HOST` — no check applies there.
 */
export async function authedSession(env: NodeJS.ProcessEnv = process.env): Promise<AuthedSession> {
  const config = await resolveConfig(env);
  const envToken = env.CT_LOGINTOKEN?.trim();
  // Resolve the stored token for the host we intend to hit (multi-host, #22): with several logins on
  // one machine, the per-host account is picked by host, keeping the token↔host binding below intact.
  const stored = await readCredentials(config.host);
  const token = envToken || stored?.token;
  if (!token) {
    throw new Error("Not logged in. Run `ct auth login --host <url> --token <token>` first.");
  }

  // Only the *stored* token is host-bound. Refuse to send it to a different host.
  if (!envToken && stored && normalizeHost(stored.host) !== config.host) {
    throw new Error(
      `Refusing to send the stored login token: it belongs to ${normalizeHost(stored.host)}, ` +
        `but the resolved host is ${config.host} (from CT_HOST). ` +
        `Run \`ct auth login --host ${config.host} --token <token>\` for that host, ` +
        `or unset CT_HOST to use ${normalizeHost(stored.host)}.`,
    );
  }

  // The session cache is keyed by the SAME host the binding check above just cleared,
  // so a cached session can only ever be replayed against the instance it came from (#30/#145).
  const client = new CtClient(config, { sessionCache: keychainSessionCache() });
  const me = await client.authenticate(token);
  // Hard-fail below the minimum CT version before any command reads or writes —
  // a stale instance half-applies (tier-0 writes succeed, hierarchy endpoints 404).
  await client.assertMinVersion();
  return { client, me };
}
