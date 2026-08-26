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
  | { department: string }
  | { securityLevel: string }
  | { commentViewer: string };

/**
 * One entry of a scoped grant's `scope`:
 *
 * - a **logical group key** (`string`) — a group managed by this tool. Group dimension only.
 * - a **typed logical ref** ({@link ScopeSugar} / {@link Ref}, #98) — the portable form for the other
 *   dimensions this tool can name by key: campuses (`cdb_station`), group types (`cdb_gruppentyp`),
 *   departments (`cdb_bereich`, #108), security levels (`cc_securitylevel`, #110) and comment viewers
 *   (`cdb_comment_viewer`, #151). All of them are DECLARABLE resources — every dimension with a
 *   logical form is managed today, so a ref can resolve against the config's own state as well as
 *   against the live catalog.
 * - a **raw numeric dataId** (`number`, #49 escape hatch) — still supported everywhere, and the only
 *   form for dimensions this tool cannot yet address by a host-independent name
 *   (`ccm_data_category`, `oauth_client`, `cc_calcategory`, …).
 */
export type ScopeEntry = string | number | Ref | ScopeSugar;

export type Grant = string | { right: string; scope: ScopeEntry[] };

/**
 * Opt-in partial grant ownership (#102). A declaration normally OWNS its domain outright: every live
 * grant absent from `grants` is revoked. That is the right default and stays the default — but it also
 * means one unmanageable grant makes a whole role instance undeclarable, and on a real instance the
 * blocker is usually module data (calendar categories, HTML templates, wiki categories) sitting next
 * to perfectly expressible structural grants.
 *
 *  - `true`       — keep every live grant this declaration does not mention.
 *  - `string[]`   — keep them only on these scope dimensions (`scopeField`s). The narrow form, and the
 *                   one worth reaching for: an unexpected new grant on a dimension you DO manage still
 *                   shows up as drift instead of being swallowed.
 *
 * Preserved grants are never invisible — the plan renders each one (see `renderPermissionPlan`).
 */
export type PreserveUnknown = boolean | string[];

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
  /** Opt-in escape from whole-domain ownership (#102). Omitted ⇒ strict: undeclared grant → revoke. */
  preserveUnknown?: PreserveUnknown;
}
