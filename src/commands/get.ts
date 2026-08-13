import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { prepareEnvHost } from "../env/context.js";
import { CATALOG } from "../permissions/catalog.js";
import { info, out } from "../ui.js";

interface ResourceSpec {
  path: string;
  /**
   * Whether this endpoint returns a paged list (auto-paginate through every
   * page) vs a single object (`whoami`, `info`, the global permissions blob)
   * where paging params don't apply. Defaults to true.
   */
  paginated?: boolean;
}

/**
 * Read-only imperative queries — immediately useful before any declarative
 * engine exists. Resource → API path map. Paths confirmed against the live
 * spec by the Phase 0 spike (#2, CT 3.123.0); see docs/api-coverage.md.
 *
 * List endpoints are auto-paginated (#50): ChurchTools returns only its
 * default page (10 items) per request, so `ct get groups` on an instance with
 * 300+ groups silently returned just the first 10 before this fix.
 */
const RESOURCE_PATHS: Record<string, ResourceSpec> = {
  whoami: { path: "/whoami", paginated: false },
  info: { path: "/info", paginated: false },
  campuses: { path: "/campuses" },
  groups: { path: "/groups" },
  "group-hierarchies": { path: "/groups/hierarchies" },
  "group-types": { path: "/group/grouptypes" },
  "group-roles": { path: "/group/roles" },
  "age-groups": { path: "/group/agegroups" },
  "target-groups": { path: "/group/targetgroups" },
  "dynamic-groups": { path: "/dynamicgroups" },
  "relationship-types": { path: "/person/relationshiptypes" },
  // Bereiche/departments — the `cdb_bereich` permission scope dimension. READ-ONLY in ChurchTools
  // (GET only; no write verb exists), so this is the way to discover the names a
  // `scope: [{ department: "…" }]` reference resolves against. Never adoptable.
  departments: { path: "/departments" },
  // PERSON statuses — master data (the enumeration), never person records. The domain a `ct.status`
  // permission declaration hangs off, and an adoptable resource since #96.
  statuses: { path: "/statuses" },
  // Schema/DEFINITIONS only — never person records or field VALUES (#47/#48; see docs/handbuch/field-definitions.md).
  // The person master-data MODEL: sexes/titles/statuses/campuses plus the security-level enumeration
  // that churchdb permission scopes (cc_securitylevel) reference. Single object → unpaginated.
  "person-masterdata": { path: "/person/masterdata", paginated: false },
  // Unified data-field DEFINITION catalog (Datenfelder): person master-data fields AND group custom
  // fields in one list, discriminated per-row by `fieldCategory` (e.g. table `cdb_gruppe` = group).
  // Read-only: mutation is only via the legacy churchdb admin AJAX, not REST — see docs/handbuch/field-definitions.md.
  "data-fields": { path: "/dbfields" },
  permissions: { path: "/permissions/global", paginated: false },
};

export function getCommand(): Command {
  const cmd = new Command("get").description("Read structure resources from ChurchTools (JSON to stdout)");

  for (const [name, spec] of Object.entries(RESOURCE_PATHS)) {
    cmd
      .command(name)
      .description(`GET ${spec.path}`)
      .option("-e, --env <name>", "environment profile from ct.envs.json (targets that host)")
      .action(async (opts: { env?: string }) => {
        await prepareEnvHost(opts); // #22: wire the env's host/token before authenticating
        const { client } = await authedSession();
        if (spec.paginated === false) {
          out(await client.get(spec.path));
          return;
        }
        const { data, meta } = await client.getAll(spec.path);
        out(data);
        const total = meta?.pagination?.total;
        if (total !== undefined && total !== data.length) {
          info(`${data.length} of ${total} total`);
        } else {
          info(`${data.length} total`);
        }
      });
  }

  cmd
    .command("permissions-catalog")
    .description("List the static permission-name → authId catalog (for use in config `grants`)")
    .action(() => {
      for (const name of Object.keys(CATALOG).sort()) {
        const entry = CATALOG[name];
        if (!entry) continue;
        const scoped = entry.scopeField ? "scoped" : "unscoped";
        process.stdout.write(`${name} -> ${entry.authId} (${scoped})\n`);
      }
    });

  cmd
    .command("raw <path>")
    .description("GET an arbitrary API path, e.g. `ct get raw /groups/42`")
    .option("-e, --env <name>", "environment profile from ct.envs.json (targets that host)")
    .action(async (path: string, opts: { env?: string }) => {
      await prepareEnvHost(opts); // #22: wire the env's host/token before authenticating
      const { client } = await authedSession();
      out(await client.get(path.startsWith("/") ? path : `/${path}`));
    });

  return cmd;
}
