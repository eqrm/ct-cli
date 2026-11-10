import { Command } from "commander";
import { resolve } from "node:path";
import { gatewayPort, loadEnvProfile, resolveEnvsPath } from "../env/envs.js";
import { cachingCredentials, createProxyServer, listenLoopback } from "../gateway/proxy.js";
import { profileCredentials } from "../gateway/credentials.js";
import { error, formatError, info } from "../ui.js";

export function gatewayCommand(): Command {
  const cmd = new Command("gateway").description(
    "Read-only ChurchTools access through the AWS gateway (#228)",
  );

  cmd
    .command("proxy")
    .description(
      "Run a local SigV4-signing proxy (127.0.0.1) for a gateway env (asks for an MFA code only with --simulate, or if the AWS profile has mfa_serial)",
    )
    .requiredOption("-e, --env <name>", "environment with a `gateway` block in ct.envs.json")
    .option(
      "--simulate",
      "also forward GET /simulate/<personId>/api/... (read as another person); asks for an MFA code at start",
    )
    .option(
      "--simulate-profile <name>",
      "AWS profile for the simulate role (needs mfa_serial); only with --simulate",
      "eqrm-ct-simulate",
    )
    .action(async (opts: { env: string; simulate?: boolean; simulateProfile: string }) => {
      try {
        const profile = await loadEnvProfile(opts.env, resolve(resolveEnvsPath()));
        if (!profile.gateway) {
          throw new Error(`Environment "${opts.env}" has no "gateway" block in ct.envs.json.`);
        }
        const { gateway } = profile;
        const port = gatewayPort(profile);
        const credentials = cachingCredentials(profileCredentials(gateway.profile));
        // Own cache, own MFA prompt: the simulate role is separate from the reader role by design.
        const simulateCredentials = opts.simulate
          ? cachingCredentials(profileCredentials(opts.simulateProfile))
          : undefined;
        const server = createProxyServer({
          gatewayUrl: gateway.url,
          region: gateway.region,
          credentials,
          simulateCredentials,
          log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
        });
        // Fail fast on bad AWS config/MFA instead of at the first request.
        await credentials();
        if (simulateCredentials) await simulateCredentials();
        await listenLoopback(server, port);
        info(
          `Proxy for ${opts.env} listening on http://127.0.0.1:${port} -> ${gateway.url} (Ctrl-C to stop).`,
        );
        if (simulateCredentials) {
          info(
            `Reading as another person is on: /simulate/<personId>/api/... (profile ${opts.simulateProfile}).`,
          );
        }
        await new Promise<void>((done) => {
          const stop = (): void => {
            server.close(() => done());
            server.closeAllConnections();
          };
          process.once("SIGINT", () => stop());
          process.once("SIGTERM", () => stop());
        });
      } catch (caught) {
        error(formatError(caught));
        process.exitCode = 1;
      }
    });

  return cmd;
}
