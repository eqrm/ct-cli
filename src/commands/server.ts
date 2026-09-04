import { Command, Option } from "commander";
import { createCtApiServer } from "../server/app.js";
import { info, success } from "../ui.js";

interface ServerOptions {
  host: string;
  port: string;
  workspace: string[];
  allowOrigin: string[];
  publicUrl?: string;
  trustedProxy?: boolean;
  generator?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function loopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function port(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port "${value}".`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < 0 || parsed > 65_535) throw new Error(`Invalid port "${value}".`);
  return parsed;
}

export function isExactAllowedOrigin(value: string): boolean {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return false;
  if (["chrome-extension:", "moz-extension:"].includes(parsed.protocol)) return parsed.host !== "";
  return parsed.origin === value || `${parsed.origin}/` === value;
}

export function serverCommand(): Command {
  return new Command("server")
    .description("Run the versioned REST API for paired ChurchTools Extension clients")
    .addOption(new Option("--host <address>", "listen address").default("127.0.0.1"))
    .addOption(new Option("--port <number>", "listen port; 0 chooses a free port").default("8765"))
    .option("--workspace <path>", "configured workspace root; repeatable", collect, [])
    .option("--allow-origin <origin>", "exact allowed Extension origin; repeatable", collect, [])
    .option("--public-url <https-url>", "advertised HTTPS URL when a trusted reverse proxy terminates TLS")
    .option("--trusted-proxy", "declare that --public-url is terminated by a trusted reverse proxy")
    .option("--generator <path>", "trusted local process-input generator module")
    .action(async (opts: ServerOptions) => {
      const isLocal = loopback(opts.host);
      if (!isLocal) {
        if (!opts.trustedProxy || !opts.publicUrl) {
          throw new Error(
            "Non-loopback listening requires --trusted-proxy and an HTTPS --public-url. " +
              "Binding to 0.0.0.0 alone is intentionally refused.",
          );
        }
        const advertised = new URL(opts.publicUrl);
        if (advertised.protocol !== "https:") throw new Error("--public-url must use HTTPS.");
        if (opts.allowOrigin.length === 0) {
          throw new Error("Non-loopback mode requires at least one exact --allow-origin.");
        }
      }
      for (const origin of opts.allowOrigin) {
        const parsed = new URL(origin);
        if (
          !isExactAllowedOrigin(origin) ||
          (!isLocal && !["https:", "chrome-extension:", "moz-extension:"].includes(parsed.protocol))
        ) {
          throw new Error(`--allow-origin must be an exact origin: ${origin}`);
        }
      }

      const generator = opts.generator
        ? await (await import("../server/generator.js")).loadTrustedProcessGenerator(opts.generator)
        : undefined;
      const api = await createCtApiServer({
        workspaceRoots: opts.workspace.length > 0 ? opts.workspace : [process.cwd()],
        allowedOrigins: opts.allowOrigin,
        // Loopback HTTP is acceptable for local credential submission, but its cookie must not be
        // marked Secure. Remote mode is safe only through the declared HTTPS reverse proxy.
        secureTransport: !isLocal && opts.trustedProxy === true,
        generator,
        audit: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
      });
      await new Promise<void>((resolve, reject) => {
        api.server.once("error", reject);
        api.server.listen(port(opts.port), opts.host, () => resolve());
      });
      const address = api.server.address();
      const actualPort = typeof address === "object" && address ? address.port : port(opts.port);
      const localUrl = `http://${opts.host.includes(":") ? `[${opts.host}]` : opts.host}:${actualPort}`;
      success(`ct REST API listening at ${opts.publicUrl ?? localUrl}/api/v1`);
      info(`Pairing code: ${api.pairingCode} (expires ${api.pairingExpiresAt})`);
      info(`API docs: ${opts.publicUrl ?? localUrl}/api/docs`);
      info(`OpenAPI: ${opts.publicUrl ?? localUrl}/api/v1/openapi.json`);
      info(
        `Configured workspaces: ${api.workspaces.map((workspace) => `${workspace.name} (${workspace.id})`).join(", ")}`,
      );

      const close = (): void => {
        api.server.close(() => {
          process.exitCode = 0;
        });
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
}
