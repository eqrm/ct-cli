/**
 * Registry of adoptable ChurchTools resource types.
 *
 * Each entry knows how to fetch one resource by id, derive a stable logical key,
 * snapshot the fields we manage, and render a config snippet (the TS-as-code
 * form the Phase 3 engine will consume). Paths come from the Phase 0 coverage
 * matrix (docs/api-coverage.md). Adding a type = adding an entry here.
 */

export interface AdoptableResource {
  /** GET path for a single resource by id. */
  itemPath: (id: number) => string;
  /** Stable logical key derived from the fetched resource. */
  deriveKey: (resource: Record<string, unknown>) => string;
  /** The subset of fields we manage — the desired-state baseline. */
  managedFields: (resource: Record<string, unknown>) => Record<string, unknown>;
}

/** kebab/underscore slug: "Kids Leitung" → "kids_leitung". */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function str(resource: Record<string, unknown>, key: string): string {
  const value = resource[key];
  return typeof value === "string" ? value : "";
}

export const RESOURCES: Record<string, AdoptableResource> = {
  campus: {
    itemPath: (id) => `/campuses/${id}`,
    deriveKey: (r) => slug(str(r, "shortName") || str(r, "name")),
    managedFields: (r) => ({ name: r.name, shortName: r.shortName }),
  },
  group: {
    itemPath: (id) => `/groups/${id}`,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => {
      const information = (r.information as Record<string, unknown> | undefined) ?? {};
      return { name: r.name, groupTypeId: information.groupTypeId, groupStatusId: information.groupStatusId };
    },
  },
  "group-type": {
    itemPath: (id) => `/group/grouptypes/${id}`,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated }),
  },
};

export function resourceType(type: string): AdoptableResource {
  const entry = RESOURCES[type];
  if (!entry) {
    const known = Object.keys(RESOURCES).join(", ");
    throw new Error(`Unknown resource type "${type}". Adoptable types: ${known}.`);
  }
  return entry;
}

/** Render a config entry as a TS-as-code call, e.g. `campus({ key: "mainz", name: "Mainz" })`. */
export function configSnippet(type: string, key: string, fields: Record<string, unknown>): string {
  const fn = type.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return `${fn}(${tsObject({ key, ...fields })});`;
}

function tsObject(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${isIdentifier(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{ ${parts.join(", ")} }`;
}

function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}
