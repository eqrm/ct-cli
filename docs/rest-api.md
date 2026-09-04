# Versioned REST API

`ct server` exposes the same application operations as Commander below `/api/v1`. The operation
catalog in `src/operations/catalog.ts` is the single source for the Commander tree, HTTP router,
capability discovery and OpenAPI. Adding an application operation requires both projections; the
catalog parity test rejects a missing projection.

## Local start and pairing

```bash
ct server --port 8765 \
  --workspace /path/to/process \
  --allow-origin chrome-extension://<extension-id>
```

The server binds to `127.0.0.1` by default and prints a short-lived, single-use pairing code. The
Extension exchanges it at `POST /api/v1/pair` and receives a capability-scoped session. A bearer
session is suitable for an Extension; an `HttpOnly`, `SameSite=Strict` cookie is also issued for
same-site local clients. Pairing codes, passwords, 2FA codes, ChurchTools tokens and request bodies
are never logged.

Useful discovery endpoints:

- `GET /api/docs` — interactive Scalar API reference (loads its pinned renderer from jsDelivr)
- `GET /api/v1/health`
- `GET /api/v1/capabilities`
- `GET /api/v1/openapi.json`

The documentation page is only a projection of the generated OpenAPI contract. It does not carry
a second, manually maintained endpoint definition. Loading the Scalar renderer requires internet
access; the API and its OpenAPI document remain available without it.

Except for the OpenAPI document itself, successful JSON responses use
`{ apiVersion, requestId, operation, result }`. Within `v1`, fields and operations may be added but
existing meanings are not changed or removed. A breaking request, result, error or security change
requires a new `/api/v2` surface; old major versions remain independent adapters over the same
application operations during their documented support window.

All other endpoints require a paired session. Browser origins are matched exactly against
`--allow-origin`; wildcards and ambient cross-origin credentials are not enabled.

## Workspaces and process input

API clients select only a workspace ID returned by `GET /api/v1/workspaces`. Config, state and
initialization paths are contained below roots configured with `--workspace`; `..` and absolute
escape attempts are rejected.

Process input is JSON with a versioned envelope:

```json
{
  "schemaVersion": "1",
  "clientRevision": "checkout-form@42",
  "payload": {}
}
```

### What an input snapshot is for

If the desired structure is written directly in `ct.config.ts`, input snapshots are not needed.
The normal workflow stays:

```bash
ct plan
ct apply
```

Snapshots support a different workflow in which a browser UI collects form data. For example, a
UI could ask for a campus name and whether a kids group should be created:

```json
{
  "schemaVersion": "1",
  "clientRevision": "campus-form@42",
  "payload": {
    "campus": "Mainz",
    "withKidsGroup": true
  }
}
```

The flow is:

```text
browser form → immutable JSON snapshot → trusted generator → normal ct desired model → plan/apply
```

Creating the snapshot stores exactly these form values and returns a SHA-256 `digest`, which is its
content-based identifier. Passing that digest as `snapshotDigest` in REST or as
`--input-snapshot <digest>` in the CLI selects this exact version. It prevents form data from being
silently changed between reviewing a plan and executing an apply.

The snapshot itself does not contain a `ct.config.ts` and cannot execute code. A trusted generator
translates its JSON payload into the same resources and permissions that a normal config would
produce. The usual planner and apply engine then take over; snapshots do not introduce a second
reconciliation implementation.

Snapshots are content-addressed by a canonical SHA-256 digest and persisted immutably under
`.ct/process-input/snapshots/`. Input is data, never JavaScript supplied by the browser.

To turn input into the normal ct-cli desired model, the operator may install a trusted local
generator when starting the server:

```bash
ct server --workspace . --generator ./blueprint/process-generator.ts
```

The module exports an object with `id`, `supportedSchemaVersions`, `validate(document)` and
`generate(document)`. `generate` returns `{ resources, permissions }`. The module path is server
configuration and cannot be selected or uploaded through the API. A plan or prepared apply can
name `snapshotDigest`; both then use the same generator and application operation as the CLI.

For REST, the browser sends only data and the snapshot digest. It never sends a generator path; the
server operator fixes the trusted generator with `ct server --generator ...`. For the local CLI,
`--input-snapshot` and `--generator` must be supplied together:

```bash
ct input snapshot process.json
ct plan --input-snapshot <digest> --generator ./blueprint/process-generator.ts
ct apply --input-snapshot <digest> --generator ./blueprint/process-generator.ts
```

The equivalent CLI projection is available through `ct input`, `ct plan --input-snapshot ...
--generator ...` and `ct apply --input-snapshot ... --generator ...`.

## Mutations, progress and retries

Mutating requests accept `Idempotency-Key`. A repeated key in the same session and operation returns
the original response with `Idempotency-Replayed: true`.

Apply, destroy, `unadopt` and `unuse` are two-stage operations: prepare first, review the returned
canonical proposal and confirmation requirement, then execute the opaque operation ID with the
required proof. Apply is bound to the exact environment, config digest, state digest, plan digest
and optional immutable input snapshot. Release operations retain the exact state entry that was
reviewed and reject execution if it changed in the meantime. Prepared operations expire, are
single-use, and state-file mutations are serialized.

External-reference operations from #143 use the same catalog as their CLI commands:

- `POST /api/v1/workspaces/{workspaceId}/external-bindings` projects `ct use`;
- the `/releases/managed/...` prepare/execute pair projects `ct unadopt`;
- the `/releases/external/...` prepare/execute pair projects `ct unuse`;
- `POST /api/v1/workspaces/{workspaceId}/ownership/check` projects `ct ownership check`.

`use` validates the exact live ChurchTools object before recording a read-only binding and never
claims lifecycle ownership. `unuse` and `unadopt` only change the local state file; they never delete
or otherwise modify the ChurchTools object. Ownership checks are offline and are confined to an
explicit directory below the selected workspace root.

Long-running routes return `X-Operation-Run-Id`. Send `Prefer: respond-async` to receive `202` and
poll `GET /api/v1/runs/{runId}`. Progress is also available as shared application events at
`GET /api/v1/runs/{runId}/events` using Server-Sent Events. `DELETE /api/v1/runs/{runId}` requests
cooperative cancellation; operations stop at their next shared progress boundary.

Errors use stable `application/problem+json` envelopes with `code`, `status`, `detail` and a
request ID. Secret values are never included.

## LAN, container and reverse proxy

Listening beyond loopback is intentionally refused unless all of these are supplied:

```bash
ct server \
  --host 0.0.0.0 \
  --port 8765 \
  --trusted-proxy \
  --public-url https://ct-api.internal.example \
  --allow-origin https://extension.internal.example \
  --workspace /srv/ct/process
```

The declared reverse proxy must terminate TLS and forward only the advertised API. Do not publish
the raw HTTP listener. Remote credential submission is refused without a secure transport mode.
Use container firewall rules so only the proxy can reach the listener.

## Threat model

The API assumes the local machine or declared reverse proxy is trusted, but browser pages and API
clients are not. Controls include:

- short-lived one-time pairing and capability-scoped expiring sessions;
- exact Origin checks, restrictive CORS, CSP, no-store responses and strict cookies;
- configured workspace roots and path containment;
- request-size and per-address rate limits;
- server-held ChurchTools tokens, login continuations and prepared-operation internals;
- idempotency and per-state mutation locks;
- prepared apply binding to reviewed inputs and digests;
- no shell endpoint, no CLI subprocess and no browser-provided executable config;
- shared core guardrails for protected environments, backups, confirmation and people boundaries.

The API is designed for a trusted single-user execution service. Multi-user deployments must put
separate instances or an authorization-aware gateway in front; sharing one ct-cli process between
untrusted users is not supported.
