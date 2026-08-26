/**
 * Registry of adoptable ChurchTools resource types.
 *
 * Each entry knows how to fetch one resource by id, derive a stable logical key,
 * snapshot the fields we manage, and render a config snippet (the TS-as-code
 * form the Phase 3 engine will consume). Paths come from the Phase 0 coverage
 * matrix (docs/api-coverage.md). Adding a type = adding an entry here.
 */

/** What a custom {@link AdoptableResource.writer} is handed to perform one write. */
export interface ResourceWriteContext {
  /** The full authenticated client — REST plus the legacy `ajax` channel. */
  client: CtWriteClient;
  /** The managed field bag to write (create: the declared fields; update: actual ∪ changes). */
  body: Record<string, unknown>;
}

/**
 * The client surface a custom writer may use. Deliberately a structural subset rather than the whole
 * {@link CtClient}, so the engine's test doubles stay small and a writer cannot reach for anything
 * the executor does not already guarantee.
 */
export interface CtWriteClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  ajax?<T = unknown>(module: string, params: Record<string, string>): Promise<T>;
  getAll?<T = unknown>(path: string, options?: { limit?: number }): Promise<{ data: T[] }>;
  get?<T = unknown>(path: string): Promise<T>;
}

export interface AdoptableResource {
  /** Collection path: `POST` here creates, unless {@link createPath} overrides the target. */
  collectionPath: string;
  /**
   * POST target for a CREATE, when it is not {@link collectionPath} (#110).
   *
   * Exists for ChurchTools' one CALLER-ASSIGNED-ID resource: a security level is created with
   * `POST /securitylevels/{id}` — the client picks the id, and CT 409s if it is taken. That is the
   * opposite of every other type here, where CT mints the id and the tool records the mapping. The
   * hook receives the create body (which for such a type carries the declared `id`) and returns the
   * path to POST to. Types whose create is a plain collection POST omit it.
   */
  createPath?: (body: Record<string, unknown>) => string;
  /**
   * Read ONE resource by id when `GET {itemPath}` does not exist (#108).
   *
   * Bereiche have no `/departments/{id}` path at all — only the collection — so the default read
   * 404s, which every caller correctly interprets as "vanished in ChurchTools". The visible symptom
   * is a plan that proposes creating the same Bereich on every run: apply creates it, the next plan
   * cannot read it back, and proposes creating it again. Caught by a live dev apply, not by any unit
   * test, because a mock happily answers whatever path it is asked for.
   *
   * Returning `null` means genuinely absent (the caller treats it as a 404).
   */
  fetchOne?: (client: CtWriteClient, id: number) => Promise<Record<string, unknown> | null>;
  /**
   * True when the resource's id is chosen by the CONFIG, not minted by ChurchTools (#110).
   *
   * For these, the id is not an opaque handle but part of the resource's meaning — security level 3
   * IS "Stufe 3", referenced by `securityLevelId` on person fields and by `cc_securitylevel` grant
   * scopes across the whole instance. Two consequences the engine has to respect:
   *  - CREATE must send the declared id (see {@link createPath}), and
   *  - CHANGING it is a RENUMBER, not a field update. CT models that as `PATCH` with `newid` +
   *    `forcereorder`, which rewrites what every existing numeric grant on that dimension means.
   *    The planner refuses it rather than emitting a wrong-shaped PATCH (see `computePlan`).
   */
  callerAssignedId?: boolean;
  /**
   * Override the WRITE path for a type whose reads are REST but whose writes are not (#108).
   *
   * Exactly one type needs this: Bereiche/departments. `GET /departments` is a normal REST catalog,
   * but no REST write verb exists for it on any probed version — the admin UI writes Bereiche through
   * the legacy `saveMasterData` endpoint instead. Rather than teach the executor about that endpoint,
   * the type supplies its own create/update, and everything else in the engine (planning, diffing,
   * state, tiers, `preventDestroy`) is unchanged.
   *
   * `create` returns the new id, because the legacy endpoint does not: it answers
   * `{"status":"success","data":null}`, so the implementation re-reads the REST catalog to find the
   * row it just wrote. Reads therefore stay REST-only, which is what #108 asked for.
   */
  writer?: {
    create(ctx: ResourceWriteContext): Promise<number>;
    update(ctx: ResourceWriteContext & { id: number }): Promise<void>;
    /**
     * `ct destroy`'s delete. Optional and separate from the two above because `ct apply` NEVER
     * deletes — a type can be fully applyable without one, and omitting it makes `ct destroy` say so
     * rather than issue a REST DELETE the endpoint does not have.
     */
    remove?(ctx: { client: CtWriteClient; id: number }): Promise<void>;
  };
  /** GET/PUT/PATCH/DELETE path for a single resource by id. */
  itemPath: (id: number) => string;
  /** Update verb: `group` is PATCH; every other type is PUT. */
  updateMethod: "PUT" | "PATCH";
  /**
   * Apply tier: lower applies first, delete runs highest first (see engine/graph.ts). Owned here so
   * a new resource type declares its ordering in the same place as its paths — `engine/graph.ts`
   * derives `TYPE_TIER` from these entries instead of maintaining a parallel (drift-prone) table.
   */
  tier: number;
  /** Stable logical key derived from the fetched resource. */
  deriveKey: (resource: Record<string, unknown>) => string;
  /** The subset of fields we manage — the desired-state baseline. */
  managedFields: (resource: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Deterministic values for fields CT *requires* at CREATE but the tool does not manage for
   * diffing (#73). Called with the already-built create body (the declared managed fields, which
   * carry `name`) and returns extra fields merged UNDER it (a declared value always wins) into the
   * POST body ONLY — never into the state snapshot. So these fields stay unmanaged: a later plan
   * neither diffs nor reverts them, and declared-fields semantics are unchanged (no state migration).
   * A field still missing after this surfaces as CT's own HTTP 400 (#71), never a silent omission.
   * Omit the hook entirely for types whose managed fields already satisfy the create contract.
   */
  createDefaults?: (body: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Extra teardown risk for this type, shown before `ct destroy` confirms — and, when set, `--force`
   * does NOT skip the typed confirmation for a run touching it (#99 review).
   *
   * Set it only where the DELETE reaches past master data into records this tool otherwise never
   * touches. `assertNotPeople` guards PATHS, and a type like `person-status` has a perfectly
   * innocent one (`/statuses/{id}`) while its deletion still mutates every person carrying that
   * status — a gap no path denylist can close.
   */
  destroyWarning?: string;
  /**
   * DSL function name `configSnippet` emits for this type. Defaults to the camelCase of
   * the type name. Set it when the natural camelCase collides with another DSL surface
   * (e.g. `group-role` → `roleDefinition`, because `groupRole` is the permission function).
   */
  dslName?: string;
}

/** Build a full spec, deriving `itemPath` from the collection path so each entry names its path once. */
function define(spec: Omit<AdoptableResource, "itemPath">): AdoptableResource {
  return { ...spec, itemPath: (id: number) => `${spec.collectionPath}/${id}` };
}

/**
 * kebab/underscore slug: "Kids Leitung" → "kids_leitung", "Zürich" → "zurich".
 * NFKD splits accented letters into base + combining mark; we drop the marks so
 * German names (ü/ö/ä/…) slug to their base letters rather than gaining a `_`.
 */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function str(resource: Record<string, unknown>, key: string): string {
  const value = resource[key];
  return typeof value === "string" ? value : "";
}

/**
 * First `max` *code points* (not UTF-16 code units) of `value` — CT's create validators cap several
 * name/shorty fields. Plain `String#slice` operates on UTF-16 code units, which can split an astral
 * character's surrogate pair at the cutoff (e.g. `("ABCDEFGHI" + "😀").slice(0, 10)` ends in a lone
 * unpaired `\uD83D`); `Array.from` iterates strings by code point, so the cut always lands on a whole
 * character and the result can never contain a dangling surrogate.
 */
function truncate(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

/**
 * `truncate(value, max)`, then padded up to `min` characters by repeating `value` (or `"x"` if
 * `value` is empty) — CT's create validators give several name/shorty-style fields *both* a maximum
 * and a minimum length, and a name shorter than `min` (e.g. a 1-char group-type name against
 * namePlural's 2-char floor) would otherwise merely truncate to itself and stay under the minimum.
 * The padding is deliberately dumb (repeat, don't pluralize) — a name this short is pathological;
 * the goal is a valid create body, not linguistics.
 */
function truncatePadded(value: string, max: number, min: number): string {
  let padded = value;
  while (Array.from(padded).length < min) {
    // (code-point count, matching truncate() — a single-astral-char name must still pad)
    padded += value.length > 0 ? value : "x";
  }
  return truncate(padded, max);
}

/** Read a field, preferring a nested `information` object but falling back to the top level. */
export function fromInformation(resource: Record<string, unknown>, key: string): unknown {
  const information = (resource.information as Record<string, unknown> | undefined) ?? {};
  return information[key] ?? resource[key];
}

/**
 * Bereich writes, through the legacy master-data endpoint (#108). Reads stay REST — including the
 * read this create performs to learn the new id, because `saveMasterData` does not return one.
 *
 * Column mapping: the config and `ct get departments` speak the REST names (`name`, `shorty`,
 * `sortKey`); the legacy table speaks `bezeichnung`, `kuerzel`, `sortkey`. Mapping here keeps that
 * detail out of the config surface, and `masterDataColumns` validates the result against the
 * instance's OWN column list, so a CT rename surfaces as a named error rather than a silent
 * partial write.
 */
const DEPARTMENT_COLUMNS: Record<string, string> = {
  name: "bezeichnung",
  shorty: "kuerzel",
  sortKey: "sortkey",
};

function departmentRow(body: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [restName, column] of Object.entries(DEPARTMENT_COLUMNS)) {
    if (body[restName] !== undefined) row[column] = body[restName];
  }
  return row;
}

/** Read the whole `/departments` collection — the only read path CT offers for Bereiche. */
async function departmentRows(client: CtWriteClient): Promise<{ id: number; name?: string }[]> {
  if (client.getAll) return (await client.getAll<{ id: number; name?: string }>("/departments")).data;
  return (await client.get?.<{ id: number; name?: string }[]>("/departments")) ?? [];
}

/**
 * `fetchOne` has no `/departments/{id}` to hit, so it filters the whole collection — and
 * `fetchActual` runs it once per managed Bereich, concurrently. Share one read across that fan-out,
 * the way the resolver caches identical catalog reads. Every write below drops the entry, so the
 * cache can never outlive the state it describes.
 */
const departmentReads = new WeakMap<object, Promise<{ id: number; name?: string }[]>>();

function cachedDepartmentRows(client: CtWriteClient): Promise<{ id: number; name?: string }[]> {
  let p = departmentReads.get(client);
  if (!p) {
    p = departmentRows(client);
    departmentReads.set(client, p);
  }
  return p;
}

/**
 * Wrap a client's `ajax` once PER CLIENT. The wrapper is what `masterdata.ts` keys its ~3 MB
 * registry cache on (a WeakMap on the object it is handed), so returning a fresh literal per call
 * would miss that cache on every single write and re-fetch the whole payload each time.
 */
const ajaxWrappers = new WeakMap<object, Required<Pick<CtWriteClient, "ajax">>>();

function requireAjax(client: CtWriteClient): Required<Pick<CtWriteClient, "ajax">> {
  if (!client.ajax) {
    throw new Error(
      "Departments are written through ChurchTools' legacy master-data endpoint, which needs the " +
        "full authenticated client (`ajax`). This client cannot reach it.",
    );
  }
  let wrapper = ajaxWrappers.get(client);
  if (!wrapper) {
    wrapper = { ajax: client.ajax.bind(client) };
    ajaxWrappers.set(client, wrapper);
  }
  return wrapper;
}

const departmentWriter: AdoptableResource["writer"] = {
  async create({ client, body }): Promise<number> {
    const { saveMasterData, DEPARTMENT_TABLE } = await import("../api/masterdata.js");
    const name = body.name;
    // `saveMasterData` answers {"status":"success","data":null} — no id — so the new row has to be
    // identified by re-reading the REST catalog. Snapshot the ids BEFORE writing and diff after:
    // matching on the name alone would be wrong the moment a Bereich of that name already exists
    // (created by hand on the target host), because the create would still have succeeded and the
    // post-write ambiguity error would leave an orphan row behind that every retry duplicates.
    const before = await departmentRows(client);
    const collision = before.filter((r) => r.name === name);
    if (collision.length > 0) {
      throw new Error(
        `A Bereich named "${String(name)}" already exists in ChurchTools (#${collision.map((r) => r.id).join(", #")}). ` +
          `Refusing to create a second one: the legacy master-data endpoint returns no id, so the new ` +
          `row could not be told apart from the existing one. Adopt it instead (\`ct adopt department ` +
          `${collision[0]!.id}\`) or rename one of the two.`,
      );
    }
    const known = new Set(before.map((r) => r.id));
    await saveMasterData(requireAjax(client), DEPARTMENT_TABLE, departmentRow(body));
    departmentReads.delete(client);
    const fresh = (await departmentRows(client)).filter((r) => !known.has(r.id));
    if (fresh.length !== 1) {
      throw new Error(
        `Created the Bereich "${String(name)}", but ${fresh.length === 0 ? "no new row appeared in" : `${fresh.length} new rows appeared in`} ` +
          `GET /departments — cannot record its id. Check ChurchTools for a stray Bereich before re-running.`,
      );
    }
    return fresh[0]!.id;
  },
  async update({ client, body, id }): Promise<void> {
    const { saveMasterData, DEPARTMENT_TABLE } = await import("../api/masterdata.js");
    // A non-empty `id` makes the same call an UPDATE of that row (verified live, eqrm-dev 2026-08-14).
    await saveMasterData(requireAjax(client), DEPARTMENT_TABLE, departmentRow(body), id);
    departmentReads.delete(client);
  },
  async remove({ client, id }): Promise<void> {
    const { deleteMasterData, DEPARTMENT_TABLE } = await import("../api/masterdata.js");
    // `deleteMasterData` is a real verb, not a silently-ignored unknown one: a made-up `delMasterData`
    // against the same endpoint answers "was not defined as Function!" (verified, eqrm-dev 2026-08-14).
    await deleteMasterData(requireAjax(client), DEPARTMENT_TABLE, id);
    departmentReads.delete(client);
  },
};

export const RESOURCES: Record<string, AdoptableResource> = {
  campus: define({
    collectionPath: "/campuses",
    updateMethod: "PUT",
    tier: 0,
    // CT's campus short name is `shorty` (1–10 chars, required on create) — verified
    // live. `shortName` is a vestigial, usually-null sibling; do not use it for writes.
    //
    // The KEY comes from `name`, like every other resource in this registry (#118). It used to
    // prefer `shorty`, which made campus the sole exception and produced keys nobody could read:
    // Idstein → `swa` (abbreviated after the region it used to be named for), Würzburg → `wu`,
    // Dietzenbach → `of` — and `{ campus: "of" }` inside a grant scope reads as a typo in the tool
    // rather than as a name. `shorty` is also less stable: it is free text an admin edits in the UI
    // to make a column fit, and every such edit silently changes what the derived key WOULD be,
    // splitting new adoptions from the ones already in state. It is still written as a managed field
    // exactly as before — this is only about the key.
    deriveKey: (r) => slug(str(r, "name") || str(r, "shorty")),
    managedFields: (r) => ({ name: r.name, shorty: r.shorty }),
  }),
  group: define({
    collectionPath: "/groups",
    updateMethod: "PATCH",
    tier: 1,
    deriveKey: (r) => slug(str(r, "name")),
    // Campus lives on the live group at `information.campusId` (same nesting as groupTypeId /
    // groupStatusId), and PATCH accepts it as a top-level `campusId` — so it is read via
    // `fromInformation` and written the same field-agnostic way the executor writes every field.
    // Numeric escape hatch only: a *logical* `campus: "key"` reference is #20's resolver, not this.
    // Normalise an unset campus to `null` (never `undefined`) so the actual side is deterministic —
    // an assign/change/clear all diff against a concrete `null`, and campus id `0` (Mainz) survives.
    managedFields: (r) => ({
      name: r.name,
      groupTypeId: fromInformation(r, "groupTypeId"),
      groupStatusId: fromInformation(r, "groupStatusId"),
      campusId: fromInformation(r, "campusId") ?? null,
    }),
  }),
  "group-type": define({
    collectionPath: "/group/grouptypes",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated }),
    // POST /group/grouptypes rejects a body carrying only name/nameTranslated: CT requires the fields
    // below (validated live on CT 3.134.1, #73, and against the OpenAPI POST schema). They are unmanaged
    // (create-only) and derived deterministically from the declared `name`. If a user declares one of
    // them the existing unknown-field warning fires (it is not in `managedFields`) — we keep them
    // create-default-only rather than growing `managedFields`, which would broaden every group-type's
    // actual-reads and adopt output and grow state on the next apply (a de-facto migration #73 forbids).
    createDefaults: (r) => {
      const name = str(r, "name");
      return {
        // required, 2–30 chars: no plural known at create → mirror name, capped, and padded up to
        // the 2-char floor (a 1-char name would otherwise truncate to itself and stay under it).
        namePlural: truncatePadded(name, 30, 2),
        // required, 1–10 chars: first ≤10 chars of the name, padded up to the 1-char floor — the
        // floor only bites if `name` itself is empty (`str` defaults a missing/non-string name to
        // "", which `truncatePadded` falls back to `"x"` for rather than emitting an empty shorty).
        shorty: truncatePadded(name, 10, 1),
        color: "default", // required enum: the theme-neutral member of CT's color palette
        permissionDepth: 1, // required int: permissions reach the group's own members only (least-privilege; the value a plain live type carries)
        isLeaderNecessary: false, // don't force a leader onto a freshly created type
        availableForNewPerson: false, // keep the type out of self-service / new-person flows by default
        sortKey: 0, // append-neutral ordering (matches a live "Dienst" row's sortKey 0)
        postsEnabled: false, // don't enable the group wall / posts feature by default
      };
    },
  }),
  "age-group": define({
    collectionPath: "/group/agegroups",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated, sortKey: r.sortKey }),
  }),
  "target-group": define({
    collectionPath: "/group/targetgroups",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated, sortKey: r.sortKey }),
  }),
  "relationship-type": define({
    collectionPath: "/person/relationshiptypes",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    // CT names the two ends degreeNameA/degreeNameB (verified live) — not degreeForward/Reverse.
    managedFields: (r) => ({
      name: r.name,
      nameTranslated: r.nameTranslated,
      degreeNameA: r.degreeNameA,
      degreeNameB: r.degreeNameB,
    }),
  }),
  /**
   * PERSON statuses (`/statuses` — "0 - First", "3 - Group Active", …), the domain of a `ct.status`
   * permission declaration (#90). Adoptable so a config that grants ON a status is self-sufficient
   * across hosts (#96): before this entry the status itself could only be created by hand on every
   * target instance, which made the whole `status` domain only half-portable — the grant was
   * declarable, the thing it hangs off was not.
   *
   * Not a people surface: a status is master data (the enumeration), never a person or a membership.
   * `assertNotPeople` still guards every write; `/statuses` does not match its denylist by design.
   *
   * The managed set is the WHOLE required PUT contract, deliberately — and this is the one managed
   * type where a minimal field set would be actively wrong. Live-probed against the instance's own
   * OpenAPI spec (eqrm prod, CT 3.135.2, 2026-08-13):
   *
   *   POST /statuses       required: name, shorty, isMember
   *   PUT  /statuses/{id}  required: name, shorty, isMember, isSearchable, sortKey, securityLevelId
   *
   * That PUT is a FULL REPLACE, and the executor sends the declared field bag as the update body —
   * so managing a subset would both 400 (missing required fields) and, if it didn't, blank the
   * fields left out. Every other managed type's PUT has no required fields at all (campus,
   * age-group, target-group, group-role, group-type — same probe), which is why they can manage a
   * narrow set; `/statuses` cannot. Hence: no `createDefaults` here. All six are declared, adopted
   * and diffed, so `ct adopt person-status <id>` emits a config that is valid for both verbs.
   * A hand-authored declaration that omits one gets CT's own HTTP 400 (#71), never a silent blank.
   */
  "person-status": define({
    collectionPath: "/statuses",
    updateMethod: "PUT",
    tier: 0,
    // The one managed type whose DELETE reaches person RECORDS (#99 review). `/statuses/{id}` is not
    // a people path, so `assertNotPeople` cannot see the risk: deleting a status makes ChurchTools
    // re-stamp every person who carries it. Drop the declaration and `ct destroy` would otherwise
    // take it out behind a plain typed confirmation — or none at all under `--force`.
    destroyWarning:
      "deleting a person status MUTATES every person carrying it (ChurchTools re-stamps their " +
      "status). `ct` never manages people, but this delete reaches them. Verify the status is " +
      "unused first (`ct get statuses`, then check the status in ChurchTools).",
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({
      name: r.name,
      shorty: r.shorty,
      isMember: r.isMember,
      isSearchable: r.isSearchable,
      sortKey: r.sortKey,
      securityLevelId: r.securityLevelId,
    }),
  }),
  /**
   * BEREICHE / DEPARTMENTS (#108) — `cdb_bereich`, the scope dimension of `churchdb:view alldata`
   * ("Personen eines Bereiches sehen"). The one managed type whose READS are REST and whose WRITES
   * are not.
   *
   * `GET /departments` is a normal catalog; no REST write verb exists for it (live-probed on eqrm
   * prod CT 3.135.2 2026-08-13 and re-probed on eqrm-dev 2026-08-14 — no POST/PUT/DELETE, and no
   * `/departments/{id}` path at all). The admin UI creates Bereiche through the legacy master-data
   * endpoint, which is what {@link writer} drives. That asymmetry is the whole of #108: without it a
   * Bereich-scoped grant only planned on hosts where somebody had already made the Bereich by hand,
   * so a config could not stand up a fresh instance — the promotion model's core assumption.
   *
   * Managed columns are the three the instance's own registry reports as writable for `cdb_bereich`
   * (`bezeichnung`, `kuerzel`, `sortkey`), surfaced under their REST names so config and `ct get
   * departments` agree: `name`, `shorty`, `sortKey`. The writer maps them back.
   */
  department: define({
    collectionPath: "/departments",
    // Never used for writes — `writer` handles those — but the executor's update path still reads it
    // for `assertNotPeople`, and `ct adopt department <id>` reads the row through `itemPath`.
    updateMethod: "PUT",
    // Tier 0: grants scope by Bereich, and permissions apply after every resource tier.
    tier: 0,
    destroyWarning:
      "deleting a Bereich reaches every person assigned to it and every grant scoped to it " +
      "(`churchdb:view alldata`). ChurchTools offers no REST delete for Bereiche at all — this goes " +
      "through the legacy master-data endpoint. Verify it is unused first (`ct get departments`).",
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, shorty: r.shorty, sortKey: r.sortKey ?? 0 }),
    // There is no `GET /departments/{id}` — filter the collection instead. Without this every plan
    // after a create would read a 404 and propose creating the same Bereich again.
    fetchOne: async (client, id) =>
      ((await cachedDepartmentRows(client)) as Record<string, unknown>[]).find((r) => r.id === id) ?? null,
    writer: departmentWriter,
  }),
  /**
   * SECURITY LEVELS (#110) — `cc_securitylevel`, the scope dimension of `churchdb:+see persons` and
   * the `securityLevelId` on every person field. The only CALLER-ASSIGNED-ID type here.
   *
   * Live-probed on eqrm-dev, CT 3.135.2, 2026-08-14 (create → rename → delete, instance restored):
   *
   *   POST   /securitylevels/{id}  body {name}                      → 200 {id, name, sortKey}; 409 if taken
   *   PATCH  /securitylevels/{id}  body {name[, newid]} ?forcereorder → 200 {id, name}
   *   DELETE /securitylevels/{id}                                    → 200
   *
   * Creating id 99 alongside 1–4 left 1–4 untouched and `sortkey` mirrored the id, so an insert does
   * NOT implicitly renumber — reordering is opt-in through `newid` + `forcereorder`, which this tool
   * deliberately does not drive (it would silently change what every numeric `scope: [1,2,3]` grant
   * means instance-wide). `id` is therefore a MANAGED field: it is part of the declaration, it is sent
   * at create, and a changed one is refused by the planner rather than PATCHed into a wrong shape.
   *
   * Managing `name` only (besides `id`) is safe here where it is not for person-status: PATCH is a
   * partial update, not a full replace, so unmanaged siblings are left alone.
   */
  "security-level": define({
    collectionPath: "/securitylevels",
    // Caller-assigned: POST goes to the DECLARED id, not the collection. CT 409s if it is taken.
    createPath: (body) => `/securitylevels/${String(body.id)}`,
    callerAssignedId: true,
    updateMethod: "PATCH",
    // Tier 0: person statuses carry a `securityLevelId`, and grants scope by one, so levels must
    // exist before anything that references them.
    tier: 0,
    destroyWarning:
      "deleting a security level reaches every person field and grant scoped to it — the level id " +
      "is referenced instance-wide (person-field `securityLevelId`, `cc_securitylevel` grant " +
      "scopes). Verify it is unused first (`ct get security-levels`, `ct get data-fields`).",
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ id: r.id, name: r.name }),
  }),
  /**
   * COMMENT VIEWERS (#151) — `cdb_comment_viewer`, the scope dimension of `churchdb:view comments`
   * ("Kommentare-Viewer"). Managed so a `view comments` grant means the same thing on every host.
   *
   * It was catalog-only until now, and that is exactly what made the dimension unportable: a config
   * granting `churchdb:view comments` had to write a raw, host-specific `dataId`, and the same
   * number names a different viewer (or nothing) on another instance. Read on two hosts of the same
   * deployment 2026-08-24: three of prod's six ids do not exist on dev at all, and the two that do
   * exist on both name different categories on each. Nothing detected the
   * mismatch — a plan compares the declared id against the live id, and they match; the id is simply
   * meaningless on the target host. Switching to a name ref did not fix it either: dev lacks the
   * NAMES too, so the ref failed to resolve rather than resolving wrongly. Only a declarable
   * resource makes the names exist on both hosts, which is what makes a name ref portable.
   *
   * `/person/commentviewers` is conventional REST, so this needs none of the machinery the other two
   * awkward master-data types did: CT mints the id (unlike `security-level`) and writes are REST
   * (unlike `department`). FULLY live-probed on eqrm-dev, CT 3.135.2 (2026-08-26) — one throwaway
   * row created, read, updated and deleted, instance left as found:
   *
   *   GET    /person/commentviewers          → flat `[{id, name, nameTranslated, sortKey}]`
   *   POST   /person/commentviewers          → 200, CT MINTS the id (body `{name, sortKey}`)
   *   GET    /person/commentviewers/{id}     → 200; an absent id → clean 404 `error.notfound`
   *   PUT    /person/commentviewers/{id}     → 200
   *   DELETE /person/commentviewers/{id}     → 200
   *
   * The minted id is a bare auto-increment that does NOT reuse deleted rows and moves faster than the
   * visible row count (three consecutive probe creates on a 3-row instance minted 5, 8, 11), which is
   * the concrete reason a comment viewer can never be `callerAssignedId`: nothing can predict it.
   *
   * `name` and `sortKey` are the whole editable surface. NB the row carries a fourth column the #109
   * list does not mention, `nameTranslated` — but CT DERIVES it from `name` (the probe's PUT sent only
   * `{name, sortKey}` and `nameTranslated` followed `name`), so it is not an unmanaged sibling a PUT
   * could blank, and the managed set is complete.
   */
  "comment-viewer": define({
    collectionPath: "/person/commentviewers",
    updateMethod: "PUT",
    // Tier 0: grants scope by comment viewer, and permissions apply after every resource tier.
    tier: 0,
    destroyWarning:
      "deleting a comment viewer reaches every person comment restricted to it and every grant " +
      "scoped to it (`churchdb:view comments`) — the viewer id is referenced instance-wide. Verify " +
      "it is unused first (`ct get comment-viewers`, `ct report permissions`).",
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, sortKey: r.sortKey }),
    // `sortKey` is managed but not mandatory in a hand-authored declaration; CT's create validator
    // for the 3-column master-data tables rejects a missing integer column, so supply a neutral one
    // (a declared value still wins — createDefaults merges UNDER the body).
    createDefaults: () => ({ sortKey: 0 }),
    // No `fetchOne`: `GET /person/commentviewers/{id}` exists and behaves (probed 2026-08-26, see
    // above), so the DEFAULT item read is correct here. This type briefly carried a collection-
    // filtering hook while that path was unverified — guessing it would have risked #108's failure
    // mode, where a 404 reads as "vanished in ChurchTools" and every apply duplicates the viewer.
    // The probe retired the guess: a present id returns the row, an absent one returns a clean 404,
    // which is exactly the distinction the default read needs. It also drops one full collection
    // read per managed viewer per plan/apply/destroy — `fetchActual` fans out concurrently, so the
    // hook cost N round-trips against a rate-limited API where the default costs N cheap item reads.
  }),
  "group-role": define({
    collectionPath: "/group/roles",
    updateMethod: "PUT",
    tier: 3,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({
      name: r.name,
      nameTranslated: r.nameTranslated,
      groupTypeId: r.groupTypeId,
      // `type` is `leader` | `participant` — a real semantic choice (does holding this role make you
      // a leader of the group?), so it is declarable rather than defaulted-and-forgotten (#121). It
      // only diffs when the config declares it: `diffFields` walks the DESIRED keys.
      type: r.type,
    }),
    // Fields CT REQUIRES at create but the tool does not otherwise manage (#73/#121). The old comment
    // here claimed `type`/`isLeader`/`sortKey` were "all optional/nullable — no default needed", which
    // is what made this look supported. VERIFIED LIVE on eqrm-dev, CT 3.135.2 (2026-08-17): POSTing
    // the old body (`{name, nameTranslated, groupTypeId, shorty}`) is rejected with FOUR validation
    // errors, not three —
    //
    //   sortKey    "Bitte eine ganze Zahl eingeben (ohne Punkt und Komma)."   validation.integer
    //   type       "Die Eingabe sollte eine der folgenden Werte sein: leader, participant"
    //   isDefault  "Eingabe muss TRUE oder FALSE sein."                       validation.boolean
    //   isHidden   "Eingabe muss TRUE oder FALSE sein."                       validation.boolean
    //
    // so a declared `roleDefinition` missing from the target host could not be created at all — and it
    // failed in `apply`, on the host the pipeline writes to, after `plan` had been green. Adding all
    // four succeeds (probe created and deleted role #288, instance left as found).
    //
    // `shorty` is 1–10 chars, non-nullable, derived from the declared `name`; padded up to the 1-char
    // floor for the same empty-name edge case as group-type's shorty above.
    // `type` defaults to `participant`: the conservative half of the choice, since `leader` confers
    // group leadership. A config that wants the other one declares `type: "leader"` and wins here
    // (createDefaults merges UNDER the declared body).
    // `sortKey: 0` matches every stock role on the probed instance (all 87 carry `sortKey: 0`), so it
    // is a neutral default rather than a position claim.
    //
    // `isLeader` is deliberately NOT sent: CT DERIVES it from `type`. The probe confirmed a role
    // created with `type: "leader"` reads back `isLeader: true` without it ever being in the body, so
    // sending it would be a second, redundant source of truth for the same fact.
    createDefaults: (r) => ({
      shorty: truncatePadded(str(r, "name"), 10, 1),
      type: "participant",
      isDefault: false,
      isHidden: false,
      sortKey: 0,
    }),
    // `groupRole` is taken by the permissions DSL (`ct.groupRole` = definePermission("group_role")),
    // so the master-data role resource declares under a distinct name.
    dslName: "roleDefinition",
  }),
};

export function resourceType(type: string): AdoptableResource {
  const entry = RESOURCES[type];
  if (!entry) {
    const known = Object.keys(RESOURCES).join(", ");
    throw new Error(`Unknown resource type "${type}". Adoptable types: ${known}.`);
  }
  return entry;
}

/**
 * The field names a declaration of `type` may manage — derived from the registry's own
 * `managedFields`, not hand-copied, so this can never drift from what `adopt`/`plan`/`apply`
 * actually read and write. `managedFields({})` still returns every key it would on a real
 * resource: each key is written as an object-literal property (`{ name: r.name, ... }`), so it
 * is present with value `undefined` even when the source object is empty — JS object literals
 * always create the property, independent of the expression's runtime value.
 */
export function knownFields(type: string): Set<string> {
  return new Set(Object.keys(resourceType(type).managedFields({})));
}

/** True when `type`'s id is chosen by the config rather than minted by CT (#110: security levels). */
export function isCallerAssignedId(type: string): boolean {
  return RESOURCES[type]?.callerAssignedId === true;
}

/** Camel-case a hyphenated type name: `group-type` → `groupType`. */
function camelCase(type: string): string {
  return type.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The conventional ruleset-file path for a dynamic group's `dynamic: true` sugar (#52): the same
 * `rulesets/<key>.json` layout `ct adopt group --with-dynamic` writes to. Owned here (a low-level
 * module) so both the config-DSL desugarer (context.ts) and the adopt emitter can share it without
 * a registry↔context import cycle.
 */
export function conventionalRulesetRef(key: string): string {
  return `./rulesets/${key}.json`;
}

/** Prettier's `printWidth` (see .prettierrc.json) — the emitter mirrors it for array wrapping. */
const PRINT_WIDTH = 110;

/** Options for {@link configSnippet}. `todos` names fields to flag with a trailing `// TODO` comment. */
export interface SnippetOptions {
  /** Field keys that could not be reverse-resolved to logical sugar — annotated inline (#52 item A). */
  todos?: Set<string>;
}

/**
 * Render a config entry as an idiomatic, prettier-compatible TS-as-code call (#52 item A):
 * multi-line, 2-space indent, trailing commas, one field per line. The function name comes from the
 * registry entry's `dslName` (default: camelCase of the type), so the emitted snippet always names an
 * actual `ConfigContext` function — never a colliding one. `fields` should already be reverse-sugared
 * (numeric ids → logical `campus`/`groupType`/`status` keys); anything left numeric that the caller
 * couldn't resolve is passed in `opts.todos` to earn a `// TODO: no logical match` marker. A `dynamic`
 * field is collapsed to its shortest sugar form (`true` / `"<path>"`) when it matches the convention.
 */
export function configSnippet(
  type: string,
  key: string,
  fields: Record<string, unknown>,
  opts: SnippetOptions = {},
): string {
  const fn = RESOURCES[type]?.dslName ?? camelCase(type);
  const prepared: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    prepared[k] = k === "dynamic" ? sugarDynamicValue(key, v) : v;
  }
  return `${fn}(${renderObject({ key, ...prepared }, "", opts.todos)});`;
}

/**
 * Collapse an emitted `dynamic` value to its shortest DSL sugar (#52 item B round-trip): an
 * `active` status whose ruleset is exactly `{ ref }` becomes `true` (when the ref matches the
 * `./rulesets/<key>.json` convention) or the bare `"<path>"` string. Any other shape (non-active
 * status, an inline ruleset object) is emitted verbatim as the explicit object.
 */
function sugarDynamicValue(key: string, dynamic: unknown): unknown {
  if (dynamic === null || typeof dynamic !== "object") return dynamic;
  const d = dynamic as Record<string, unknown>;
  const ruleset = d.ruleset;
  if (d.status !== "active" || ruleset === null || typeof ruleset !== "object") return dynamic;
  const rs = ruleset as Record<string, unknown>;
  if (typeof rs.ref !== "string" || Object.keys(rs).length !== 1) return dynamic;
  return rs.ref === conventionalRulesetRef(key) ? true : rs.ref;
}

/**
 * Render a plain object as multi-line TS. null/undefined-valued fields are OMITTED, not emitted:
 * pasting `campusId: null` would actively MANAGE "no campus" (planning a later UI-assigned campus
 * back to null), whereas omission leaves the field unmanaged — the safer default for a freshly
 * adopted resource. `todos` (top-level only) appends a `// TODO` marker after the trailing comma.
 */
function renderObject(obj: Record<string, unknown>, indent: string, todos?: Set<string>): string {
  const inner = `${indent}  `;
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "{}";
  const lines = entries.map(([k, v]) => {
    const keyStr = isIdentifier(k) ? k : JSON.stringify(k);
    const todo = todos?.has(k) ? " // TODO: no logical match" : "";
    return `${inner}${keyStr}: ${renderValue(v, inner)},${todo}`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

/** Render any JSON value as prettier-style TS, indenting nested objects/arrays under `indent`. */
function renderValue(value: unknown, indent: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // Match prettier: a short all-primitive array stays on one line; anything longer or with a
    // nested object/array breaks one element per line. (Adopt output never actually nests arrays —
    // rulesets are emitted as a `{ ref }` — so this only keeps the emitter faithful in general.)
    const allPrimitive = value.every((v) => v === null || typeof v !== "object");
    const inline = `[${value.map((v) => renderValue(v, indent)).join(", ")}]`;
    if (allPrimitive && indent.length + inline.length <= PRINT_WIDTH) return inline;
    const inner = `${indent}  `;
    const items = value.map((v) => `${inner}${renderValue(v, inner)},`).join("\n");
    return `[\n${items}\n${indent}]`;
  }
  if (typeof value === "object") return renderObject(value as Record<string, unknown>, indent);
  return JSON.stringify(value);
}

function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}
