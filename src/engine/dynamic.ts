/**
 * Normalizer for dynamic-group rulesets. CT returns rulesets with cosmetic
 * labels, inconsistent int/string leaf types, and read-only timestamps,
 * wrapped in a single-element `[RuleSet]` array. `PUT` expects the SAME
 * `[RuleSet]` array envelope back (see `putRulesetBody` below) — CT 3.134.1
 * 500s (`TypeException: Array expected`) on a bare object (#77). Normalizing
 * both the desired and actual sides to one canonical form is what keeps
 * drift real, not spurious.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DynamicStatus } from "./types.js";

const READ_ONLY_KEYS = new Set(["dynamicGroupUpdateStarted", "dynamicGroupUpdateFinished"]);

/**
 * Whether a `dterm` label is pure display text: a string, or an object carrying nothing but a
 * `title`. Everything else is kept. In particular a `stereotype` label (in practice
 * `["groupmembership"]`) is NOT cosmetic: it tells ChurchTools to evaluate the wrapped group
 * condition per person ("is/is not a member of group X") instead of per membership row. Without
 * it, `!(member of X)` is true for every person who also has any other membership row, so a
 * negated group condition excludes no one. Measured read-only against 72 live rulesets on CT 3.137
 * (`POST /churchquery/debug/export`): keeping these labels reproduces every live result exactly;
 * dropping them changes 18 of them. An allowlist, so a label key ChurchTools adds later is kept
 * rather than silently stripped.
 */
export function isCosmeticLabel(label: unknown): boolean {
  if (label === null || label === undefined || typeof label === "string") return true;
  if (typeof label !== "object" || Array.isArray(label)) return false;
  return Object.keys(label).every((k) => k === "title");
}

function isLabelWrapper(obj: Record<string, unknown>): obj is { dterm: [unknown, unknown] } {
  return Array.isArray(obj.dterm) && obj.dterm.length === 2 && Object.keys(obj).length === 1;
}

/**
 * Recursively unwrap cosmetic `dterm: [label, expr]` wrappers to their `expr`. A wrapper whose
 * label is not cosmetic (see `isCosmeticLabel`) changes what the query selects and is kept, its
 * label copied verbatim and its `expr` normalized in place.
 */
export function stripCosmeticLabels(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripCosmeticLabels);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (isLabelWrapper(obj)) {
      const [label, expr] = obj.dterm;
      if (!isCosmeticLabel(label)) return { dterm: [structuredClone(label), stripCosmeticLabels(expr)] };
      return stripCosmeticLabels(expr); // keep the expression, drop the label
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = stripCosmeticLabels(v);
    return out;
  }
  return node;
}

/** The non-cosmetic `dterm` labels in a (normalized) query, in document order. */
export function semanticLabels(node: unknown): unknown[] {
  if (Array.isArray(node)) return node.flatMap(semanticLabels);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const own = isLabelWrapper(obj) && !isCosmeticLabel(obj.dterm[0]) ? [obj.dterm[0]] : [];
    return [...own, ...Object.values(obj).flatMap(semanticLabels)];
  }
  return [];
}

/**
 * Coerce numeric-string leaves to numbers (CT is int/string-inconsistent for `var` values).
 *
 * Only *canonical* integer strings are coerced: no leading zeros (`/^(-?[1-9]\d*|0)$/`) and
 * within `Number.MAX_SAFE_INTEGER`. This leaves semantic strings that merely look numeric —
 * leading-zero zip codes like `'01067'`, and >2^53 digit strings that would lose precision —
 * untouched, so they round-trip byte-identical through normalize + write-back instead of being
 * silently retyped (which broke their JSONLogic string comparisons). A canonical `"5"` still
 * coerces to `5`, so a `5` vs `"5"` int/string pair still diffs equal.
 */
export function coerceScalars(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(coerceScalars);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    // A kept `dterm` label is free text written back to ChurchTools verbatim: a title "2024" must
    // stay a string. Only the wrapped expression carries the int/string-inconsistent ids.
    if (isLabelWrapper(obj)) return { dterm: [structuredClone(obj.dterm[0]), coerceScalars(obj.dterm[1])] };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = coerceScalars(v);
    return out;
  }
  if (typeof node === "string" && /^(-?[1-9]\d*|0)$/.test(node)) {
    const n = Number.parseInt(node, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  return node;
}

function dropReadOnly(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rule)) if (!READ_ONLY_KEYS.has(k)) out[k] = v;
  return out;
}

/** Canonicalise a ruleset for diffing: unwrap array/PUT envelope, drop timestamps; strip labels + coerce scalars WITHIN the query subtree only. */
export function normalizeRuleset(rule: unknown): Record<string, unknown> {
  let r: unknown = rule ?? {};
  if (Array.isArray(r)) r = r[0] ?? {}; // GET returns a single-element [RuleSet]
  let obj = (r ?? {}) as Record<string, unknown>;
  if (obj.dynamicGroupRuleSet && typeof obj.dynamicGroupRuleSet === "object") {
    // Defensive: tolerate the `{ dynamicGroupRuleSet: ... }` wrapper if one is ever fed through
    // here — including the real PUT envelope, whose property is a single-element ARRAY
    // (see `putRulesetBody`); unwrap that inner array too, or `dropReadOnly` would mangle it.
    let inner: unknown = obj.dynamicGroupRuleSet;
    if (Array.isArray(inner)) inner = inner[0] ?? {};
    obj = (inner ?? {}) as Record<string, unknown>;
  }
  const base = dropReadOnly(obj);
  // Cosmetic dterm labels and int/string id inconsistencies live inside `query`. Normalize only
  // that subtree, so a RuleSet-level string field that looks numeric (a "2024" description/shorty)
  // is never silently retyped to a number and corrupted on write-back.
  if (base.query !== undefined) {
    base.query = coerceScalars(stripCosmeticLabels(base.query));
  }
  return base;
}

/**
 * The body `PUT /dynamicgroups/{id}/ruleset` expects: an OBJECT wrapper whose
 * `dynamicGroupRuleSet` property is a single-element array. Decoded from CT 3.134.1's own
 * validator, live (#77): `{ dynamicGroupRuleSet: RuleSet }` → "Array expected ... at
 * #->properties:dynamicGroupRuleSet"; a bare `[RuleSet]` → "Object expected, [...] received"
 * at the root. Together: root = object, property = array → `{ dynamicGroupRuleSet: [RuleSet] }`.
 * (GET, by contrast, returns the bare `[RuleSet]` array.)
 * The single source of truth for the PUT envelope — every writer (apply path, live-gated tests)
 * must go through this so the envelope can't drift out of sync again.
 */
export function putRulesetBody(ruleset: Record<string, unknown>): {
  dynamicGroupRuleSet: [Record<string, unknown>];
} {
  return { dynamicGroupRuleSet: [ruleset] };
}

export interface NormalizedDynamic {
  status: DynamicStatus;
  ruleset: Record<string, unknown>;
}

export function normalizeDynamic(spec: { status: DynamicStatus; ruleset: unknown }): NormalizedDynamic {
  return { status: spec.status, ruleset: normalizeRuleset(spec.ruleset) };
}

/**
 * Resolve a `{ ref: "./file.json" }` ruleset to its JSON contents; pass through inline rulesets.
 * `ref` paths resolve relative to `baseDir` (the config file's directory), NOT the process cwd,
 * so a config is portable regardless of where `ct` is invoked. Missing/unreadable/invalid-JSON
 * ref files raise a clear error naming the group and the resolved path instead of a raw ENOENT.
 */
export function resolveRulesetRef(
  ruleset: unknown,
  baseDir: string = process.cwd(),
  groupKey?: string,
): unknown {
  if (ruleset && typeof ruleset === "object" && typeof (ruleset as { ref?: unknown }).ref === "string") {
    const ref = (ruleset as { ref: string }).ref;
    const p = resolve(baseDir, ref);
    const where = groupKey ? `dynamic ruleset for group "${groupKey}"` : "dynamic ruleset";
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch (err) {
      throw new Error(
        `${where}: cannot read ruleset ref "${ref}" (resolved to ${p}): ${(err as Error).message}`,
      );
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${where}: ruleset ref "${ref}" (resolved to ${p}) is not valid JSON: ${(err as Error).message}`,
      );
    }
  }
  return ruleset;
}
