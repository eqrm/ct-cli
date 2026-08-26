/**
 * `ct adopt group` — bulk/filtered group adoption + `--with-dynamic` ruleset capture (#51).
 *
 * A dedicated subcommand (mirroring `adopt-grants.ts`'s pattern) rather than an extension of the
 * generic `ct adopt <type> <id>` action: bulk selection (`--type`, `--children-of`) and dynamic
 * ruleset capture (`--with-dynamic`) are group-specific concepts with no analog for the other
 * adoptable types. Commander matches this named subcommand before falling through to the base
 * action, so every `ct adopt group ...` invocation — a single id, a list of ids, or a filter —
 * routes here (the base action never sees `type === "group"`).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { CtApiError, type CtClient } from "../api/ctClient.js";
import { resolveConfig } from "../config.js";
import { prepareEnv } from "../env/context.js";
import { normalizeRuleset } from "../engine/dynamic.js";
import {
  groupScopedRows,
  localKeyOf,
  MEMBER_FIELD_PROPS,
  memberFieldId,
  memberFieldStateKey,
  memberFieldsReadPath,
} from "../engine/member-fields.js";
import type { DynamicStatus } from "../engine/types.js";
import { RESOURCES, configSnippet, fromInformation, slug } from "../resources/registry.js";
import { ReverseResolver, type RoleCatalogEntry } from "../resolve/reverse.js";
import type { RefKind } from "../resolve/refs.js";
import { formatPortablizeWarnings, portablizeRuleset, scanUnportablized } from "../config/query-refs.js";
import { chooseAdoptKey, loadState, saveState, upsert, type State } from "../state/state.js";
import { success, info, warn, out, formatError } from "../ui.js";

interface AdoptGroupOptions {
  key?: string;
  state?: string;
  env?: string;
  dryRun?: boolean;
  type?: string;
  childrenOf?: string;
  withDynamic?: boolean;
  /** Opt in to capturing the group's group-scoped member-field definitions (#135). Never the default. */
  withMemberFields?: boolean;
  /** Opt in to changing an already-managed group's logical key (#123). Never the default. */
  rekey?: boolean;
  /** Commander's negatable `--no-portable-rulesets`: true unless the flag was passed (#101). */
  portableRulesets?: boolean;
  strictRulesets?: boolean;
}

const GROUP_SPEC = RESOURCES.group!;

interface ResolvedAdoption {
  id: number;
  key: string;
  fields: Record<string, unknown>;
  snippet: string;
}

interface MemberFieldsCapture {
  /** Portable declarations for config output; deliberately contain no ChurchTools ids. */
  declarations: Array<Record<string, unknown>>;
  /** Instance-bound identity map stored only on the owning group's state entry. */
  ids: Record<string, number>;
}

function isNonNegativeInt(raw: string): boolean {
  return /^\d+$/.test(raw.trim());
}

/** Resolve `--type`'s numeric group-type id or logical key against the live `/group/grouptypes` catalog. */
async function resolveGroupTypeId(raw: string, client: Pick<CtClient, "get">): Promise<number> {
  const trimmed = raw.trim();
  if (isNonNegativeInt(trimmed)) return Number.parseInt(trimmed, 10);
  const rows = await client.get<Array<Record<string, unknown>>>("/group/grouptypes");
  const list = Array.isArray(rows) ? rows : [];
  const bySlug = list.filter((r) => typeof r.name === "string" && slug(r.name as string) === trimmed);
  const candidates = bySlug.length > 0 ? bySlug : list.filter((r) => r.name === trimmed);
  if (candidates.length === 0) {
    throw new Error(
      `--type "${raw}": no group type matches (checked /group/grouptypes by slug and exact name).`,
    );
  }
  if (candidates.length > 1) {
    const listed = candidates.map((c) => `${JSON.stringify(c.name)} (#${String(c.id)})`).join(", ");
    throw new Error(`--type "${raw}" is ambiguous: ${candidates.length} group types match — ${listed}.`);
  }
  return Number(candidates[0]!.id);
}

/** Resolve `--children-of`'s numeric id, adopted-state logical key, or live group name to a group id. */
async function resolveGroupId(
  raw: string,
  client: Pick<CtClient, "get" | "getAll">,
  state: State,
): Promise<number> {
  const trimmed = raw.trim();
  if (isNonNegativeInt(trimmed)) return Number.parseInt(trimmed, 10);
  const managed = state.resources[trimmed];
  if (managed && managed.type === "group") return managed.id;
  const page = await client.getAll<Record<string, unknown>>("/groups");
  const rows = page.data;
  const bySlug = rows.filter((r) => typeof r.name === "string" && slug(r.name as string) === trimmed);
  const candidates = bySlug.length > 0 ? bySlug : rows.filter((r) => r.name === trimmed);
  if (candidates.length === 0) {
    throw new Error(
      `--children-of "${raw}": not adopted (no state entry) and no live group matches ` +
        `(checked /groups by slug and exact name).`,
    );
  }
  if (candidates.length > 1) {
    const listed = candidates.map((c) => `${JSON.stringify(c.name)} (#${String(c.id)})`).join(", ");
    throw new Error(
      `--children-of "${raw}" is ambiguous: ${candidates.length} live groups match — ${listed}.`,
    );
  }
  return Number(candidates[0]!.id);
}

/**
 * Resolve one `/groups/{id}/children` row to the group id it points at.
 *
 * CT answers this endpoint with either plain group rows (`{ id }`) or domain resources
 * (`{ domainType: "group", domainIdentifier, apiUrl }`). For a domain resource the authoritative
 * group id is `domainIdentifier` — a sibling `id`, if CT ever emits one, is the hierarchy edge's
 * own id — so `domainIdentifier` is read first and `id` only backs it up. `apiUrl` is the last
 * resort. `parentId` is threaded in purely so the error names the group that actually failed:
 * `--children-of` walks whole subtrees, and "some group somewhere" is not actionable.
 */
function childId(raw: unknown, parentId: number): number {
  let candidate: unknown = raw;
  if (raw !== null && typeof raw === "object") {
    const child = raw as Record<string, unknown>;
    candidate = child.domainIdentifier ?? child.id;
    if (candidate == null && typeof child.apiUrl === "string") {
      candidate = /\/groups\/(\d+)(?:[/?#]|$)/.exec(child.apiUrl)?.[1];
    }
  }

  const id =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && /^\d+$/.test(candidate.trim())
        ? Number.parseInt(candidate, 10)
        : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 0) {
    const shape =
      raw !== null && typeof raw === "object"
        ? `{ ${Object.keys(raw as Record<string, unknown>).join(", ")} }`
        : JSON.stringify(raw);
    throw new Error(
      `GET /groups/${parentId}/children returned a child without a usable id (${shape}); ` +
        `expected a number or an object with id, domainIdentifier, or apiUrl.`,
    );
  }
  return id;
}

/**
 * Recursively collect a group's full hierarchy subtree via `/groups/{id}/children`, in
 * parent-before-child (pre-order) sequence, excluding the root itself. Guards against a cyclic
 * hierarchy (a live-API bug, not a valid DAG state) with a `visited` set — never re-descends into
 * an id already seen, so a back-reference to an ancestor cannot loop forever.
 *
 * `/groups/{id}/children` is a paginated list endpoint, so it is read with `getAll`, never a plain
 * `get` (#101): a plain GET returns only CT's default first page, which would silently drop the
 * tail of a wide Bereich and every subtree hanging off it. `getAll` also absorbs CT's inconsistent
 * page shapes (bare array vs. `{ data: [...] }`) and an empty 204 body, which for a leaf group is
 * simply "no children".
 */
async function collectSubtreeIds(rootId: number, client: Pick<CtClient, "getAll">): Promise<number[]> {
  const visited = new Set<number>([rootId]);
  const order: number[] = [];

  async function walk(id: number): Promise<void> {
    const page = await client.getAll<unknown>(`/groups/${id}/children`);
    for (const c of page.data) {
      const cid = childId(c, id);
      if (visited.has(cid)) continue;
      visited.add(cid);
      order.push(cid);
      await walk(cid);
    }
  }

  await walk(rootId);
  return order;
}

/** List every group id whose live `groupTypeId` (top-level or under `information`) matches. */
async function collectByGroupType(groupTypeId: number, client: Pick<CtClient, "getAll">): Promise<number[]> {
  const page = await client.getAll<Record<string, unknown>>("/groups");
  return page.data
    .filter((row) => Number(fromInformation(row, "groupTypeId")) === groupTypeId)
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id))
    .sort((a, b) => a - b);
}

interface DynamicCapture {
  status: DynamicStatus;
  normalizedRuleset: Record<string, unknown>;
}

/**
 * Capture a group's group-scoped member-field DEFINITIONS as portable declarations (#135).
 *
 * Emits `{ key, ...managed properties }` per field and **never a ChurchTools id** — the field's
 * identity in config is the group key plus its local key (`ojbp_2026_27_praktikum_1::wahl`), so the
 * same blueprint applied to another group, or another host, mints its own fields rather than
 * resolving against this host's numbering. The local key comes from CT's own `referenceName`
 * (slugged), falling back to the slugged name for a field created in the ChurchTools UI.
 *
 * Opt-in only (`--with-member-fields`) — and that opt-in is TRANSITIONAL, not a statement that
 * member fields are optional: they are a category-2 owned structural child, so the flip to
 * default-on is a follow-up governed by the promotion policy in docs/adoption-contract.md (the flag
 * survives as a no-op, and `--no-member-fields` ships in the same release as the flip).
 */
async function captureMemberFields(
  id: number,
  client: Pick<CtClient, "get">,
): Promise<MemberFieldsCapture | undefined> {
  let raw: unknown;
  try {
    raw = await client.get(memberFieldsReadPath(id));
  } catch (err) {
    // A group whose member fields cannot be read is not a reason to abort a bulk adoption of a whole
    // subtree — say so and adopt the group without them. That holds for EVERY failure, not just the
    // 404: a 403 on one group the token may not read the fields of, or a transient 429, would
    // otherwise abort `--children-of` partway with the earlier groups already written to state.
    // Silence is the one thing that is not allowed here, because "no member fields" and "could not
    // read them" produce the same config.
    if (!(err instanceof CtApiError && err.status === 404)) {
      warn(
        `group #${id}: member fields could not be read (${formatError(err)}) — adopted WITHOUT them. ` +
          `Re-run \`ct adopt group ${id} --with-member-fields\` once the read succeeds.`,
      );
    }
    return undefined;
  }
  const rows = groupScopedRows(raw);
  const declarations: Array<Record<string, unknown>> = [];
  const ids: Record<string, number> = {};
  for (const row of rows) {
    const localKey = localKeyOf(row);
    const canonical = memberFieldStateKey(localKey);
    const fieldId = memberFieldId(row);
    if (!canonical) {
      throw new Error(`group #${id}: a group-scoped member field has neither referenceName nor name.`);
    }
    if (fieldId === undefined) {
      throw new Error(
        `group #${id} member field "${localKey}": the live response contains no numeric field id.`,
      );
    }
    if (ids[canonical] !== undefined) {
      throw new Error(
        `group #${id}: multiple group-scoped member fields resolve to the local key "${canonical}"; ` +
          `rename one in ChurchTools before adopting them.`,
      );
    }
    ids[canonical] = fieldId;
    const declaration: Record<string, unknown> = { key: localKey };
    for (const prop of MEMBER_FIELD_PROPS) {
      if (row[prop] !== undefined) declaration[prop] = row[prop];
    }
    declarations.push(declaration);
  }
  return { declarations, ids };
}

/** Fetch + normalize a group's ruleset and status. `undefined` (never throws) if the group isn't dynamic. */
async function captureDynamic(
  id: number,
  client: Pick<CtClient, "get">,
): Promise<DynamicCapture | undefined> {
  let raw: unknown;
  try {
    raw = await client.get(`/dynamicgroups/${id}/ruleset`);
  } catch (err) {
    if (err instanceof CtApiError && err.status === 404) return undefined; // not a dynamic group — skip silently
    throw err;
  }
  const normalizedRuleset = normalizeRuleset(raw);
  const statusRes = await client.get<{ dynamicGroupStatus?: string }>(`/dynamicgroups/${id}/status`);
  const status = (statusRes?.dynamicGroupStatus ?? "none") as DynamicStatus;
  return { status, normalizedRuleset };
}

export function adoptGroupCommand(): Command {
  return new Command("group")
    .description(
      "Adopt one or more groups: `ct adopt group <id...>`, or a filtered bulk form via " +
        "--type / --children-of. See --with-dynamic to also capture a dynamic group's ruleset.",
    )
    .argument("[ids...]", "one or more ChurchTools group ids")
    .option("-k, --key <key>", "logical key (only valid when exactly one group is resolved)")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option(
      "--rekey",
      "let a re-adoption change an already-managed group's logical key to the derived one (#123)",
    )
    .option("--dry-run", "preview the config entries and state changes without writing")
    .option("--type <groupTypeIdOrKey>", "adopt every group of this group type (numeric id or logical key)")
    .option(
      "--children-of <idOrKey>",
      "adopt a group's full hierarchy subtree (recursive; numeric id, adopted-state key, or live name)",
    )
    .option(
      "--with-dynamic",
      "also capture each dynamic group's ruleset to rulesets/<key>.json and emit the dynamic: block",
    )
    .option(
      "--with-member-fields",
      "also capture each group's group-scoped member-field definitions and emit the memberFields: " +
        "block (portable: no ChurchTools field ids are ever emitted). TRANSITIONAL: member fields " +
        "are an owned part of a group, so this becomes the default in a later release (with a " +
        "--no-member-fields escape hatch, and this flag kept working as a no-op) — see " +
        "docs/adoption-contract.md",
    )
    .option(
      "--portable-rulesets",
      "(deprecated — this is the default since #101) rewrite managed entity ids into portable logical refs",
    )
    .option(
      "--no-portable-rulesets",
      "capture rulesets verbatim: keep this host's numeric entity ids instead of rewriting the managed " +
        "ones into portable logical ref markers (#76/#101 — portablization is the default)",
    )
    .option(
      "--strict-rulesets",
      "refuse to write a ruleset that still contains an unportablized (host-specific) id, instead of " +
        "writing it with a warning (#101)",
    )
    .action(async (ids: string[], _localOpts: AdoptGroupOptions, command: Command) => {
      // `adopt` (the parent) also declares `-k/--key`, `-s/--state`, `-e/--env`, and `--dry-run` —
      // for its own `<type> <id>` action. Commander does not merge same-named options declared on
      // both a parent and a subcommand into either level's plain `.opts()` (each stays empty for
      // that flag); only `optsWithGlobals()` walks the whole command chain and merges correctly.
      // Read from there rather than the local `opts` parameter, so `ct adopt group ... --state
      // <path>` / `--env <name>` (etc.) actually take effect.
      const opts = command.optsWithGlobals() as AdoptGroupOptions;
      const selectors = [ids.length > 0, Boolean(opts.type), Boolean(opts.childrenOf)].filter(Boolean).length;
      if (selectors === 0) {
        throw new Error("Specify group id(s), --type <groupTypeIdOrKey>, or --children-of <idOrKey>.");
      }
      if (selectors > 1) {
        throw new Error("Specify only one of: group id(s), --type, --children-of.");
      }
      for (const raw of ids) {
        if (!isNonNegativeInt(raw)) {
          throw new Error(`Invalid id "${raw}" — expected a non-negative integer.`);
        }
      }
      if (opts.key && ids.length > 1) {
        throw new Error("--key is only valid when adopting a single group.");
      }

      // Resolve the env FIRST — it wires the target host/token into the process env before
      // resolveConfig — then load + validate the state file (host guard) BEFORE any network call,
      // so a state file recorded against another instance never triggers a live request against
      // the wrong host.
      const cmdEnv = await prepareEnv(opts);
      const config = await resolveConfig();
      const statePath = cmdEnv.statePath;
      const state = await loadState(statePath, config.host);

      const { client } = await authedSession();

      let resolvedIds: number[];
      if (ids.length > 0) {
        resolvedIds = ids.map((raw) => Number.parseInt(raw, 10));
      } else if (opts.type) {
        const groupTypeId = await resolveGroupTypeId(opts.type, client);
        resolvedIds = await collectByGroupType(groupTypeId, client);
      } else {
        const rootId = await resolveGroupId(opts.childrenOf!, client, state);
        resolvedIds = await collectSubtreeIds(rootId, client);
      }
      resolvedIds = [...new Set(resolvedIds)];

      if (opts.key && resolvedIds.length !== 1) {
        throw new Error(`--key is only valid when adopting a single group (resolved ${resolvedIds.length}).`);
      }
      if (resolvedIds.length === 0) {
        info("No groups matched — nothing to adopt.");
        return;
      }

      const now = new Date().toISOString();
      // One reverse resolver across the whole (possibly bulk) run — each master-data catalog is
      // fetched at most once and reused for every group's numeric-id → logical-sugar rewrite (#52).
      const reverse = new ReverseResolver(client);
      const results: ResolvedAdoption[] = [];
      const reports: Array<{ action: "created" | "updated"; id: number; key: string }> = [];

      // Portable-ruleset catalogs (#76): fetch the catalog-backed id→key maps ONCE (campus/group-type).
      // The `group` map is state-derived and rebuilt per capture (it grows as this run adopts). Roles are
      // NOT a simple id→key map — a `role.id`/`groupTypeRoleId` is group-type-scoped and role names are
      // not globally unique, so we fetch the (groupTypeId, name) catalog plus the group-type id→key map
      // and let portablizeRuleset emit (group-type, role-name) markers (fixes #86's `role-def` mapping).
      //
      // Portablization is ON by default since #101 (`--no-portable-rulesets` opts out): leaving a
      // capture host-specific fails SILENTLY on the next host — CT does not validate the ids inside a
      // ruleset, so the auto-group just collects the wrong people while `ct plan` stays green.
      const portableCatalogMaps: Partial<Record<RefKind, Map<number, string>>> = {};
      let roleCatalog: Map<number, RoleCatalogEntry> | undefined;
      let groupTypeIdToKey: Map<number, string> | undefined;
      if (opts.withDynamic && opts.portableRulesets !== false) {
        portableCatalogMaps.campus = await reverse.idToKeyByKind("campus");
        portableCatalogMaps["group-type"] = await reverse.idToKeyByKind("group-type");
        groupTypeIdToKey = portableCatalogMaps["group-type"];
        roleCatalog = await reverse.roleGroupTypeCatalog();
      }

      for (const id of resolvedIds) {
        const resource = await client.get<Record<string, unknown>>(GROUP_SPEC.itemPath(id));
        // An already-managed group keeps its adopted key unless --rekey says otherwise (#123). This
        // is the mode that made the bug bite: the documented ruleset-refresh workflow passes a LIST
        // of ids, which is exactly when `-k` is rejected, so there was no way to prevent the re-key.
        // Because `relPath` below is built from `key`, preserving it also makes the refresh overwrite
        // the ruleset file the config already points at instead of writing a second one.
        const choice = chooseAdoptKey(state, "group", id, GROUP_SPEC.deriveKey(resource), {
          explicitKey: resolvedIds.length === 1 ? opts.key : undefined,
          rekey: opts.rekey,
        });
        const key = choice.key;
        if (!key) {
          throw new Error(`Could not derive a logical key for group #${id} — pass --key explicitly.`);
        }
        if (choice.wouldBecome) {
          warn(
            `${key}: key would change to "${choice.wouldBecome}" (derived from the live name). ` +
              `Keeping the adopted key. Pass --rekey to change it.`,
          );
        }
        const fields = GROUP_SPEC.managedFields(resource);

        // Reverse-resolve the group's numeric ids to logical sugar for the emitted snippet; the
        // captured `dynamic` block (if any) is appended AFTER, so it is not treated as an id field.
        const { fields: sugared, todos } = await reverse.sugarFields(fields);
        const snippetFields: Record<string, unknown> = sugared;
        // Emitted BEFORE `dynamic` so the snippet reads in apply order — the fields a ruleset may
        // reference are declared above the ruleset that references them (#135).
        const memberFields = opts.withMemberFields ? await captureMemberFields(id, client) : undefined;
        if (memberFields && memberFields.declarations.length > 0) {
          snippetFields.memberFields = memberFields.declarations;
        }
        if (opts.withDynamic) {
          const captured = await captureDynamic(id, client);
          if (captured) {
            const relPath = `rulesets/${key}.json`;
            let rulesetToWrite = captured.normalizedRuleset;
            if (opts.portableRulesets !== false) {
              // Managed group ids come from state (no catalog for `group`), including any group this
              // same run already adopted; the master-data kinds come from the catalog maps above.
              const groupMap = new Map<number, string>();
              // Managed role definitions, likewise from STATE rather than the live catalog (#125):
              // state gives a per-host id under a shared logical key, which is what makes a
              // duplicate role name fixable by adopting the role instead of renaming master data.
              // (`ReverseResolver.idToKeyByKind("role-def")` keys by slug(name) off the catalog and
              // is exactly the ambiguous mapping this replaces.)
              const roleDefMap = new Map<number, string>();
              for (const r of Object.values(state.resources)) {
                if (r.type === "group") groupMap.set(r.id, r.key);
                if (r.type === "group-role") roleDefMap.set(r.id, r.key);
              }
              const { ruleset, warnings } = portablizeRuleset(captured.normalizedRuleset, {
                idToKeyByKind: { ...portableCatalogMaps, group: groupMap, "role-def": roleDefMap },
                roleCatalog,
                groupTypeIdToKey,
              });
              rulesetToWrite = ruleset;
              // Report every dimension left numeric, with its reason (#101). The old output said only
              // "left N unmanaged id(s) numeric", which named neither the dimension nor the fix — so a
              // capture that silently froze prod's ids into a cross-host file looked like a clean run.
              if (warnings.length > 0) {
                const lines = formatPortablizeWarnings(warnings);
                if (opts.strictRulesets) {
                  throw new Error(
                    `--strict-rulesets: ${relPath} would contain ${warnings.length} unportablized ` +
                      `(host-specific) id(s), so nothing was written:\n` +
                      lines.map((l) => `    ${l}`).join("\n"),
                  );
                }
                warn(
                  `${relPath} keeps ${warnings.length} host-specific id(s) — NOT portable to another host:`,
                );
                for (const line of lines) info(`    ${line}`);
              }
            } else {
              // Verbatim capture (--no-portable-rulesets): every entity id in the file is this host's.
              // Say so once per ruleset rather than let the opt-out quietly imply the ids are fine.
              const left = scanUnportablized(captured.normalizedRuleset);
              if (left.length > 0) {
                if (opts.strictRulesets) {
                  throw new Error(
                    `--strict-rulesets with --no-portable-rulesets: ${relPath} would contain ` +
                      `${left.length} host-specific id(s) and nothing would rewrite them.`,
                  );
                }
                warn(
                  `${relPath} captured verbatim (--no-portable-rulesets): ${left.length} host-specific ` +
                    `id(s) kept as-is — NOT portable to another host.`,
                );
              }
            }
            if (!opts.dryRun) {
              await mkdir(join(process.cwd(), "rulesets"), { recursive: true });
              await writeFile(
                join(process.cwd(), relPath),
                `${JSON.stringify(rulesetToWrite, null, 2)}\n`,
                "utf8",
              );
            }
            snippetFields.dynamic = { status: captured.status, ruleset: { ref: `./${relPath}` } };
          }
        }
        const snippet = configSnippet("group", key, snippetFields, { todos });

        if (opts.dryRun) {
          results.push({ id, key, fields, snippet });
          continue;
        }
        const action = upsert(state, { type: "group", id, key, fields }, now);
        if (memberFields) state.resources[key]!.memberFields = memberFields.ids;
        results.push({ id, key, fields, snippet });
        reports.push({ action, id, key });
      }

      if (opts.dryRun) {
        const payload = results.map((r) => ({
          key: r.key,
          type: "group",
          id: r.id,
          fields: r.fields,
          config: r.snippet,
        }));
        info(
          results.length === 1
            ? `Would adopt group #${results[0]!.id} as "${results[0]!.key}". Generated config entry:`
            : `Would adopt ${results.length} groups. Generated config entries:`,
        );
        out(results.length === 1 ? payload[0] : payload);
        return;
      }

      await saveState(statePath, state);

      for (const r of reports) {
        success(
          `${r.action === "created" ? "Adopted" : "Updated"} group #${r.id} as "${r.key}" → ${statePath}`,
        );
        if (r.action === "updated") {
          warn("This resource was already managed — its snapshot was refreshed.");
        }
      }

      // Grouped, paste-ready config block: each snippet is now idiomatic multi-line TS (#52 item A),
      // wrapped under a type comment header and ordered parents-before-children where hierarchy is
      // known (--children-of's subtree walk).
      info(results.length === 1 ? "Config entry:" : "Config entries (paste into your config):");
      const block = [`// group`, ...results.map((r) => r.snippet)].join("\n");
      process.stdout.write(`${block}\n`);
    });
}
