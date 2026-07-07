import { Command } from "commander";
import { CtClient } from "../api/ctClient.js";
import { resolveConfig } from "../config.js";
import { storeToken, readToken, clearToken } from "../auth/tokenStore.js";
import { authedSession } from "../api/session.js";
import { meetsMinVersion, MIN_CT_VERSION, type CtInfo } from "../api/version.js";
import { success, error, info, warn, out } from "../ui.js";

export function authCommand(): Command {
  const cmd = new Command("auth").description("Authenticate against ChurchTools");

  cmd
    .command("login")
    .description("Store and verify a personal ChurchTools login token")
    .option("-t, --token <token>", "personal login token (or set CT_LOGINTOKEN)")
    .action(async (opts: { token?: string }) => {
      const config = resolveConfig();
      const token = opts.token?.trim() || process.env.CT_LOGINTOKEN?.trim();
      if (!token) {
        error("No token provided. Pass --token <token> or set CT_LOGINTOKEN.");
        process.exitCode = 1;
        return;
      }
      const client = new CtClient(config);
      const me = await client.authenticate(token);
      const location = await storeToken(token);
      success(`Logged in to ${config.host} as ${me.firstName ?? ""} ${me.lastName ?? ""} (#${me.id})`.trim());
      info(`Token stored in ${location}.`);

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
      if (!(await readToken())) {
        error("Not logged in. Run `ct auth login --token <token>`.");
        process.exitCode = 1;
        return;
      }
      const { me } = await authedSession();
      out(me);
    });

  cmd
    .command("logout")
    .description("Remove the stored login token")
    .action(async () => {
      await clearToken();
      success("Logged out — stored token removed.");
    });

  return cmd;
}
