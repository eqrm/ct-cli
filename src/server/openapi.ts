import { operationCatalog, type JsonSchema, type OperationDefinition } from "../operations/catalog.js";
import { VERSION } from "../version.js";

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function routeParameters(definition: OperationDefinition, routePath: string): Record<string, unknown>[] {
  const parameters: Record<string, unknown>[] = [];
  const pathNames = [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
  for (const name of pathNames) {
    const declared = definition.parameters.find((parameter) => parameter.name === name);
    parameters.push({
      name,
      in: "path",
      required: true,
      description: declared?.description,
      schema: declared?.schema ?? { type: "string" },
    });
  }
  for (const parameter of definition.parameters) {
    if (!parameter.http || parameter.http.in === "body" || parameter.http.in === "path") continue;
    parameters.push({
      name: parameter.http.name ?? parameter.name,
      in: parameter.http.in,
      required: parameter.required ?? false,
      description: parameter.description,
      schema: parameter.schema,
    });
  }
  return parameters;
}

function requestBody(
  definition: OperationDefinition,
  action: string | undefined,
): Record<string, unknown> | undefined {
  const body = definition.parameters.filter(
    (parameter) =>
      parameter.http?.in === "body" && (!parameter.actions || parameter.actions.includes(action ?? "")),
  );
  if (body.length === 0) return undefined;
  const properties = Object.fromEntries(body.map((parameter) => [parameter.name, parameter.schema]));
  const required = body.filter((parameter) => parameter.required).map((parameter) => parameter.name);
  const schema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return { required: true, content: { "application/json": { schema } } };
}

export function generateOpenApi(
  catalog: readonly OperationDefinition[] = operationCatalog,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const definition of catalog) {
    for (const route of definition.http ?? []) {
      const path = openApiPath(route.path);
      const item = (paths[path] ??= {});
      const body = requestBody(definition, route.action);
      const isPublic = definition.capabilities.length === 0;
      const responseSchema =
        definition.id === "system.openapi"
          ? definition.resultSchema
          : {
              type: "object",
              required: ["apiVersion", "requestId", "operation", "result"],
              properties: {
                apiVersion: { type: "string", const: "v1" },
                requestId: { type: "string" },
                operation: { type: "string", const: definition.id },
                result: definition.resultSchema,
              },
              additionalProperties: false,
            };
      const responseMediaType = route.responseMediaType ?? "application/json";
      item[route.method.toLowerCase()] = {
        operationId: route.action ? `${definition.id}.${route.action}` : definition.id,
        summary: definition.summary,
        ...(definition.description ? { description: definition.description } : {}),
        tags: [definition.id.split(".")[0]],
        parameters: routeParameters(definition, route.path),
        ...(body ? { requestBody: body } : {}),
        security: isPublic ? [] : [{ bearerSession: [] }, { cookieSession: [] }],
        responses: {
          [String(route.successStatus ?? 200)]: {
            description: "Successful operation",
            content: { [responseMediaType]: { schema: responseSchema } },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "409": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
        "x-ct-capabilities": definition.capabilities,
        "x-ct-long-running": definition.longRunning,
      };
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "ct-cli Extension API",
      version: `1.0.0+ct.${VERSION}`,
      description:
        "Versioned transport projection of ct-cli application operations. Most CLI users continue to use ct.config.ts directly. Process-input snapshots are an optional browser-form workflow: immutable JSON input is selected by its SHA-256 digest, translated by an operator-installed trusted generator, and then processed by the same plan/apply engine.",
    },
    // Catalog routes already carry their full versioned path. Keeping the server at the origin
    // avoids clients composing URLs such as /api/v1/api/v1/health.
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        bearerSession: { type: "http", scheme: "bearer" },
        cookieSession: { type: "apiKey", in: "cookie", name: "ct_session" },
      },
      schemas: {
        Problem: {
          type: "object",
          required: ["type", "title", "status", "code", "detail", "requestId"],
          properties: {
            type: { type: "string", format: "uri-reference" },
            title: { type: "string" },
            status: { type: "integer" },
            code: { type: "string" },
            detail: { type: "string" },
            requestId: { type: "string" },
            details: { type: "object", additionalProperties: true },
          },
        },
      },
      responses: {
        Problem: {
          description: "Stable structured error",
          content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
        },
      },
    },
  };
}
