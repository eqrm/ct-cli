import { Command } from "commander";
import { CtClient } from "../api/ctClient.js";
import { normalizeHost, resolveConfig } from "../config.js";
import {
  storeCredentials,
  readToken,
  clearCredentials,
  isSecureStorageAvailable,
} from "../auth/tokenStore.js";
import { keychainSessionCache } from "../auth/sessionStore.js";
import { bootstrapLoginToken } from "../auth/login.js";
import { askVisible } from "../ui/prompt.js";
import { checkAllEnvAuth, renderEnvAuth, allEnvsAuthenticated } from "../auth/status.js";
import { authedSession } from "../api/session.js";
import { prepareEnvHost } from "../env/context.js";
import { loadEnvProfile, loadEnvProfiles, resolveEnvsPath } from "../env/envs.js";
import { meetsMinVersion, MIN_CT_VERSION, type CtInfo } from "../api/version.js";
import { success, error, info, warn, out, formatError } from "../ui.js";

/**
 * The `--all` preflight: one line per environment, resolving each env's host and
 * token exactly as an `--env` command would. Exits non-zero when any environment
 * has no working token, so CI can gate on it.
 */
async function reportAllEnvs(): Promise<void> {
  const envsPath = resolveEnvsPath();
  const profiles = await loadEnvProfiles(envsPath);
  if (profiles.length === 0) {
    error(`No environments defined in ${envsPath}.`);
    process.exitCode = 1;
    return;
  }
  const statuses = await checkAllEnvAuth(profiles);
  for (const line of renderEnvAuth(statuses)) {
    process.stdout.write(`${line}\n`);
  }
  if (!allEnvsAuthenticated(statuses)) {
    process.exitCode = 1;
  }
}

export function authCommand(): Command {
  const cmd = new Command("auth").description("Authenticate against ChurchTools");

  cmd
    .command("login")
    .description(
      "Store and verify a ChurchTools host + personal login token (prompts when --token is omitted)",
    )
    .option("-H, --host <url>", "ChurchTools host, e.g. https://mychurch.church.tools (or set CT_HOST)")
    .option("-t, --token <token>", "personal login token (or set CT_LOGINTOKEN)")
    .action(async (opts: { host?: string; token?: string }) => {
      const interactive = Boolean(process.stdin.isTTY);
      let rawHost = opts.host?.trim() || process.env.CT_HOST?.trim();
      if (!rawHost && interactive && isSecureStorageAvailable()) {
        rawHost = (await askVisible("ChurchTools host (e.g. https://mychurch.church.tools): ")).trim();
      }
      if (!rawHost) {
        error("No host provided. Pass --host <url> or set CT_HOST.");
        process.exitCode = 1;
        return;
      }
      const config = { host: normalizeHost(rawHost) };

      // The non-interactive contract is unchanged: a token from --token or
      // CT_LOGINTOKEN is verified and stored exactly as before, and nothing
      // prompts. Only the absence of one opens the guided flow (#138).
      let token = opts.token?.trim() || process.env.CT_LOGINTOKEN?.trim();
      if (!token && !interactive) {
        error("No token provided. Pass --token <token> or set CT_LOGINTOKEN.");
        process.exitCode = 1;
        return;
      }
      if (!token) {
        let outcome;
        try {
          outcome = await bootstrapLoginToken(config.host);
        } catch (err) {
          // formatError never sees a secret: LoginError carries a status and a
          // redacted message, never the request body that was sent.
          error(formatError(err));
          process.exitCode = 1;
          return;
        }
        if (outcome.kind === "unsupported") {
          error(
            "Credential storage requires the macOS Keychain. " + `On this platform, ${outcome.hint} instead.`,
          );
          process.exitCode = 1;
          return;
        }
        if (outcome.kind === "skipped") {
          info(`Skipped — no credentials stored. To log in later: ${outcome.hint}`);
          return;
        }
        token = outcome.token;
      }

      const client = new CtClient(config, { sessionCache: keychainSessionCache() });
      // `fresh`: a login must actually prove the token, never be answered from a
      // cached session — but the session it buys is cached for the next command.
      const me = await client.authenticate(token, { fresh: true });
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
    .description("Show who you are — on the default host, on one --env, or on every env (--all)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (targets that host)")
    .option("--all", "report every environment in ct.envs.json (read-only preflight)")
    .action(async (opts: { env?: string; all?: boolean }) => {
      if (opts.all) {
        if (opts.env) {
          error("--all reports every environment; drop --env (or drop --all to check just one).");
          process.exitCode = 1;
          return;
        }
        await reportAllEnvs();
        return;
      }

      // #22 wiring: point the unchanged host/token resolution at the env's instance.
      await prepareEnvHost(opts);
      let host: string;
      try {
        host = (await resolveConfig()).host;
      } catch {
        error("Not logged in. Run `ct auth login --host <url> --token <token>`.");
        process.exitCode = 1;
        return;
      }
      if (!(await readToken(host))) {
        error(`No token for ${host}. Run \`ct auth login --host ${host} --token <token>\`.`);
        process.exitCode = 1;
        return;
      }
      const { me } = await authedSession();
      // The host goes to stderr so `ct auth status | jq` keeps seeing only the identity.
      info(opts.env ? `${host} (env ${opts.env})` : host);
      out(me);
    });

  cmd
    .command("logout")
    .description("Remove the stored host + login token")
    .option("-e, --env <name>", "environment profile from ct.envs.json (log out of that host only)")
    .action(async (opts: { env?: string }) => {
      if (!opts.env) {
        await clearCredentials();
        success("Logged out — stored credentials removed.");
        return;
      }
      const profile = await loadEnvProfile(opts.env, resolveEnvsPath());
      const { clearedDefault } = await clearCredentials(profile.host);
      success(`Logged out of ${profile.host} (env ${profile.name}) — other hosts stay logged in.`);
      if (clearedDefault) {
        // The default blob held a copy of the very token just removed, so it went
        // with it — and with it the host that commands without --env fall back to.
        warn(
          `${profile.host} was also the default login, so commands without --env now have no host. ` +
            `Run \`ct auth login --host <url> --token <token>\` (or pass --env) to set one again.`,
        );
      }
    });

  return cmd;
}
