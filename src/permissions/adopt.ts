/**
 * Grant adoption: read a live domain's permission rows and emit a paste-ready
 * `ct.groupRole({...})` / `ct.groupTypeRole({...})` config block, so an existing
 * instance's rights structure comes under management without hand-transcription
 * (issue #25).
 *
 * The live rows are run through the SAME normalization the planner uses
 * (`normalizeActual`) so what is emitted is exactly what a subsequent `ct plan`
 * would consider managed: the system baseline (`modifiedPid === -1`) and
 * inherited rows are dropped, and pre-existing revoke/deny rows are surfaced as
 * a note rather than emitted (the reconciler preserves them; re-authoring them
 * is out of scope here).
 *
 * Grants are NOT state-tracked resources, so adoption prints config only — it
 * never writes the state file. The caller makes that explicit in its output.
 */
import type { State } from "../state/state.js";
import { findByTypeId } from "../state/state.js";
import { CATALOG } from "./catalog.js";
import { normalizeActual, type DomainType, type GrantTuple, type RawPermission } from "./grants.js";
import { GROUP_SCOPE_FIELD, SCOPE_REF_KIND } from "./scope.js";

/** DSL function name for each domain type — the call the emitted block should be pasted as. */
const DSL_FN: Record<DomainType, string> = {
  group_role: "ct.groupRole",
  group_type_role: "ct.groupTypeRole",
  status: "ct.status",
};

/** DSL sugar field name per managed scope type, for emitting `{ campus: "koblenz" }`-style refs. */
const SCOPE_SUGAR_FIELD: Readonly<Record<string, string>> = {
  campus: "campus",
  "group-type": "groupType",
  department: "department",
};

interface ReverseEntry {
  name: string;
  scopeField: string | null;
}

/**
 * authId → `module:right` reverse map, built once from the static catalog. The catalog is keyed by
 * name; adoption needs the inverse. If two names share an authId (shouldn't happen), the first wins
 * — deterministic because `Object.entries` preserves insertion order.
 */
function reverseCatalog(): Map<number, ReverseEntry> {
  const rev = new Map<number, ReverseEntry>();
  for (const [name, entry] of Object.entries(CATALOG)) {
    if (!rev.has(entry.authId)) {
      rev.set(entry.authId, { name, scopeField: entry.scopeField });
    }
  }
  return rev;
}

/** A grant collapsed from the per-dataId rows CT returns: one entry per distinct authId. */
interface CollapsedGrant {
  authId: number;
  /** Distinct scope dataIds (group ids). Empty ⇒ an unscoped grant. */
  dataIds: number[];
  /** True when at least one row for this authId carried no dataId (an unscoped grant). */
  hasUnscoped: boolean;
}

/**
 * Collapse normalized grant tuples (one per dataId — CT reads scoped grants back one row per
 * dataId) into one {@link CollapsedGrant} per authId, preserving first-seen order and deduping
 * dataIds.
 */
function collapse(tuples: GrantTuple[]): CollapsedGrant[] {
  const byAuth = new Map<number, CollapsedGrant>();
  for (const t of tuples) {
    let g = byAuth.get(t.authId);
    if (!g) {
      g = { authId: t.authId, dataIds: [], hasUnscoped: false };
      byAuth.set(t.authId, g);
    }
    if (t.dataId.length === 0) {
      g.hasUnscoped = true;
    } else {
      for (const id of t.dataId) if (!g.dataIds.includes(id)) g.dataIds.push(id);
    }
  }
  return [...byAuth.values()];
}

/**
 * Build the paste-ready config block for a domain's adopted grants. Pure: takes the raw rows and
 * the state, returns the block text (comments and all). The command wrapper handles the fetch and
 * prints the result — this stays fully unit-testable without a network.
 */
export function emitAdoptedGrants(args: {
  domainType: DomainType;
  domainId: number;
  rows: RawPermission[];
  state: State;
}): string {
  const { domainType, domainId, rows, state } = args;
  const normalized = normalizeActual(rows);
  const grants = normalized.filter((t) => t.type === "grant");
  const revokes = normalized.filter((t) => t.type !== "grant");
  const rev = reverseCatalog();

  const body: string[] = [];
  let omitted = 0;
  body.push(`${DSL_FN[domainType]}({`);
  body.push(`  key: "${domainType}_${domainId}", // a logical key, unique across the config — rename to taste`);
  body.push(`  id: ${domainId},`);

  if (grants.length === 0) {
    body.push("  grants: [], // no user-authored grants on this domain (baseline/inherited rows excluded)");
  } else {
    body.push("  grants: [");
    for (const g of collapse(grants)) {
      const r = grantLines(g, rev, state);
      body.push(...r.lines);
      if (r.omitted) omitted += 1;
    }
    body.push("  ],");
  }

  body.push("});");

  const lines: string[] = [];
  if (omitted > 0) {
    // Reconciliation is set-based: a live grant absent from the declaration lands in `toDelete`.
    // So every grant left below as a comment WILL BE REVOKED by the next apply of this block —
    // this must be impossible to miss, hence the header.
    lines.push(`// WARNING: ${omitted} live grant(s) could not be expressed as config and are left as comments below.`);
    lines.push("// They are still ACTIVE on the instance — applying this block as-is will REVOKE them, because");
    lines.push("// reconciliation deletes any live grant missing from the declaration. Resolve every WARNING/NOTE");
    lines.push("// comment (adopt the group, regenerate the catalog, …) before running `ct apply`.");
  }
  lines.push(...body);

  if (revokes.length > 0) {
    lines.push(
      `// NOTE: ${revokes.length} revoke/deny row(s) exist on this domain. The reconciler PRESERVES them (it never`,
    );
    lines.push(
      "// deletes a deny it did not author), so they are intentionally not emitted above. Re-authoring denies as",
    );
    lines.push("// config is not supported yet (see issue #25 stretch goal).");
  }

  return lines.join("\n");
}

/** The lines emitted for one collapsed grant, plus whether a LIVE grant was left as a comment
 *  (⇒ reconciliation would revoke it — counted into the block-level header warning). */
interface GrantLinesResult {
  lines: string[];
  omitted: boolean;
}

/**
 * Emit the grant line(s) for one collapsed grant, resolving scope dataIds back to state keys.
 *
 * Round-trip invariant (locked by tests): every ACTIVE (non-comment) line this emits must pass
 * `desiredTuples` (`src/permissions/plan.ts`) without throwing — anything the planner would
 * reject (a scoped right without a declarable scope, an unscoped right carrying dataIds) is emitted
 * as a comment instead.
 */
function grantLines(
  g: CollapsedGrant,
  rev: Map<number, ReverseEntry>,
  state: State,
): GrantLinesResult {
  const entry = rev.get(g.authId);
  if (!entry) {
    // Unknown authId → no name to emit, and a numeric right is not declarable in the DSL. Surface
    // it as a clearly-marked comment rather than emitting invalid config or failing the adoption.
    return {
      omitted: true,
      lines: [
        `    // WARNING: authId ${g.authId} has no catalog entry — cannot map to a "module:right" name.`,
        "    //          Regenerate the catalog (see docs) or add this right by hand.",
      ],
    };
  }

  // No authId cutoff (#65): the grants reaching here already passed `normalizeActual` (line ~100),
  // which drops the system baseline (`modifiedPid === -1`) and every `isInherited` row — so what is
  // left is admin-authored DIRECT grants, INCLUDING the writable `authId >= 10000` group-member rights
  // Equippers curates on group_type_role. Those ARE declarable and are emitted as active grants.
  if (entry.scopeField != null && entry.scopeField !== GROUP_SCOPE_FIELD) {
    // Scoped right whose scope dimension is NOT a group. Two cases:
    //
    //  a) The dimension HAS a logical form (#98: `cdb_station` → campus, `cdb_gruppentyp` → group
    //     type). Emit each dataId that names a MANAGED resource as a typed ref (`{ campus: "koblenz" }`)
    //     — the whole point of #98, since these ids are host-specific (dev Mainz = 6, prod Mainz = 0),
    //     so a numeric literal adopted from prod is a misgrant when replayed on dev. An unmanaged
    //     dataId keeps its number and earns a NOTE pointing at the one command that fixes it.
    //  b) The dimension has none (`cc_securitylevel`, `cdb_bereich`, `oauth_client`, …) — its dataIds
    //     name something this tool has no managed representation for, so the numeric escape hatch
    //     (#49) is the only honest output and the grant is always emitted as an ACTIVE line.
    const out: string[] = [];
    let omitted = false;
    if (g.hasUnscoped) {
      out.push(`    // WARNING: "${entry.name}" is granted GLOBALLY here (scoped right, no dataId). The config`);
      out.push("    //          DSL cannot declare a global grant of a scoped right; re-grant it with an explicit");
      out.push("    //          scope in CT, or leave this domain unmanaged.");
      omitted = true;
    }
    if (g.dataIds.length > 0) {
      const dimension = SCOPE_REF_KIND[entry.scopeField];
      // A catalog-only dimension (departments) has no managed resource to look an id up in, and this
      // emitter is deliberately pure — no client, no fetch — so it cannot turn the id into a name.
      // Emit the number and point at the portable form the author can write by hand.
      const sugar = dimension?.managed ? SCOPE_SUGAR_FIELD[dimension.type] : undefined;
      if (dimension && !dimension.managed) {
        const field = SCOPE_SUGAR_FIELD[dimension.type] ?? dimension.type;
        out.push(
          `    // NOTE: "${entry.name}" scopes by "${entry.scopeField}" (${dimension.type}), a read-only catalog —`,
        );
        out.push(
          `    //       the id below is host-specific. Portable form: { ${field}: "<name>" } (\`ct get ${dimension.type}s\`).`,
        );
      }
      const entries: string[] = [];
      const unmanaged: number[] = [];
      for (const id of [...g.dataIds].sort((a, b) => a - b)) {
        const managed = dimension && sugar ? findByTypeId(state, dimension.type, id) : undefined;
        if (managed && sugar) {
          entries.push(`{ ${sugar}: ${JSON.stringify(managed.key)} }`);
        } else {
          entries.push(String(id));
          unmanaged.push(id);
        }
      }
      if (sugar && unmanaged.length > 0) {
        // Not a WARNING: the numeric line below IS valid, applicable config — it is just not portable
        // to another host. So this never counts into `omitted` (nothing would be revoked).
        const one = unmanaged.length === 1;
        // `ct adopt <type> <id>` takes exactly ONE id, so name every unmanaged id: telling the author
        // to adopt `unmanaged[0]` alone would leave the rest numeric and the block still unportable.
        const commands = unmanaged.map((id) => `\`ct adopt ${dimension!.type} ${id}\``).join(", ");
        out.push(
          `    // NOTE: "${entry.name}" scopes by "${entry.scopeField}" (${dimension!.type}). ${unmanaged.join(", ")} ` +
            `${one ? "is" : "are"} not managed, so`,
        );
        out.push(
          `    //       ${one ? "it stays a" : "they stay"} host-specific number(s) — run ${commands} ` +
            `and re-adopt to make ${one ? "it" : "them all"} portable.`,
        );
      } else if (!dimension) {
        // Reached only for a dimension with NO logical form at all (`cc_securitylevel`, `oauth_client`,
        // …). A catalog-only dimension (`cdb_bereich`) already got its own NOTE above — emitting this
        // line there too would contradict it ("not a group, use numbers" vs "portable form exists").
        out.push(`    // "${entry.name}" scopes by "${entry.scopeField}", not a group — using its numeric dataId(s) directly.`);
      }
      out.push(`    { right: ${JSON.stringify(entry.name)}, scope: [${entries.join(", ")}] },`);
    }
    return { lines: out, omitted };
  }

  if (entry.scopeField != null) {
    // Scoped right on the GROUP dimension → resolve each dataId back to a MANAGED group's logical
    // key. Scope keys must be state keys (see src/permissions/scope.ts), so an unmanaged dataId
    // cannot be emitted as a key — the numeric escape hatch is not offered here on purpose: a
    // `cdb_gruppe` dataId names an actual group, and `ct adopt group <id>` is the guided path to
    // bring it under management (rather than silently declaring an opaque numeric scope for it).
    const resolvedKeys: string[] = [];
    const unmanaged: number[] = [];
    for (const id of g.dataIds) {
      const group = findByTypeId(state, "group", id);
      if (group) resolvedKeys.push(group.key);
      else unmanaged.push(id);
    }

    const out: string[] = [];
    let omitted = false;
    if (g.hasUnscoped) {
      // A scoped right granted with dataId null = granted GLOBALLY in CT. The DSL cannot declare
      // that (a bare string for a scoped right is rejected at plan time precisely to prevent
      // accidental global grants), so it can only be surfaced as a comment.
      out.push(`    // WARNING: "${entry.name}" is granted GLOBALLY here (scoped right, no dataId). The config`);
      out.push("    //          DSL cannot declare a global grant of a scoped right; re-grant it with an explicit");
      out.push("    //          scope in CT, or leave this domain unmanaged.");
      omitted = true;
    }
    for (const id of unmanaged) {
      out.push(
        `    // WARNING: scope target group #${id} is not managed — run \`ct adopt group ${id}\` (or declare it),`,
      );
      out.push(`    //          then add its logical key to the scope array below.`);
      omitted = true;
    }
    if (resolvedKeys.length > 0) {
      const scope = resolvedKeys.map((k) => JSON.stringify(k)).join(", ");
      out.push(`    { right: ${JSON.stringify(entry.name)}, scope: [${scope}] },`);
    } else if (unmanaged.length > 0) {
      // Every scope target is unmanaged: there is no valid key to emit, so the grant itself is a
      // commented placeholder the user completes after adopting the group(s) above.
      out.push(`    // { right: ${JSON.stringify(entry.name)}, scope: [/* adopt the group(s) above first */] },`);
    }
    return { lines: out, omitted };
  }

  // Unscoped right. dataId rows on it contradict the catalog (which says it takes no scope) —
  // likely a stale catalog; emitting a scope for it would be rejected at plan time, so comment.
  const out: string[] = [];
  let omitted = false;
  if (g.dataIds.length > 0) {
    out.push(
      `    // WARNING: "${entry.name}" is unscoped per the catalog, but CT returned it with dataId(s)`,
    );
    out.push(`    //          ${g.dataIds.join(", ")} — the catalog may be stale. Regenerate it, then re-adopt.`);
    omitted = true;
  }
  if (g.hasUnscoped) {
    out.push(`    ${JSON.stringify(entry.name)},`);
  }
  return { lines: out, omitted };
}
