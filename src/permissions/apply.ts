/**
 * Apply a permission plan: PUT each new grant, DELETE each removed tuple.
 * Idempotent — re-running against an unchanged instance diffs to empty and
 * this issues no requests. Every path is guarded through `assertNotPeople`
 * as belt-and-suspenders atop the structural-only registry.
 */
import type { CtClient } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import { assertNotPeople } from "../engine/guard.js";
import { mapConcurrent } from "../util/concurrency.js";
import type { PermissionPlanItem } from "./plan.js";
import type { GrantTuple } from "./grants.js";
import { reresolveTuple } from "./scope.js";
import { pendingRef, refLabel } from "../resolve/refs.js";
import {
  reresolvePendingValue,
  resolvePendingGroupRoleDomain,
  type GroupRoleRowCache,
} from "../resolve/resolver.js";
import { formatError } from "../ui.js";

/** How many permission tuples to write at once. Tuples are independent rows, so a modest fan-out is safe. */
const WRITE_CONCURRENCY = 6;

function body(t: GrantTuple): Record<string, unknown> {
  if (t.pending) {
    // A pending tuple's dataId is unknown until it is re-resolved against post-execute state.
    // Reaching here means re-resolution was skipped — refuse rather than emit a silent GLOBAL grant.
    throw new Error(
      `Grant scoped to "${t.scopeKey}" was not re-resolved before apply — refusing to write it without a dataId.`,
    );
  }
  const b: Record<string, unknown> = { authId: t.authId, type: t.type };
  if (t.dataId.length) b.dataId = t.dataId; // omit when unscoped
  return b;
}

/** One tuple write, flattened out of the per-domain diff so all writes share one concurrency pool. */
interface WriteOp {
  method: "PUT" | "DELETE";
  path: string;
  tuple: GrantTuple;
}

export interface FailedWrite {
  method: "PUT" | "DELETE";
  path: string;
  authId: number;
  dataId: number[];
  message: string;
}

export interface PermissionApplyResult {
  granted: number;
  deleted: number;
  /** Tuples whose write threw, so the caller can report a clean resumable summary (#35 item 14). */
  failed: FailedWrite[];
}

/**
 * Apply a permission plan. When `state` is provided, each scoped grant's dataId is RE-RESOLVED
 * against it just before the PUT — `state` here is the POST-execute state (executePlan has upserted
 * every created/recreated group), so grants are always written with fresh ids and a group created in
 * the same apply gets its real id (#29, #33.3). Without `state`, tuples are written as-is.
 *
 * Writes fan out at {@link WRITE_CONCURRENCY} (independent rows). Result counts are collected in the
 * flattened op order — deterministic regardless of completion order — and a write that throws is
 * captured in `failed` instead of aborting the batch, so the command can print a resumable summary.
 */
export async function applyPermissionPlan(
  items: PermissionPlanItem[],
  client: Pick<CtClient, "request"> & Partial<Pick<CtClient, "get" | "getAll">>,
  state?: State,
): Promise<PermissionApplyResult> {
  const ops: WriteOp[] = [];
  /** Shared across items so several pending group_role domains on one group cost a single fetch. */
  const roleLists: GroupRoleRowCache = new Map();
  // Concurrent writes are race-free only because evaluateConfig rejects two declarations targeting
  // the same (domainType, domainId) — so all ops for a path come from ONE item's disjoint diff.
  // Programmatic callers bypassing evaluateConfig must uphold that invariant themselves.
  for (const item of items) {
    // A pending domain (#69) names a resource created THIS run: its numeric id is only known after
    // executePlan, so complete it against the POST-execute state now. Requires `state`: a pending
    // domain can never be applied statelessly.
    let domainId = item.domainId;
    if (item.pendingDomain) {
      if (!state) {
        throw new Error(
          `Pending permission domain ${refLabel(item.pendingDomain)} ("${item.key}") cannot be applied ` +
            `without post-execute state — it names a resource created in the same run.`,
        );
      }
      const site = `${item.domainType} "${item.key}".domainId`;
      if (item.pendingDomain.kind === "group-role") {
        // The one pending domain a state lookup cannot finish (#106): a (group, role) PAIRING id is
        // not the group's id — it lives on the freshly created group's own role list, so completing
        // it takes a live fetch. Needs a reading client; the real CtClient always has one, and the
        // failure mode if a caller passes a write-only double is a clear error, not a wrong domain.
        if (!client.get) {
          throw new Error(
            `Pending permission domain ${refLabel(item.pendingDomain)} ("${item.key}") needs to read ` +
              `the created group's role list, but this client cannot GET. Pass a full CtClient.`,
          );
        }
        domainId = await resolvePendingGroupRoleDomain(
          item.pendingDomain,
          state,
          // BIND, don't copy: `CtClient`'s reads are prototype methods that call `this.request` /
          // `this.requestEnvelope` internally, so handing on a bare `{ get: client.get }` detaches
          // them and every pending group_role domain dies with "this.requestEnvelope is not a
          // function" the moment it fetches the role list.
          {
            get: client.get.bind(client),
            ...(client.getAll ? { getAll: client.getAll.bind(client) } : {}),
          },
          site,
          roleLists,
        );
      } else {
        // Every other pending domain (a person status) IS its resource's own id, so the
        // SAME machinery that re-resolves resource pending refs finishes it from state alone.
        domainId = reresolvePendingValue(pendingRef(item.pendingDomain), state) as number;
      }
    }
    const path = `/permissions/${item.domainType}/${domainId}`;
    assertNotPeople(path);
    for (const t of item.diff.toPut) ops.push({ method: "PUT", path, tuple: t });
    for (const t of item.diff.toDelete) ops.push({ method: "DELETE", path, tuple: t });
  }

  const outcomes = await mapConcurrent(ops, WRITE_CONCURRENCY, async (op) => {
    try {
      // toPut tuples may be scoped/pending → re-resolve against post-execute state; toDelete tuples
      // come from actuals (never pending), so pass them through. `body()` guards a stray pending row.
      const b = op.method === "PUT" && state ? body(reresolveTuple(op.tuple, state)) : body(op.tuple);
      await client.request(op.method, op.path, b);
      return { ok: true as const, op };
    } catch (err) {
      // Same formatter the top-level handler uses (#50) so a failed grant's HTTP status + response
      // body reach the resumable summary (#71) instead of just the bare "... failed" text.
      return { ok: false as const, op, message: formatError(err) };
    }
  });

  let granted = 0;
  let deleted = 0;
  const failed: FailedWrite[] = [];
  for (const o of outcomes) {
    if (o.ok) {
      if (o.op.method === "PUT") granted++;
      else deleted++;
    } else {
      failed.push({
        method: o.op.method,
        path: o.op.path,
        authId: o.op.tuple.authId,
        dataId: o.op.tuple.dataId,
        message: o.message,
      });
    }
  }
  return { granted, deleted, failed };
}
