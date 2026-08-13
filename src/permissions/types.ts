/**
 * Desired-state shape for permission declarations (`ct.groupRole` /
 * `ct.groupTypeRole` in the config DSL). These reconcile through their own
 * subsystem (see `src/permissions/grants.ts`), not the group engine, so they
 * are collected as a separate list from `DesiredResource[]`.
 */
import type { DomainType } from "./grants.js";
import type { Ref } from "../resolve/refs.js";

/**
 * A typed logical scope reference in its authoring (object-sugar) form (#98) — exactly one dimension
 * field. `{ campus: "koblenz" }` is the portable way to scope a grant by campus, whose ids are
 * host-specific (dev Mainz = 6, prod Mainz = 0). Compiles to the equivalent {@link Ref} at eval time
 * (see `normalizeScopeEntry` in src/permissions/scope.ts), so `ref.campus("koblenz")` is identical.
 */
export type ScopeSugar =
  | { group: string }
  | { campus: string }
  | { groupType: string }
  | { department: string };

/**
 * One entry of a scoped grant's `scope`:
 *
 * - a **logical group key** (`string`) — a group managed by this tool. Group dimension only.
 * - a **typed logical ref** ({@link ScopeSugar} / {@link Ref}, #98) — the portable form for the other
 *   dimensions this tool can name by key: campuses (`cdb_station`), group types (`cdb_gruppentyp`)
 *   and departments (`cdb_bereich`, a read-only catalog — referenceable but never declarable).
 * - a **raw numeric dataId** (`number`, #49 escape hatch) — the only form for dimensions whose values
 *   are not resources at all (`cc_securitylevel`, `ccm_data_category`, `oauth_client`, …).
 */
export type ScopeEntry = string | number | Ref | ScopeSugar;

export type Grant = string | { right: string; scope: ScopeEntry[] };

export interface DesiredPermission {
  key: string;
  domainType: DomainType;
  /**
   * The permission domain. A raw number (escape hatch), or a logical {@link Ref} (#20) the per-host
   * resolver turns into a numeric id at plan time (see `buildPermissionPlan`). Only ever a number
   * downstream of resolution.
   */
  domainId: number | Ref;
  grants: Grant[];
}
