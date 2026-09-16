/** Import-block rendering — PURE. */
import { hclLabel, hclType } from "./hcl.js";

export interface ImportTarget {
  type: string;
  key: string;
  id: number;
}

/**
 * `id` is stringified explicitly rather than passed through any truthiness
 * path: the Mainz campus is id 0, and dropping it would silently fail to
 * import exactly one resource.
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
