/**
 * Local SigV4-signing proxy in front of the read-only ChurchTools gateway (#228).
 *
 * Listens on 127.0.0.1 only. Each request that passes {@link checkRequest} is rebuilt from scratch
 * (method, path, filtered query, body) — incoming headers are NOT copied, so Cookie, Authorization and
 * CSRF headers cannot leak even by accident; only `Accept` and, for the one allowed POST, `Content-Type`
 * are set. The rebuilt request is signed for `execute-api` and sent to the gateway.
 *
 * Logs one line per request (method, path without query, status). Never a body, never a query.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SignatureV4 } from "@smithy/signature-v4";
import { checkRequest } from "./filter.js";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export interface ProxyOptions {
  /** Gateway base URL, e.g. https://abc.execute-api.eu-central-1.amazonaws.com */
  gatewayUrl: string;
  region: string;
  /** Called for every request; implementations cache (see {@link cachingCredentials}). */
  credentials: () => Promise<AwsCredentials>;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

const MAX_BODY = 1024;

/** RFC 3986 encoding, identical to what the signer canonicalizes, so URL and signature agree. */
function encode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return "\u0000too-large";
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Wrap a credential provider so the provider runs only when there is nothing cached or the cached
 * credentials expire within a minute (role sessions last an hour). Without MFA the refresh is silent;
 * with it, concurrent requests share one in-flight refresh, so the terminal is never asked for two
 * codes at once. A failed refresh is not cached: the next request tries again.
 */
export function cachingCredentials(
  provider: () => Promise<AwsCredentials>,
  now: () => number = Date.now,
): () => Promise<AwsCredentials> {
  let cached: AwsCredentials | null = null;
  let inflight: Promise<AwsCredentials> | null = null;
  return async () => {
    if (cached && (!cached.expiration || cached.expiration.getTime() - now() > 60_000)) return cached;
    inflight ??= provider()
      .then((c) => (cached = c))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

function isBlockedBody(payload: Buffer): boolean {
  try {
    const json = JSON.parse(payload.toString("utf8")) as unknown;
    return typeof json === "object" && json !== null && "blocked" in json;
  } catch {
    return false;
  }
}

export function createProxyServer(options: ProxyOptions): Server {
  const log = options.log ?? (() => {});
  const doFetch = options.fetchImpl ?? fetch;
  const gateway = new URL(options.gatewayUrl);
  let signerPromise: Promise<(creds: AwsCredentials) => SignatureV4> | null = null;

  async function signer(): Promise<(creds: AwsCredentials) => SignatureV4> {
    // Lazy: plain `ct` commands never load the AWS packages.
    signerPromise ??= (async () => {
      const [{ SignatureV4 }, { Sha256 }] = await Promise.all([
        import("@smithy/signature-v4"),
        import("@aws-crypto/sha256-js"),
      ]);
      return (credentials: AwsCredentials) =>
        new SignatureV4({ service: "execute-api", region: options.region, credentials, sha256: Sha256 });
    })();
    return signerPromise;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "";
    const rawUrl = req.url ?? "/";
    const logPath = rawUrl.split("?")[0] ?? "/";
    const finish = (status: number, body: unknown, extra = ""): void => {
      log(`${method} ${logPath} ${status}${extra}`);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // DNS rebinding: a web page whose hostname resolves to 127.0.0.1 is "same-origin" with the proxy and
    // could read prod data through it. Only a client that addresses the proxy as loopback gets through.
    const port = req.socket.localPort;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      finish(
        403,
        { blocked: `${method} ${logPath}`, hint: "ct gateway proxy only answers http://127.0.0.1:<port>" },
        " (foreign Host header)",
      );
      return;
    }

    const body = method === "POST" ? await readBody(req) : "";
    const verdict = checkRequest(method, rawUrl, body);
    if (!verdict.ok) {
      finish(
        403,
        { blocked: `${method} ${logPath}`, hint: `ct gateway proxy is read-only: ${verdict.reason}` },
        " (blocked locally)",
      );
      return;
    }

    const qs = verdict.query.map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&");
    const headers: Record<string, string> = { host: gateway.host, accept: "application/json" };
    if (verdict.method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";

    let credentials: AwsCredentials;
    let signed: { headers: Record<string, string> };
    try {
      credentials = await options.credentials();
      const [{ HttpRequest }, makeSigner] = await Promise.all([import("@smithy/protocol-http"), signer()]);
      const query: Record<string, string | string[]> = {};
      for (const [k, v] of verdict.query) {
        const prev = query[k];
        query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
      }
      signed = (await makeSigner(credentials).sign(
        new HttpRequest({
          method: verdict.method,
          protocol: gateway.protocol,
          hostname: gateway.hostname,
          path: verdict.path,
          query,
          headers,
          body: verdict.method === "POST" ? body : undefined,
        }),
      )) as unknown as { headers: Record<string, string> };
    } catch (err) {
      finish(502, { error: `Could not sign the request: ${(err as Error).message}` }, " (signing failed)");
      return;
    }

    const { host: _host, ...sendHeaders } = signed.headers;
    void _host;
    let upstream: Response;
    try {
      upstream = await doFetch(`${gateway.origin}${verdict.path}${qs ? `?${qs}` : ""}`, {
        method: verdict.method,
        headers: sendHeaders,
        body: verdict.method === "POST" ? body : undefined,
        redirect: "manual",
      });
    } catch (err) {
      finish(502, { error: `Gateway unreachable: ${(err as Error).message}` }, " (upstream error)");
      return;
    }
    const payload = Buffer.from(await upstream.arrayBuffer());
    // A 403 with a `blocked` body is the gateway's allowlist deciding, not a credential problem. It goes
    // to the client unchanged; no retry, no other tier.
    const allowlisted = upstream.status === 403 && isBlockedBody(payload);
    log(
      `${method} ${logPath} ${upstream.status}${allowlisted ? ` (not on the gateway allowlist; widening it is a PR in eqrm-infra ct-read-gateway, handler allowlist)` : ""}`,
    );
    const responseHeaders: Record<string, string> = {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    };
    // The client's 429 backoff reads Retry-After; everything else (Set-Cookie above all) stays behind.
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter !== null) responseHeaders["retry-after"] = retryAfter;
    res.writeHead(upstream.status, responseHeaders);
    res.end(payload);
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`${req.method} ${(req.url ?? "").split("?")[0]} 500 (${(err as Error).message})`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal proxy error" }));
    });
  });
}

/** Bind loopback only, on purpose: never configurable. */
export function listenLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}
