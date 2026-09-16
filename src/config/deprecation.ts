/**
 * The TypeScript config DSL is FROZEN (#tier-0 migration): bugfixes only, no
 * new features, removed in ct-cli 5.0.
 *
 * Its successor is the OpenTofu provider `terraform-provider-churchtools`,
 * which replaces the state file with tfstate and the logical-key resolver with
 * native resource references. `ct export tf` generates HCL plus import blocks
 * from existing state, so migrating needs no re-adoption.
 *
 * Soft deprecation was the alternative and is the trap: it means carrying the
 * grant engine, the key resolver and `preserveUnknown` in TypeScript *and* Go
 * simultaneously, forever, for a format the estate no longer uses.
 */

let warned = false;

/** Test-only: reset the once-per-process latch. */
export function __resetDeprecationWarning(): void {
  warned = false;
}

/**
 * Warned once per process rather than once per resource: a per-resource
 * warning on a 265-resource config is noise nobody reads.
 *
 * stderr, never stdout — stdout carries `--json` payloads that CI gates parse.
 */
export function warnConfigDeprecated(env: NodeJS.ProcessEnv = process.env): void {
  if (warned || env.CT_NO_DEPRECATION_WARNING === "1") return;
  warned = true;
  process.stderr.write(
    "warning: the TypeScript config DSL is frozen and will be removed in ct-cli 5.0. " +
      "Migrate to terraform-provider-churchtools — run `ct export tf` to generate HCL and " +
      "import blocks from your existing state. Set CT_NO_DEPRECATION_WARNING=1 to silence this.\n",
  );
}
