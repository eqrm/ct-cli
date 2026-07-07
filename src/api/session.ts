/**
 * Helper: build an authenticated {@link CtClient} from the stored token.
 * Centralised so every command fails the same friendly way when logged out.
 */
import { CtClient, type WhoAmI } from "./ctClient.js";
import { readToken } from "../auth/tokenStore.js";
import { resolveConfig } from "../config.js";

export interface AuthedSession {
  client: CtClient;
  me: WhoAmI;
}

export async function authedSession(): Promise<AuthedSession> {
  const config = resolveConfig();
  const token = await readToken(config.host);
  if (!token) {
    throw new Error("Not logged in. Run `ct auth login --token <token>` first.");
  }
  const client = new CtClient(config);
  const me = await client.authenticate(token);
  return { client, me };
}
