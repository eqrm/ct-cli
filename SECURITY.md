# Security policy

## Reporting a vulnerability

Please report security issues through GitHub's
[private vulnerability reporting](https://github.com/eqrm/ct-cli/security/advisories/new)
rather than a public issue. Expect an initial response within a week.

## What this tool touches

`ct` authenticates to a ChurchTools instance with a **personal login token** that carries
your own permissions, and it performs writes (`ct apply`, `ct destroy`). When assessing
impact, the things worth knowing:

- **Tokens are never written to the repo.** They live in the **macOS Keychain**
  (`ct auth login`, keyed per host) or in `CT_LOGINTOKEN` for CI. There is no keychain
  backend on Linux or Windows — those platforms must use `CT_LOGINTOKEN`. `ct.envs.json`
  stores only the _name_ of a token env var, never a value, which is why it is safe to
  commit.
- **The session is cached, and treated as a second secret.** Since #145, the session cookie
  and CSRF token a login yields are kept per host so a one-shot CLI does not re-run the
  login handshake on every command (which trips ChurchTools' login rate limit). A live
  session cookie is as powerful as the token, so it is stored the same way — in the
  **macOS Keychain**, under a separate `session:<host>` entry, never in a file — and
  therefore not at all on Linux/Windows, which keep handshaking per invocation. It is
  bound to the host it was captured against and to a hash of the token that bought it,
  never logged or printed, and removed by `ct auth logout` along with the token.
- **Storing a token exposes it briefly to `ps`.** `ct auth login` shells out to
  `security add-generic-password -w <token>`, so the value sits in that process's argv for
  the duration of the call. On a shared machine, assume another local user could observe
  it at that moment.
- **People are never _written_.** Persons and memberships are out of scope by design. The
  load-bearing control is the resource registry: writes can only target the structural
  resource kinds it defines, and there is no person kind. `assertNotPeople` sits on top of
  every write path as a belt-and-braces second check. Reads are not guarded:
  `ct get raw /persons` returns person records, because `ct get raw` is a deliberate
  general-purpose API passthrough. The guarantee is that `ct` never creates, edits or
  deletes people — not that it cannot display them.
- **Writes are opt-in and ordered.** `plan` is the default; `apply` needs explicit
  confirmation, protected environments additionally require the env name to be typed (or
  `--confirm-env`), and deletions never happen implicitly.
- **Grants are real permissions.** A config that declares permission grants can widen
  access on the target instance. Review a `plan` before applying it, the same way you
  would a Terraform plan.

## Scope

Vulnerabilities in this CLI are in scope. Vulnerabilities in ChurchTools itself are not —
report those to [ChurchTools](https://church.tools) directly.
