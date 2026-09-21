import { Command } from "commander";
import { runAuthLogin, runAuthLogout, runAuthStatus, runAuthToken } from "../application/operations/auth.js";
import { normalizeHost } from "../config.js";
import { isSecureStorageAvailable } from "../auth/tokenStore.js";
import { bootstrapLoginToken } from "../auth/login.js";
import { askVisible } from "../ui/prompt.js";
import { renderEnvAuth } from "../auth/status.js";
import { success, error, info, warn, out, formatError } from "../ui.js";

/**
 * The `--all` preflight: one line per environment, resolving each env's host and
 * token exactly as an `--env` command would. Exits non-zero when any environment
 * has no working token, so CI can gate on it.
 */
/** Verify a personal token, cache the resulting session, store it, and report the login. */
export async function verifyAndStoreLoginToken(rawHost: string, rawToken: string): Promise<void> {
  const result = await runAuthLogin({ host: rawHost, token: rawToken });
  const me = result.identity;
  success(`Logged in to ${result.host} as ${me.firstName ?? ""} ${me.lastName ?? ""} (#${me.id})`.trim());
  info(`Host + token stored in ${result.storage}.`);
  if (result.versionCheckError) {
    warn(
      `Could not read the ChurchTools version (${result.versionCheckError}) — the login itself is stored and verified.`,
    );
  } else if (result.churchToolsVersion) {
    if (result.supportedVersion) {
      info(`ChurchTools ${result.churchToolsVersion} (≥ ${result.minimumVersion} required).`);
    } else {
      warn(
        `ChurchTools ${result.churchToolsVersion} is below the required ${result.minimumVersion} — plan/apply will refuse.`,
      );
    }
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

      await verifyAndStoreLoginToken(config.host, token);
    });

  cmd
    .command("status")
    .description("Show who you are — on the default host, on one --env, or on every env (--all)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (targets that host)")
    .option("--all", "report every environment in ct.envs.json (read-only preflight)")
    .action(async (opts: { env?: string; all?: boolean }) => {
      try {
        const result = await runAuthStatus({ environment: opts.env, all: opts.all });
        if (result.scope === "all") {
          if (result.environments.length === 0) {
            error(`No environments defined in ${result.environmentsPath}.`);
            process.exitCode = 1;
            return;
          }
          for (const line of renderEnvAuth(result.environments)) process.stdout.write(`${line}\n`);
          if (!result.authenticated) process.exitCode = 1;
          return;
        }
        info(result.environment ? `${result.host} (env ${result.environment})` : result.host!);
        out(result.identity);
      } catch (caught) {
        error(formatError(caught));
        process.exitCode = 1;
      }
    });

  cmd
    .command("token")
    .description("Print a short-lived ChurchTools session for another tool (credential helper)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (targets that host)")
    .option("--raw", "print only the session cookie, with no JSON envelope")
    .option("--allow-tty", "print the credential even though stdout is a terminal")
    .action(async (opts: { env?: string; raw?: boolean; allowTty?: boolean }) => {
      // A credential is for a pipe, not for scrollback: a terminal keeps it in the buffer, in a
      // `script` capture and in whatever the user pastes next. The whole point of emitting the
      // SESSION rather than the login token is to shorten a leak's life — printing it where it will
      // be kept works against that, so it takes an explicit flag (#179).
      if (process.stdout.isTTY && !opts.allowTty) {
        error(
          "Refusing to print a credential to a terminal. Pipe it (e.g. `ct auth token --env dev | jq`), " +
            "or pass --allow-tty if you really want it on screen.",
        );
        process.exitCode = 1;
        return;
      }
      try {
        const result = await runAuthToken({ environment: opts.env });
        // stdout carries the credential and NOTHING else, so `$(ct auth token --raw)` is safe. Every
        // line below — and every warning, prompt and progress message anywhere in ct — is on stderr.
        process.stdout.write(opts.raw ? `${result.cookie}\n` : `${JSON.stringify(result)}\n`);
        info(
          `${result.host}${result.environment ? ` (env ${result.environment})` : ""} — session from ` +
            `${result.source === "cache" ? "the keychain cache" : "a fresh login handshake"}, ` +
            `reusable until ${result.expiresAt}.`,
        );
      } catch (caught) {
        // Nothing is written to stdout on failure: a consumer that reads stdout for a credential
        // must get an empty stream, never a diagnostic it might mistake for one.
        error(formatError(caught));
        process.exitCode = 1;
      }
    });

  cmd
    .command("logout")
    .description("Remove the stored host + login token")
    .option("-e, --env <name>", "environment profile from ct.envs.json (log out of that host only)")
    .action(async (opts: { env?: string }) => {
      const result = await runAuthLogout({ environment: opts.env });
      if (!result.environment) {
        success("Logged out — stored credentials removed.");
        return;
      }
      success(`Logged out of ${result.host} (env ${result.environment}) — other hosts stay logged in.`);
      if (result.clearedDefault) {
        // The default blob held a copy of the very token just removed, so it went
        // with it — and with it the host that commands without --env fall back to.
        warn(
          `${result.host} was also the default login, so commands without --env now have no host. ` +
            `Run \`ct auth login --host <url> --token <token>\` (or pass --env) to set one again.`,
        );
      }
    });

  return cmd;
}
