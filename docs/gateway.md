# Read-only gateway (`ct gateway proxy`)

Debug a protected instance without a ChurchTools credential on your machine. A small AWS
gateway sits in front of ChurchTools, holds the session itself, only allows reads, and
projects person data down to names. `ct gateway proxy` is the local half: a loopback
server that signs your requests with AWS SigV4 (service `execute-api`) and forwards them.

```text
ct get raw / tofu plan  ->  http://127.0.0.1:8766  ->  (SigV4)  ->  gateway  ->  ChurchTools
   no credential            ct gateway proxy            reader role    holds the session
```

## Configure

An environment with a `gateway` block in `ct.envs.json`. Its `host` is the local proxy
(only `http://127.0.0.1:<port>` is accepted for a gateway env); the block says where the
proxy forwards to:

```json
{
  "environments": {
    "prod-ro": {
      "host": "http://127.0.0.1:8766",
      "gateway": {
        "url": "https://<id>.execute-api.eu-central-1.amazonaws.com",
        "region": "eu-central-1",
        "profile": "ct-gateway-reader"
      }
    }
  }
}
```

The AWS profile assumes the reader role (`~/.aws/config`). The reader role needs no MFA, so
the default profile has no `mfa_serial` and `ct gateway proxy` never prompts:

```ini
[profile ct-gateway-reader]
role_arn = arn:aws:iam::<account>:role/<gateway-reader-role>
source_profile = default
region = eu-central-1
```

Role sessions last one hour. The proxy re-assumes the role shortly before expiry, silently.

Optional: if a role does require MFA, add `mfa_serial = arn:aws:iam::<account>:mfa/<user>` to
the profile. The proxy then asks for the code on the terminal at start and at every refresh.
Without a terminal (a Claude Code session, a background job) it does not wait for input: it
fails at once with "requires MFA; start `ct gateway proxy` in your own terminal".

## Read as another person (`--simulate`)

The gateway also serves `GET /simulate/<personId>/api/...`: the same allowlisted reads, but as
that ChurchTools person, to see what they see. It is opt-in:

```bash
ct gateway proxy --env prod-ro --simulate                  # profile eqrm-ct-simulate
ct gateway proxy --env prod-ro --simulate --simulate-profile my-simulate
ct get raw /simulate/<personId>/api/persons/<personId> --env prod-ro
```

The simulate role is a different role from the reader and can invoke only `GET /simulate/*`; the
reader role gets 403 on `/simulate`, so the proxy holds two credential sets and picks per request.
`/simulate/...` is signed with the simulate role, everything else with the reader role. The profile
(`~/.aws/config`):

```ini
[profile eqrm-ct-simulate]
source_profile = default
role_arn = arn:aws:iam::<account>:role/<gateway-simulate-role>
mfa_serial = arn:aws:iam::<account>:mfa/<user>
```

- **MFA is enforced by the role's trust policy, not by the proxy.** The proxy only asks for the code
  (on the terminal, at start, so a wrong profile or code fails before it listens). Without a
  terminal it fails at once.
- Without `--simulate`, `/simulate/...` stays refused locally (403, the hint names the flag).
- With it, the proxy forwards only `GET /simulate/<personId>/api/...`: `personId` is digits, no
  leading zero, not 0; anything else under `/simulate` and every non-GET is refused locally. Query
  handling and `login_token` stripping are the same as for `/api`.
- The gateway refuses unknown persons and admins (`{"error":"ChurchTools refused the simulation"}`):
  an admin cannot be simulated.
- A role session lasts at most an hour. When it is about to expire, the next `/simulate` request
  asks for a new MFA code on the proxy's terminal (same caching as the reader credentials; that
  request waits for the code). Requests on `/api` are not affected.
- ChurchTools keeps one simulation per session (measured 2026-11-09), so simulating person B
  after person A on the same gateway session replaces A; do not run two simulations in parallel.
- The log line of a simulated request carries the person id: `GET /simulate/<id>/api/... 200 [simulate person <id>]`.

## Use

```bash
ct gateway proxy --env prod-ro        # listens; Ctrl-C stops it (asks for a code only if the profile has mfa_serial)
# in another shell:
ct get raw /groups/123 --env prod-ro
ct auth token --env prod-ro --raw     # placeholder "via-gateway" for tofu's ct_auth=session
```

For `tofu plan`, point the provider at the env's host and let `ct auth token --env prod-ro`
feed `ct_auth=session` as usual. The credential it prints is a placeholder; the proxy
discards it and the gateway uses its own session.

## What is enforced, and where

- The proxy binds `127.0.0.1` only. It builds every upstream request from scratch:
  `Cookie`, `Authorization`, CSRF headers and any `login_token` query parameter never leave
  the machine.
- Locally refused with 403: everything except `GET /api/...` (plus `GET /simulate/<personId>/api/...`
  with `--simulate`) and the two legacy
  `POST /index.php?q=churchauth/ajax` and `?q=churchdb/ajax` calls whose body is exactly
  `func=getMasterData`. The gateway applies its own, stricter allowlist as the second lock.
- `ct` itself refuses writes for a gateway env ("`prod-ro` is read-only; writes happen in
  CI") before any request is made.
- One log line per request on stderr: method, path without query, status. Never bodies.
- Credentials are re-requested shortly before the assumed role expires (a new MFA prompt only
  if the profile has `mfa_serial`; with `--simulate`, the simulate profile always has one).
- A `403` with a `blocked` body is the gateway's allowlist deciding. The proxy passes it to the
  client unchanged and logs that the path is not on the gateway allowlist; `ct` reports the same.
  Widening the allowlist is a change to the gateway's handler allowlist, made by whoever runs
  the gateway. There is no automatic retry and no switching to another tier.
