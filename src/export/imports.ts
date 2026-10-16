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

export interface MovedTarget {
  type: string;
  /** The HCL label tofu has the resource under now. */
  from: string;
  /** The label this export writes it under. */
  to: string;
}

/**
 * A resource that kept its id but got a new ct key gets a new address. Without a `moved` block the
 * old address loses its config and `tofu plan` proposes destroying it (#199).
 *
 * The import block for the new address stays: if the old address never reached tofu's state (an
 * export that was never applied), the move is a no-op and the import is what brings the resource in.
 * If it did, tofu moves first and the import of the same id is then a no-op. Both verified with
 * OpenTofu 1.12.
 */
export function renderMoved(targets: readonly MovedTarget[]): string {
  return targets
    .map((t) =>
      [
        "moved {",
        `  from = ${hclType(t.type)}.${t.from}`,
        `  to   = ${hclType(t.type)}.${t.to}`,
        "}",
        "",
      ].join("\n"),
    )
    .join("\n");
}
