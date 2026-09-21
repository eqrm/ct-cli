/**
 * Reading an OpenTofu state file into an {@link IdMapEntry} list (#181) — PURE.
 *
 * `ct export tf` can write the id map from the state it is exporting, but only for as long as ct
 * still holds those entries. Once tier-0 belongs to tofu, tofu is the only place new ids appear: a
 * campus created by `tofu apply` exists in no ct state file, so an export cannot know about it. That
 * is what this reader is for — `tofu state pull | ct ids sync -e prod --tofu-state -` refreshes the
 * map from the authoritative source without ct ever learning to speak S3.
 *
 * Kept pure (a parsed JSON value in, entries out) so it can be tested against fixture state without
 * a filesystem, like the HCL renderer it mirrors.
 */
import { hclType } from "../export/hcl.js";
import { EXPORTABLE_TYPES } from "../export/layout.js";
import type { IdMapEntry } from "./idMap.js";

/** Terraform resource type → ct resource type, derived from the exporter's own table so the two
 *  directions cannot drift. */
const CT_TYPE_BY_HCL_TYPE: ReadonlyMap<string, string> = new Map(
  EXPORTABLE_TYPES.map((ctType) => [hclType(ctType), ctType] as const),
);

export interface TfStateReadResult {
  entries: IdMapEntry[];
  /** Provider resources in the state whose type ct has no mapping for — reported, never fatal. */
  unmapped: string[];
  /** Terraform's own serial, if present, so a sync can say which state version it read. */
  serial: number | null;
}

interface TfResource {
  mode?: string;
  type?: string;
  name?: string;
  instances?: { attributes?: Record<string, unknown> }[];
}

/**
 * Turn a parsed `terraform.tfstate` into id-map entries.
 *
 * `keysByLabel` maps a `type\0label` back to the ct key it was exported from. The exporter relabels
 * keys that are not valid HCL identifiers (`3_groupactive` → `g_3_groupactive`) and that mapping is
 * many-to-one, so it cannot be inverted by rule — without the previous map's help, the label IS the
 * key, which is correct for every key that needed no relabelling.
 */
export function readTfState(
  parsed: unknown,
  keysByLabel: ReadonlyMap<string, string> = new Map(),
): TfStateReadResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Malformed tofu state: expected a JSON object at the top level.");
  }
  const state = parsed as { resources?: unknown; serial?: unknown };
  if (state.resources !== undefined && !Array.isArray(state.resources)) {
    throw new Error('Malformed tofu state: "resources" is not an array.');
  }
  const entries: IdMapEntry[] = [];
  const unmapped = new Set<string>();
  for (const raw of (state.resources ?? []) as TfResource[]) {
    // `data` blocks describe reads, not managed objects: their id is whatever the data source
    // happened to return, and nothing in the config keys off it.
    if (raw.mode !== undefined && raw.mode !== "managed") continue;
    if (typeof raw.type !== "string" || typeof raw.name !== "string") continue;
    const ctType = CT_TYPE_BY_HCL_TYPE.get(raw.type);
    if (!ctType) {
      // Anything the provider manages that ct has no resource type for — a churchtools_group once
      // the provider grows one, or another provider's resources in a shared state.
      if (raw.type.startsWith("churchtools_")) unmapped.add(raw.type);
      continue;
    }
    const attributes = raw.instances?.[0]?.attributes ?? {};
    const id = Number(attributes.id);
    // A resource in state with no numeric id is mid-create or tainted; an unresolvable reference is
    // a better outcome than a reference resolved to NaN.
    if (!Number.isFinite(id)) continue;
    const key = keysByLabel.get(`${ctType}\u0000${raw.name}`) ?? raw.name;
    entries.push(key === raw.name ? { type: ctType, key, id } : { type: ctType, key, id, label: raw.name });
  }
  return {
    entries,
    unmapped: [...unmapped].sort(),
    serial: typeof state.serial === "number" ? state.serial : null,
  };
}
