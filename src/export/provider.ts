/** The generated root module's provider requirement — PURE. */

/**
 * Registry address of the successor provider. Emitted so the output directory
 * is a runnable root module: without a `required_providers` block `tofu init`
 * resolves `churchtools_*` to `registry.opentofu.org/hashicorp/churchtools` and
 * fails, which is the first thing a migrating user would hit.
 */
export const PROVIDER_SOURCE = "eqrm/churchtools";

/**
 * No version constraint: the provider is pre-1.0.
 *
 * To pin one, own the file: `ct export tf --no-versions` leaves `versions.tf`
 * alone (it is neither written nor pruned), so the constraint can live in your
 * repo alongside a backend block.
 */
export function renderVersions(): string {
  return [
    "terraform {",
    "  required_providers {",
    "    churchtools = {",
    `      source = "${PROVIDER_SOURCE}"`,
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}
