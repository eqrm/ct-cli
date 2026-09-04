import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { authedSession } from "../api/session.js";
import { beginPasswordLogin, continuePasswordLogin, type PasswordLoginContinuation } from "../auth/login.js";
import { readToken } from "../auth/tokenStore.js";
import { CtApplicationError } from "../application/errors.js";
import { runAdoptGroups } from "../application/operations/adopt-group.js";
import { runAdoptGrants } from "../application/operations/adopt-grants.js";
import { runAdoptResource } from "../application/operations/adopt.js";
import { runAuthLogin, runAuthLogout, runAuthStatus } from "../application/operations/auth.js";
import {
  executePreparedApply,
  prepareApply,
  type ConfirmationProof,
  type PreparedApplyExecution,
} from "../application/operations/apply.js";
import { runCoverage } from "../application/operations/coverage.js";
import {
  executePreparedDestroy,
  prepareDestroy,
  type PreparedDestroyExecution,
} from "../application/operations/destroy.js";
import { listEnvironments } from "../application/operations/environment.js";
import {
  createInputSnapshot,
  getInputSnapshot,
  listInputSnapshots,
  validateProcessInput,
  type ProcessInputDocument,
  type ProcessInputGenerator,
} from "../application/operations/input.js";
import { runInitWorkspace } from "../application/operations/init.js";
import { checkOwnership } from "../application/operations/ownership.js";
import { runPlan } from "../application/operations/plan.js";
import { runRefresh } from "../application/operations/refresh.js";
import {
  executePreparedRelease,
  prepareRelease,
  type PreparedReleaseExecution,
  type ReleaseConfirmationProof,
} from "../application/operations/release.js";
import { listState, removeStateEntry } from "../application/operations/state.js";
import { runUseResource } from "../application/operations/use.js";
import { PreparedOperationStore, InMemoryMutationLock } from "../application/prepared-operation-store.js";
import type { OperationObserver } from "../application/ports.js";
import { resolveProject as resolveApplicationProject } from "../application/project.js";
import {
  operationCatalog,
  type OperationDefinition,
  type OperationHttpProjection,
} from "../operations/catalog.js";
import { VERSION } from "../version.js";
import { generateOpenApi } from "./openapi.js";
import { OperationRunStore } from "./runs.js";
import { renderScalarDocs } from "./scalar-docs.js";
import { RateLimiter, SessionManager, type ApiSession } from "./session.js";
import { WorkspaceRegistry, type Workspace } from "./workspaces.js";

const API_VERSION = "v1";
const DEFAULT_BODY_LIMIT = 1024 * 1024;

interface MatchedRoute {
  definition: OperationDefinition;
  projection: OperationHttpProjection;
  params: Record<string, string>;
}

interface HandlerResult {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ApiServerOptions {
  workspaceRoots: readonly string[];
  allowedOrigins?: readonly string[];
  secureTransport?: boolean;
  bodyLimitBytes?: number;
  rateLimitPerMinute?: number;
  sessions?: SessionManager;
  runs?: OperationRunStore;
  /** Trusted, operator-installed generator. Never selected or uploaded by an API client. */
  generator?: ProcessInputGenerator;
  audit?: (event: ApiAuditEvent) => void;
}

export interface ApiAuditEvent {
  requestId: string;
  timestamp: string;
  remoteAddress: string;
  method: string;
  path: string;
  operation: string | null;
  sessionId: string | null;
  status: number;
}

export interface CtApiServer {
  server: Server;
  pairingCode: string;
  pairingExpiresAt: string;
  workspaces: readonly Workspace[];
  openapi: Record<string, unknown>;
}

function compileRoute(path: string): RegExp {
  const escaped = path
    .split("/")
    .map((part) => (part.startsWith(":") ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${escaped}/?$`);
}

function matchRoute(method: string, pathname: string): MatchedRoute | null {
  for (const definition of operationCatalog) {
    for (const projection of definition.http ?? []) {
      if (projection.method !== method) continue;
      const match = compileRoute(projection.path).exec(pathname);
      if (!match) continue;
      const names = [...projection.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((item) => item[1]!);
      return {
        definition,
        projection,
        params: Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)])),
      };
    }
  }
  return null;
}

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new CtApplicationError("REQUEST_TOO_LARGE", "Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JSON request body must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function cookieToken(request: IncomingMessage): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const pair of raw.split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === "ct_session") return value.join("=");
  }
  return undefined;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return cookieToken(request);
}

function problem(error: unknown, requestId: string): { status: number; body: Record<string, unknown> } {
  let status = 400;
  let code = "INVALID_REQUEST";
  let detail = error instanceof Error ? error.message : "Request failed.";
  let details: unknown;
  if (error instanceof SyntaxError) {
    code = "INVALID_JSON";
    detail = "Request body is not valid JSON.";
  } else if (error instanceof CtApplicationError) {
    code = error.code;
    details = error.details;
    if (error.code === "AUTH_REQUIRED") status = 401;
    else if (error.code === "OPERATION_EXPIRED") status = 410;
    else if (error.code === "REQUEST_TOO_LARGE") status = 413;
    else if (
      [
        "MUTATION_BUSY",
        "OPERATION_ALREADY_USED",
        "PLAN_CONFIRMATION_MISMATCH",
        "PREVENT_DESTROY",
        "IDEMPOTENCY_CONFLICT",
        "EXTERNAL_REFERENCE_BLOCKED",
        "EXTERNAL_CONFIRMATION_REQUIRED",
        "STATE_RELEASE_CONFIRMATION_REQUIRED",
      ].includes(error.code)
    )
      status = 409;
  } else if (error instanceof Error && error.name === "Forbidden") {
    status = 403;
    code = "CAPABILITY_DENIED";
  } else if (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    status = 404;
    code = "NOT_FOUND";
    detail = "Requested resource was not found.";
  }
  return {
    status,
    body: {
      type: `https://github.com/eqrm/ct-cli/blob/main/docs/rest-api.md#${code.toLowerCase()}`,
      title: code.replaceAll("_", " ").toLowerCase(),
      status,
      code,
      detail,
      requestId,
      ...(details ? { details } : {}),
    },
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Type": status >= 400 ? "application/problem+json" : "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  response.end(payload);
}

function sendScalarDocs(response: ServerResponse): void {
  const nonce = randomBytes(18).toString("base64");
  const payload = renderScalarDocs(nonce);
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net`,
      "style-src 'unsafe-inline'",
      "img-src data: https:",
      "font-src data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
    "Referrer-Policy": "no-referrer",
  });
  response.end(payload);
}

function successBody(operation: string, requestId: string, result: unknown): unknown {
  if (operation === "system.openapi") return result;
  return { apiVersion: API_VERSION, requestId, operation, result };
}

function string(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function bool(body: Record<string, unknown>, name: string): boolean | undefined {
  return typeof body[name] === "boolean" ? (body[name] as boolean) : undefined;
}

function strings(body: Record<string, unknown>, name: string): string[] | undefined {
  const value = body[name];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function confirmationProof(value: unknown): ConfirmationProof | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("confirmation must be an object.");
  }
  const proof = value as Record<string, unknown>;
  if (proof.type === "yes") return { type: "yes" };
  if (proof.type === "environment" && typeof proof.value === "string") {
    return { type: "environment", value: proof.value };
  }
  throw new Error("confirmation must be {type: yes} or {type: environment, value: name}.");
}

function releaseConfirmationProof(value: unknown): ReleaseConfirmationProof | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("confirmation must be an object.");
  }
  const proof = value as Record<string, unknown>;
  if ((proof.type === "environment" || proof.type === "key") && typeof proof.value === "string") {
    return { type: proof.type, value: proof.value };
  }
  throw new Error("confirmation must be {type: environment|key, value: string}.");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function assertCapabilities(session: ApiSession, definition: OperationDefinition): void {
  const missing = definition.capabilities.filter((capability) => !session.capabilities.has(capability));
  if (missing.length > 0) {
    const error = new Error(`Session lacks required capabilities: ${missing.join(", ")}.`);
    error.name = "Forbidden";
    throw error;
  }
}

function matchesSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const expected = schema.type;
  if (expected === "array") {
    if (!Array.isArray(value)) return false;
    const items = schema.items;
    return (
      typeof items !== "object" ||
      items === null ||
      value.every((item) => matchesSchema(item, items as Record<string, unknown>))
    );
  }
  if (expected === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  } else if (typeof expected === "string" && typeof value !== expected) {
    return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (typeof value === "string" && typeof schema.pattern === "string") {
    return new RegExp(schema.pattern).test(value);
  }
  return true;
}

function validateTransportInput(
  matched: MatchedRoute,
  body: Record<string, unknown>,
  request: IncomingMessage,
  url: URL,
): void {
  for (const parameter of matched.definition.parameters) {
    if (
      !parameter.http ||
      (parameter.actions && !parameter.actions.includes(matched.projection.action ?? ""))
    ) {
      continue;
    }
    const externalName = parameter.http.name ?? parameter.name;
    const value =
      parameter.http.in === "body"
        ? body[parameter.name]
        : parameter.http.in === "path"
          ? matched.params[parameter.name]
          : parameter.http.in === "query"
            ? (url.searchParams.get(externalName) ?? undefined)
            : request.headers[externalName.toLowerCase()];
    if (value === undefined) {
      if (parameter.required) throw new Error(`${parameter.name} is required.`);
      continue;
    }
    if (!matchesSchema(value, parameter.schema)) {
      throw new Error(`${parameter.name} does not match its operation schema.`);
    }
  }
}

async function requestProject(
  workspace: Workspace,
  registry: WorkspaceRegistry,
  body: Record<string, unknown>,
): Promise<{ cwd: string; environment?: string; configPath?: string; statePath?: string }> {
  const config = string(body, "configPath");
  const state = string(body, "statePath");
  return {
    cwd: workspace.path,
    environment: string(body, "environment"),
    ...(config ? { configPath: await registry.resolveSafeWithin(workspace, config) } : {}),
    ...(state ? { statePath: await registry.resolveSafeWithin(workspace, state) } : {}),
  };
}

export async function createCtApiServer(options: ApiServerOptions): Promise<CtApiServer> {
  const workspaces = await WorkspaceRegistry.create(options.workspaceRoots);
  const sessions = options.sessions ?? new SessionManager();
  const runs = options.runs ?? new OperationRunStore();
  const rateLimiter = new RateLimiter(options.rateLimitPerMinute);
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const openapi = generateOpenApi();
  const applyStore = new PreparedOperationStore<PreparedApplyExecution>();
  const destroyStore = new PreparedOperationStore<PreparedDestroyExecution>();
  const releaseStore = new PreparedOperationStore<PreparedReleaseExecution>();
  const loginContinuationStore = new PreparedOperationStore<PasswordLoginContinuation>();
  const mutationLock = new InMemoryMutationLock();
  const idempotency = new Map<string, { requestDigest: string; result: HandlerResult }>();
  const preparedWorkspace = new Map<string, { workspaceId: string; snapshotDigest?: string }>();

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const auditContext = { operation: null as string | null, sessionId: null as string | null };
    response.once("finish", () => {
      options.audit?.({
        requestId,
        timestamp: new Date().toISOString(),
        remoteAddress: request.socket.remoteAddress ?? "unknown",
        method: request.method ?? "GET",
        path: new URL(request.url ?? "/", "http://ct.local").pathname,
        operation: auditContext.operation,
        sessionId: auditContext.sessionId,
        status: response.statusCode,
      });
    });
    response.setHeader("X-Request-Id", requestId);
    try {
      const remote = request.socket.remoteAddress ?? "unknown";
      if (!rateLimiter.allow(remote)) {
        sendJson(
          response,
          429,
          {
            ...problem(new Error("Rate limit exceeded."), requestId).body,
            status: 429,
            code: "RATE_LIMITED",
          },
          { "Retry-After": "60" },
        );
        return;
      }
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin)) {
        const denied = problem(new Error("Origin is not allowlisted."), requestId);
        sendJson(response, 403, { ...denied.body, status: 403, code: "ORIGIN_DENIED" });
        return;
      }
      if (origin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, Prefer",
          "Access-Control-Max-Age": "600",
        });
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://ct.local");
      const matched = matchRoute(request.method ?? "GET", url.pathname);
      if (!matched) {
        sendJson(response, 404, {
          ...problem(new Error("No route matches this request."), requestId).body,
          status: 404,
          code: "NOT_FOUND",
        });
        return;
      }
      auditContext.operation = matched.definition.id;

      const isPublic = matched.definition.capabilities.length === 0;
      const session = isPublic ? null : sessions.authenticate(bearerToken(request));
      auditContext.sessionId = session?.id ?? null;
      if (!isPublic && !session) {
        sendJson(
          response,
          401,
          {
            ...problem(new Error("A valid paired session is required."), requestId).body,
            status: 401,
            code: "SESSION_REQUIRED",
          },
          { "WWW-Authenticate": "Bearer" },
        );
        return;
      }
      if (session) assertCapabilities(session, matched.definition);

      if (matched.definition.id === "system.docs") {
        sendScalarDocs(response);
        return;
      }

      const body = ["POST", "DELETE"].includes(request.method ?? "")
        ? await readJson(request, options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT)
        : {};
      validateTransportInput(matched, body, request, url);

      if (matched.definition.id === "run.events") {
        const run = runs.get(matched.params.runId!);
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        for (const event of run.events) response.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
        response.write(
          `event: status\ndata: ${JSON.stringify({ status: run.status, result: run.result, error: run.error })}\n\n`,
        );
        response.end();
        return;
      }

      const invoke = async (observer: OperationObserver): Promise<HandlerResult> => {
        const id = matched.definition.id;
        if (id === "system.health") return { body: { status: "ok", version: VERSION } };
        if (id === "system.capabilities") {
          return {
            body: {
              operations: operationCatalog.map((operation) => ({
                id: operation.id,
                mutation: operation.mutation,
                longRunning: operation.longRunning,
                capabilities: operation.capabilities,
                cli: operation.cli,
                http: operation.http,
              })),
            },
          };
        }
        if (id === "system.openapi") return { body: openapi };
        if (id === "session.pair") {
          const code = string(body, "code");
          if (!code) throw new Error("Pairing code is required.");
          const requested = strings(body, "capabilities");
          const paired = sessions.pair(code, requested);
          return {
            body: {
              session: {
                id: paired.session.id,
                capabilities: [...paired.session.capabilities],
                expiresAt: paired.session.expiresAt.toISOString(),
              },
              token: paired.token,
            },
            headers: {
              "Set-Cookie": `ct_session=${paired.token}; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=28800${options.secureTransport ? "; Secure" : ""}`,
            },
          };
        }
        if (id === "workspace.list") {
          return { body: { operation: id, workspaces: workspaces.workspaces } };
        }
        if (id === "run.get") return { body: runs.get(matched.params.runId!) };
        if (id === "run.cancel") return { body: runs.cancel(matched.params.runId!) };
        if (id === "workspace.init") {
          const directory = string(body, "directory");
          if (!directory) throw new Error("directory is required.");
          const rootId = string(body, "rootId");
          const target = rootId
            ? await workspaces.resolveSafeWithin(workspaces.get(rootId), directory)
            : await workspaces.resolveAnySafe(directory);
          return {
            status: 201,
            body: await runInitWorkspace({
              directory: target,
              template: string(body, "template"),
              host: string(body, "host"),
              environment: string(body, "environment"),
              protected: bool(body, "protected"),
              git: bool(body, "git"),
              yes: true,
            }),
          };
        }

        const workspaceId = matched.params.workspaceId;
        if (!workspaceId) throw new Error("Workspace route is missing workspaceId.");
        const workspace = workspaces.get(workspaceId);
        const runtimeEnv: NodeJS.ProcessEnv = { ...process.env };
        const project = await requestProject(workspace, workspaces, body);
        const projectDependencies = { env: runtimeEnv, cwd: () => workspace.path };
        const sessionForProject = () => authedSession(runtimeEnv);
        const workspacePath = async (name: string): Promise<string | undefined> => {
          const value = string(body, name);
          return value ? workspaces.resolveSafeWithin(workspace, value) : undefined;
        };
        if (
          [
            "plan",
            "apply",
            "coverage",
            "refresh",
            "state.list",
            "state.remove",
            "destroy",
            "adopt.resource",
            "adopt.groups",
            "adopt.grants",
            "use.resource",
            "release.managed",
            "release.external",
          ].includes(id)
        ) {
          const resolved = await resolveApplicationProject(project, projectDependencies);
          project.configPath = await workspaces.resolveSafeWithin(workspace, resolved.configPath);
          project.statePath = await workspaces.resolveSafeWithin(workspace, resolved.statePath);
        }
        const generatedConfig = async (digest: string) => {
          if (!options.generator) {
            throw new Error("No trusted process-input generator is configured on this server.");
          }
          const snapshot = (await getInputSnapshot(workspace.path, digest)).value;
          if (!options.generator.supportedSchemaVersions.includes(snapshot.schemaVersion)) {
            throw new Error(
              `Generator ${options.generator.id} does not support schema ${snapshot.schemaVersion}.`,
            );
          }
          const validation = await options.generator.validate(snapshot);
          if (!validation.valid) {
            throw new Error(
              `Process input rejected by ${options.generator.id}: ${validation.errors
                .map((item) => `${item.path} ${item.message}`)
                .join(", ")}`,
            );
          }
          return options.generator.generate(snapshot);
        };

        if (id === "environment.list") {
          return { body: await listEnvironments({ cwd: workspace.path }, { env: runtimeEnv }) };
        }
        if (id === "auth.status") {
          return {
            body: await runAuthStatus(
              { cwd: workspace.path, environment: project.environment, all: bool(body, "all") },
              {
                env: runtimeEnv,
                project: projectDependencies,
                readToken: (host) => readToken(host, runtimeEnv),
                authedSession: sessionForProject,
              },
            ),
          };
        }
        if (id === "auth.login") {
          if (
            !options.secureTransport &&
            !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.localAddress ?? "")
          ) {
            throw new Error("Remote credential submission requires HTTPS.");
          }
          let host = string(body, "host");
          let token = string(body, "token");
          const continuationId = string(body, "continuationId");
          if (continuationId) {
            const totp = string(body, "totp");
            if (!totp) throw new Error("totp is required with continuationId.");
            const continuation = loginContinuationStore.take(continuationId);
            host = continuation.host;
            token = await continuePasswordLogin(continuation, totp);
          } else if (!token) {
            if (!host) throw new Error("host is required.");
            const username = string(body, "username");
            const password = string(body, "password");
            if (!username || !password) throw new Error("Provide token, or username and password.");
            const started = await beginPasswordLogin(host, username, password);
            if (started.kind === "totp") {
              const stored = loginContinuationStore.put(started.continuation, 5 * 60_000);
              return {
                status: 202,
                body: {
                  operation: "auth",
                  action: "login",
                  status: "totp-required",
                  continuationId: stored.id,
                  expiresAt: stored.expiresAt!.toISOString(),
                },
              };
            }
            token = started.token;
          }
          if (!host) throw new Error("host is required.");
          return { body: await runAuthLogin({ host, token }) };
        }
        if (id === "auth.logout") {
          return { body: await runAuthLogout({ cwd: workspace.path, environment: project.environment }) };
        }
        if (id === "input.validate") {
          const base = validateProcessInput(body.document);
          if (!base.valid || !options.generator) return { body: base };
          const document = body.document as ProcessInputDocument;
          if (!options.generator.supportedSchemaVersions.includes(document.schemaVersion)) {
            return {
              body: {
                ...base,
                valid: false,
                errors: [{ path: "/schemaVersion", message: `is not supported by ${options.generator.id}` }],
                generator: options.generator.id,
              },
            };
          }
          const validation = await options.generator.validate(document);
          return { body: { ...base, ...validation, generator: options.generator.id } };
        }
        if (id === "input.snapshot") {
          const document = body.document as ProcessInputDocument | undefined;
          if (!document) throw new Error("document is required.");
          return {
            status: 201,
            body: await createInputSnapshot({ ...document, cwd: workspace.path, persist: true }),
          };
        }
        if (id === "input.list") return { body: await listInputSnapshots(workspace.path) };
        if (id === "input.get")
          return { body: await getInputSnapshot(workspace.path, matched.params.digest!) };
        if (id === "plan") {
          const snapshotDigest = string(body, "snapshotDigest");
          const generated = snapshotDigest ? await generatedConfig(snapshotDigest) : null;
          return {
            body: await runPlan(project, {
              project: projectDependencies,
              authedSession: sessionForProject,
              observer,
              ...(generated ? { loadConfig: async () => ({ ...generated, configDir: workspace.path }) } : {}),
            }),
          };
        }
        if (id === "apply" && matched.projection.action === "prepare") {
          const snapshotDigest = string(body, "snapshotDigest");
          const generated = snapshotDigest ? await generatedConfig(snapshotDigest) : null;
          const prepared = await prepareApply(
            { ...project, backupDir: await workspacePath("backupDir"), refresh: bool(body, "refresh") },
            {
              project: projectDependencies,
              authedSession: sessionForProject,
              observer,
              store: applyStore,
              lock: mutationLock,
              env: runtimeEnv,
              ...(generated ? { loadConfig: async () => ({ ...generated, configDir: workspace.path }) } : {}),
            },
          );
          preparedWorkspace.set(prepared.id, { workspaceId, ...(snapshotDigest ? { snapshotDigest } : {}) });
          return { status: 201, body: { ...prepared, snapshotDigest: snapshotDigest ?? null } };
        }
        if (id === "apply" && matched.projection.action === "execute") {
          const operationId = matched.params.operationId!;
          const binding = preparedWorkspace.get(operationId);
          if (!binding || binding.workspaceId !== workspaceId)
            throw new Error("Prepared apply does not belong to this workspace.");
          if (binding.snapshotDigest) await getInputSnapshot(workspace.path, binding.snapshotDigest);
          const result = await executePreparedApply(
            { id: operationId },
            confirmationProof(body.confirmation),
            {
              store: applyStore,
              lock: mutationLock,
              observer,
              env: runtimeEnv,
            },
          );
          preparedWorkspace.delete(operationId);
          return { body: result };
        }
        if (id === "coverage") {
          return {
            body: await runCoverage(
              {
                ...project,
                type: string(body, "type"),
                declarable: bool(body, "declarable"),
                blocked: bool(body, "blocked"),
              },
              { project: projectDependencies, authedSession: sessionForProject, observer },
            ),
          };
        }
        if (id === "refresh") {
          return {
            body: await runRefresh(
              { ...project, group: string(body, "group"), all: bool(body, "all") },
              { project: projectDependencies, authedSession: sessionForProject, observer },
            ),
          };
        }
        if (id === "state.list") {
          return { body: await listState(project, { project: projectDependencies }) };
        }
        if (id === "state.remove") {
          return {
            body: await removeStateEntry(
              {
                ...project,
                type: matched.params.type!,
                key: matched.params.key!,
                force: bool(body, "force"),
                dryRun: bool(body, "dryRun"),
              },
              { project: projectDependencies, lock: mutationLock },
            ),
          };
        }
        if (id === "destroy" && matched.projection.action === "prepare") {
          const prepared = await prepareDestroy(
            {
              ...project,
              targets: strings(body, "targets"),
              memberFields: strings(body, "memberFields"),
              backupDir: await workspacePath("backupDir"),
            },
            {
              project: projectDependencies,
              authedSession: sessionForProject,
              observer,
              store: destroyStore,
              lock: mutationLock,
              env: runtimeEnv,
            },
          );
          preparedWorkspace.set(prepared.id, { workspaceId });
          return { status: 201, body: prepared };
        }
        if (id === "destroy" && matched.projection.action === "execute") {
          const operationId = matched.params.operationId!;
          const binding = preparedWorkspace.get(operationId);
          if (!binding || binding.workspaceId !== workspaceId)
            throw new Error("Prepared destroy does not belong to this workspace.");
          const result = await executePreparedDestroy(
            { id: operationId },
            confirmationProof(body.confirmation),
            { store: destroyStore, lock: mutationLock, observer, env: runtimeEnv },
          );
          preparedWorkspace.delete(operationId);
          return { body: result };
        }
        if (id === "adopt.resource") {
          return {
            body: await runAdoptResource(
              {
                ...project,
                type: string(body, "type")!,
                id: string(body, "id")!,
                key: string(body, "key"),
                rekey: bool(body, "rekey"),
                dryRun: bool(body, "dryRun"),
              },
              { project: projectDependencies, authedSession: sessionForProject },
            ),
          };
        }
        if (id === "adopt.groups") {
          return {
            body: await runAdoptGroups(
              {
                ...project,
                ids: strings(body, "ids") ?? [],
                groupType: string(body, "groupType"),
                childrenOf: string(body, "childrenOf"),
                dryRun: bool(body, "dryRun"),
              },
              {
                project: projectDependencies,
                authedSession: sessionForProject,
                lock: mutationLock,
                observer,
              },
            ),
          };
        }
        if (id === "adopt.grants") {
          return {
            body: await runAdoptGrants(
              {
                ...project,
                domainType: string(body, "domainType"),
                domainId: string(body, "domainId"),
                group: string(body, "group"),
                allDeclarable: bool(body, "allDeclarable"),
              },
              { project: projectDependencies, authedSession: sessionForProject, observer },
            ),
          };
        }
        if (id === "use.resource") {
          return {
            body: await runUseResource(
              {
                ...project,
                type: string(body, "type")!,
                id: string(body, "id")!,
                key: string(body, "key")!,
                owner: string(body, "owner"),
                acceptChanges: bool(body, "acceptChanges"),
                dryRun: bool(body, "dryRun"),
              },
              {
                project: projectDependencies,
                authedSession: sessionForProject,
                lock: mutationLock,
              },
            ),
          };
        }
        if (
          (id === "release.managed" || id === "release.external") &&
          matched.projection.action === "prepare"
        ) {
          const prepared = await prepareRelease(
            {
              ...project,
              type: matched.params.type!,
              key: matched.params.key!,
              kind: id === "release.managed" ? "managed" : "external",
              force: bool(body, "force"),
            },
            { project: projectDependencies, store: releaseStore, lock: mutationLock },
          );
          preparedWorkspace.set(prepared.id, { workspaceId });
          return { status: 201, body: prepared };
        }
        if (
          (id === "release.managed" || id === "release.external") &&
          matched.projection.action === "execute"
        ) {
          const operationId = matched.params.operationId!;
          const binding = preparedWorkspace.get(operationId);
          if (!binding || binding.workspaceId !== workspaceId) {
            throw new Error("Prepared release does not belong to this workspace.");
          }
          const result = await executePreparedRelease(
            { id: operationId },
            releaseConfirmationProof(body.confirmation),
            { project: projectDependencies, store: releaseStore, lock: mutationLock },
          );
          preparedWorkspace.delete(operationId);
          return { body: result };
        }
        if (id === "ownership.check") {
          const root = string(body, "root")!;
          const environment = string(body, "environment")!;
          return {
            body: await checkOwnership({
              root: await workspaces.resolveSafeWithin(workspace, root),
              environment,
              cwd: workspace.path,
            }),
          };
        }
        throw new Error(`No handler for operation ${id}.`);
      };

      const idempotencyKey = request.headers["idempotency-key"];
      const cacheKey =
        matched.definition.mutation && typeof idempotencyKey === "string" && session
          ? `${session.id}:${matched.definition.id}:${matched.projection.action ?? "run"}:${idempotencyKey}`
          : null;
      const requestDigest = createHash("sha256")
        .update(`${request.method}\0${url.pathname}\0${stableJson(body)}`)
        .digest("hex");
      const cached = cacheKey ? idempotency.get(cacheKey) : undefined;
      if (cached) {
        if (cached.requestDigest !== requestDigest) {
          throw new CtApplicationError(
            "IDEMPOTENCY_CONFLICT",
            "The Idempotency-Key was already used with a different request.",
          );
        }
        sendJson(
          response,
          cached.result.status ?? 200,
          successBody(matched.definition.id, requestId, cached.result.body),
          {
            ...cached.result.headers,
            "Idempotency-Replayed": "true",
          },
        );
        return;
      }

      const { run, observer } = runs.create(matched.definition.id);
      if (matched.definition.longRunning && request.headers.prefer === "respond-async") {
        const accepted: HandlerResult = {
          status: 202,
          body: { operation: matched.definition.id, runId: run.id, status: "running" },
          headers: { Location: `/api/v1/runs/${run.id}` },
        };
        if (cacheKey) idempotency.set(cacheKey, { requestDigest, result: accepted });
        sendJson(
          response,
          accepted.status!,
          successBody(matched.definition.id, requestId, accepted.body),
          accepted.headers,
        );
        void invoke(observer).then(
          (result) => runs.succeed(run.id, result.body),
          (error) => runs.fail(run.id, problem(error, requestId).body),
        );
        return;
      }
      const result = await invoke(observer);
      runs.succeed(run.id, result.body);
      result.headers = { ...result.headers, "X-Operation-Run-Id": run.id };
      if (cacheKey) idempotency.set(cacheKey, { requestDigest, result });
      sendJson(
        response,
        result.status ?? matched.projection.successStatus ?? 200,
        successBody(matched.definition.id, requestId, result.body),
        result.headers,
      );
    } catch (error) {
      const output = problem(error, requestId);
      sendJson(response, output.status, { ...output.body, status: output.status });
    }
  });

  return {
    server,
    pairingCode: sessions.pairingCode,
    pairingExpiresAt: sessions.pairingExpiresAt.toISOString(),
    workspaces: workspaces.workspaces,
    openapi,
  };
}
