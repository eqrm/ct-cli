import { Command } from "commander";
import { CtClient } from "../api/ctClient.js";
import { normalizeHost } from "../config.js";
import { storeCredentials, readCredentials, clearCredentials } from "../auth/tokenStore.js";
import { authedSession } from "../api/session.js";
import { meetsMinVersion, MIN_CT_VERSION, type CtInfo } from "../api/version.js";
import { success, error, info, warn, out } from "../ui.js";

export function authCommand(): Command {
  const cmd = new Command("auth").description("Authenticate against ChurchTools");

  cmd
    .command("login")
    .description("Store and verify a ChurchTools host + personal login token")
    .option("-H, --host <url>", "ChurchTools host, e.g. https://mychurch.church.tools (or set CT_HOST)")
    .option("-t, --token <token>", "personal login token (or set CT_LOGINTOKEN)")
    .action(async (opts: { host?: string; token?: string }) => {
      const rawHost = opts.host?.trim() || process.env.CT_HOST?.trim();
      if (!rawHost) {
        error("No host provided. Pass --host <url> or set CT_HOST.");
        process.exitCode = 1;
        return;
      }
      const token = opts.token?.trim() || process.env.CT_LOGINTOKEN?.trim();
      if (!token) {
        error("No token provided. Pass --token <token> or set CT_LOGINTOKEN.");
        process.exitCode = 1;
        return;
      }
      const config = { host: normalizeHost(rawHost) };
      const client = new CtClient(config);
      const me = await client.authenticate(token);
      const location = await storeCredentials({ host: config.host, token });
      success(`Logged in to ${config.host} as ${me.firstName ?? ""} ${me.lastName ?? ""} (#${me.id})`.trim());
      info(`Host + token stored in ${location}.`);

      const ctInfo = await client.get<CtInfo>("/info");
      if (ctInfo.version) {
        if (meetsMinVersion(ctInfo.version)) {
          info(`ChurchTools ${ctInfo.version} (≥ ${MIN_CT_VERSION} required).`);
        } else {
          warn(
            `ChurchTools ${ctInfo.version} is below the required ${MIN_CT_VERSION} — plan/apply will refuse.`,
          );
        }
      }
    });

  cmd
    .command("status")
    .description("Show the currently authenticated user")
    .action(async () => {
      if (!(await readCredentials()) && !process.env.CT_LOGINTOKEN?.trim()) {
        error("Not logged in. Run `ct auth login --host <url> --token <token>`.");
        process.exitCode = 1;
        return;
      }
      const { me } = await authedSession();
      out(me);
    });

  cmd
    .command("logout")
    .description("Remove the stored host + login token")
    .action(async () => {
      await clearCredentials();
      success("Logged out — stored credentials removed.");
    });

  return cmd;
}
