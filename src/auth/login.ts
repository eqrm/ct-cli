import { CtClient, type WhoAmI } from "../api/ctClient.js";
import { type CtInfo } from "../api/version.js";
import { normalizeHost } from "../config.js";
import { storeCredentials } from "./tokenStore.js";

export interface LoginResult {
  host: string;
  me: WhoAmI;
  location: string;
  info: CtInfo;
}

/** Verify a personal login token and persist it using the platform credential store. */
export async function loginWithToken(rawHost: string, rawToken: string): Promise<LoginResult> {
  const host = normalizeHost(rawHost.trim());
  const token = rawToken.trim();
  if (!host) throw new Error("No host provided.");
  if (!token) throw new Error("No token provided.");

  const client = new CtClient({ host });
  const me = await client.authenticate(token);
  const location = await storeCredentials({ host, token });
  const info = await client.get<CtInfo>("/info");
  return { host, me, location, info };
}
