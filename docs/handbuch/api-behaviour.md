---
title: API behaviour and quirks
sources: []
sources_exempt_reason: "Observed ChurchTools behaviour, not code in this repo. Each entry names how and when it was established; there is no source file to hash."
reviewed: 2026-10-27
---

# ChurchTools API behaviour and quirks

What ChurchTools does that its API documentation does not say, collected from
applications that call it (a web app that writes group memberships on behalf of
signed-in people, and background jobs under a machine login). Entries marked
_probed_ were reproduced against a development instance on the given date;
entries marked _observed_ come from a production incident or a client's logs and
were not re-run. ChurchTools changes behaviour without a changelog entry, so
treat a version number here as "seen on", not "fixed in".

## Session cookie name

ChurchTools Web v3.136.0 (2026-08-31) renamed the session cookie from
`ChurchTools_ct_<sub>` to `ChurchToolsV2_ct_<sub>` (`<sub>` is the instance's
subdomain: `acme.church.tools` gives `ChurchToolsV2_ct_acme`), with no changelog
entry and no transition period. _Observed._

The rename arrives as three `Set-Cookie` headers: the legacy name is set and then
cleared in the same response. A cookie jar therefore keeps only the V2 cookie,
while ChurchTools keeps answering `200` with the real person. Symptom of a client
that still looks for the old name: a valid login token, an HTTP 200, and no
session. Read the raw `Set-Cookie` headers before suspecting the token.

## Login tokens and sessions

- `GET /whoami?login_token=<token>` exchanges a login token for a session cookie.
  `GET /csrftoken` on that cookie then returns the CSRF token for writes.
- The `Authorization: Login <token>` header does not substitute for this: for a
  per-user token (`POST /persons/{id}/logintoken`, or _My settings_ in the web UI)
  ChurchTools sets a cookie but answers `data: null` on `/csrftoken`, so such a
  session cannot write. _Observed._
- A `401` on `/whoami` means the session cookie expired or was never valid; log in
  again.
- Whether ChurchTools invalidates a cookie derived from a token once the token is
  deleted is not known. A client that caches derived sessions should treat the
  cache lifetime as the worst case between deleting a token and it losing access.

## OAuth clients (login with ChurchTools)

A web app can sign people in through ChurchTools as an OAuth 2 client
(authorization code with PKCE, `scope=api`); ChurchTools keeps the credentials
and the second factor. Clients are created under _System settings > OAuth_. _Observed
on 3.135 to 3.137._

- **One redirect URI per client.** Local, staging and production each need their
  own client. A callback that is not byte-identical to the registered URI is
  answered with `invalid_redirect_uri`.
- **The client must be confidential.** A public client works until the first
  refresh: on 3.135.0 the refresh grant answers `401 invalid_client`, so the login
  dies after one hour.
- **The client secret depends on the version.** Up to 3.136 ChurchTools issues no
  secret for a confidential client and identifies it by its identifier alone. From
  3.137 it generates one when the client is created and shows it **once** (the API
  field is `OAuthClientCreated.clientSecret`, "only returned when the client is
  created"). The token endpoint then requires it; without it ChurchTools answers
  `400 invalid_request` with the hint to check the `client_secret` parameter. A
  lost secret cannot be read again; create a new client.
- The authorization, token and profile URLs are derived from the API host. A
  client needs no configuration for them.
- A token obtained without `scope=api` is answered with `403 insufficient_scope`
  on API calls.

## Error responses

- Errors carry a `messageKey` and, when ChurchTools could translate it, a
  `translatedMessage`. Show the second one to people and fall back to the key.
- A `200` is not always a result. During maintenance, or when a session is gone,
  ChurchTools can answer `200` with an HTML page. A client that reads
  `['data'] ?? []` on that body concludes "no rows". Check that the body is JSON
  and carries a `data` key before treating it as an empty list.
- Under rate limiting ChurchTools can commit **partial data on a `200`**. A group
  list or membership list that is shorter than it should be is indistinguishable
  from a correct short one. A client that writes decisions from such a list (for
  example "this person left every group") should treat an empty or truncated list
  as unreadable.
- Responses are filtered by the caller's visibility. A machine identity sees only
  the groups it has visibility on; the same request under another identity can
  return more. Cache by identity, not by URL.
- A person lookup that returns nothing is not proof the person is gone: `404` says
  so, but a `429` or `502` on a write burst can arrive with an empty body that
  parses to the same "nothing". Only a positively identified `404` settles it.

## Group memberships: reading

- `GET /persons/{id}/groups` can include memberships that are already ended and
  waiting for removal when called with `show_to_delete_memberships=true`. That is
  right for a display (a child whose membership is pending removal still checks in)
  and wrong for any decision that derives rights from membership. Pass `false` for
  the latter.
- Archived persons: reading their membership answers `404`, yet a `PUT` that tries
  to add them answers `409 member.add.already-in-group`. A reconciler that diffs a
  member list against a desired set will propose them again forever unless it
  recognises the archived person. _Probed 2026-10-19._

## Group memberships: writing

_Probed on a development instance, 2026-09-23 and 2026-09-30._

- `PATCH /groups/{g}/members/{p}` only updates. For somebody who is not a member it
  answers `404 DoctrineGroupMember ... not found`. A `404` on a PATCH therefore
  does not mean the person is gone.
- `PUT` creates the membership, but on an existing member it **clears the
  comment** when the body leaves it out. Role and start date survive. Neither verb
  is safe on its own: read the membership first, `PUT` a non-member, and when
  updating an existing one send the current comment along.
- ChurchTools rejects `""` for **every choice field**: `400 validation.subset` on
  a multiselect, `400 validation.in` on a select. A rejected `PUT` writes nothing,
  not even the membership. Empty is `null` (clears either type) or `[]` (multiselect
  only; a select rejects it).

## Select options of member fields

A group member field of type `select`, `radioselect` or `multiselect` has options,
and **ChurchTools assigns each option an integer id of its own**. _Observed._

- A label in `options[].id` answers `400 validation.integer`; an id ChurchTools
  never handed out answers `500 "Unknown option id for this field."`.
- Creating a field therefore sends option **names only**. Updating echoes existing
  options back under ChurchTools' ids and sends a new option with no id. A `PUT`
  replaces the whole option set, so existing options must be sent again even when
  only appending.
- What a membership stores for the field is the **option id**, not the label.
  Rendering one means translating id to label through the field definition. Until
  July 2026 ChurchTools derived the id from the option name instead, so data
  written before then can hold labels.
- A member field's name is 2 to 100 characters (counted in characters,
  `validation.length`) and unique per group. Its `note` takes up to 1024. Put a
  long question in the note and a shortened name in the name.

See [Group member fields](group-member-fields.md) for how `ct` declares them.
