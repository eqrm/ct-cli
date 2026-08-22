import { Command } from "commander";
import { readToken, clearCredentials, supportsCredentialStorage } from "../auth/tokenStore.js";
import { loginWithToken, type LoginResult } from "../auth/login.js";
import { authedSession } from "../api/session.js";
import { meetsMinVersion, MIN_CT_VERSION } from "../api/version.js";
import { askSecret } from "../ui/prompt.js";
import { success, error, info, warn, out } from "../ui.js";

export function reportLogin(result: LoginResult): void {
  const { host, me, location } = result;
  success(`Logged in to ${host} as ${me.firstName ?? ""} ${me.lastName ?? ""} (#${me.id})`.trim());
  info(`Host + token stored in ${location}.`);

  if (result.info.version) {
    if (meetsMinVersion(result.info.version)) {
      info(`ChurchTools ${result.info.version} (≥ ${MIN_CT_VERSION} required).`);
    } else {
      warn(
        `ChurchTools ${result.info.version} is below the required ${MIN_CT_VERSION} — plan/apply will refuse.`,
      );
    }
  }
}

export function authCommand(): Command {
  const cmd = new Command("auth").description("Authenticate against ChurchTools");

  cmd
    .command("login")
    .description("Store and verify a ChurchTools host + personal login token")
    .option("-H, --host <url>", "ChurchTools host, e.g. https://mychurch.church.tools (or set CT_HOST)")
    .option("-t, --token <token>", "personal login token (or set CT_LOGINTOKEN)")
    .action(async (opts: { host?: string; token?: string }) => {
      if (!supportsCredentialStorage()) {
        error(
          "Secure credential storage is currently available only through the macOS Keychain. " +
            "On this platform, set CT_HOST and CT_LOGINTOKEN in your environment instead.",
        );
        process.exitCode = 1;
        return;
      }
      const rawHost = opts.host?.trim() || process.env.CT_HOST?.trim();
      if (!rawHost) {
        error("No host provided. Pass --host <url> or set CT_HOST.");
        process.exitCode = 1;
        return;
      }
      let token = opts.token?.trim() || process.env.CT_LOGINTOKEN?.trim();
      if (!token && process.stdin.isTTY) {
        token = (await askSecret("Personal login token (input hidden): ")).trim();
      }
      if (!token) {
        error("No token provided. Enter it interactively, pass --token <token>, or set CT_LOGINTOKEN.");
        process.exitCode = 1;
        return;
      }
      reportLogin(await loginWithToken(rawHost, token));
    });

  cmd
    .command("status")
    .description("Show the currently authenticated user")
    .action(async () => {
      if (!(await readToken())) {
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
