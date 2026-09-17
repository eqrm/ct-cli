/** Import-block rendering — PURE. */
import { hclLabel, hclType } from "./hcl.js";

export interface ImportTarget {
  type: string;
  key: string;
  id: number;
}

/**
 * `id` is stringified explicitly rather than passed through any truthiness
 * path: a campus can legitimately carry id 0, and a truthiness test would
 * silently fail to import exactly that one resource.
 */
export function renderImports(targets: readonly ImportTarget[]): string {
  return targets
    .map((t) =>
      ["import {", `  to = ${hclType(t.type)}.${hclLabel(t.key)}`, `  id = "${String(t.id)}"`, "}", ""].join(
        "\n",
      ),
    )
    .join("\n");
}
