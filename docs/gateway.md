# Read-only gateway (`ct gateway proxy`)

Debug a protected instance without a ChurchTools credential on your machine. A small AWS
gateway sits in front of ChurchTools, holds the session itself, only allows reads, and
projects person data down to names. `ct gateway proxy` is the local half: a loopback
server that signs your requests with AWS SigV4 (service `execute-api`) and forwards them.

```text
ct get raw / tofu plan  ->  http://127.0.0.1:8766  ->  (SigV4)  ->  gateway  ->  ChurchTools
   no credential            ct gateway proxy            MFA role       holds the session
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
        "profile": "eqrm-ct-reader"
      }
    }
  }
}
```

The AWS profile assumes the reader role with MFA (`~/.aws/config`):

```ini
[profile eqrm-ct-reader]
role_arn = arn:aws:iam::<account>:role/<gateway-reader-role>
source_profile = default
mfa_serial = arn:aws:iam::<account>:mfa/<user>
region = eu-central-1
```

## Use

```bash
ct gateway proxy --env prod-ro        # asks for the MFA code, then listens; Ctrl-C stops it
# in another shell:
ct get raw /groups/864 --env prod-ro
ct auth token --env prod-ro --raw     # placeholder "via-gateway" for tofu's ct_auth=session
```

For `tofu plan`, point the provider at the env's host and let `ct auth token --env prod-ro`
feed `ct_auth=session` as usual. The credential it prints is a placeholder; the proxy
discards it and the gateway uses its own session.

## What is enforced, and where

- The proxy binds `127.0.0.1` only. It builds every upstream request from scratch:
  `Cookie`, `Authorization`, CSRF headers and any `login_token` query parameter never leave
  the machine.
- Locally refused with 403: everything except `GET /api/...` and the two legacy
  `POST /index.php?q=churchauth/ajax` and `?q=churchdb/ajax` calls whose body is exactly
  `func=getMasterData`. The gateway applies its own, stricter allowlist as the second lock.
- `ct` itself refuses writes for a gateway env ("`prod-ro` is read-only; writes happen in
  CI") before any request is made.
- One log line per request on stderr: method, path without query, status. Never bodies.
- Credentials are re-requested (new MFA prompt) shortly before the assumed role expires.
