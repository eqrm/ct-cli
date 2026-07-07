/**
 * Dependency ordering for apply/destroy.
 *
 * Apply order follows the ChurchTools dependency tiers: base metadata first,
 * then groups, then the things that reference groups (hierarchy links, roles,
 * permissions), then dynamic-group rulesets. Within a tier, explicit
 * dependencies (a group's parent) are honoured via topological sort. Destroy
 * runs in the exact reverse.
 */
import type { DesiredResource } from "./types.js";

/** Lower tier is applied first. Delete runs highest tier first. */
export const TYPE_TIER: Record<string, number> = {
  campus: 0,
  "group-type": 0,
  "group-status": 0,
  "age-group": 0,
  "target-group": 0,
  "relationship-type": 0,
  group: 1,
  "group-hierarchy": 2,
  "group-role": 3,
  permission: 4,
  "dynamic-group": 5,
};

export function tierOf(type: string): number {
  return TYPE_TIER[type] ?? 0;
}

/**
 * Whether `type` has a declared apply tier. Every type the config DSL can emit
 * MUST be here (locked by a test), so an unknown type is a registration bug —
 * not something to silently order as tier 0.
 */
export function isKnownType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(TYPE_TIER, type);
}

/**
 * Return logical keys in apply order. Stable: ties break by tier, then by the
 * original declaration order. Throws on a dependency cycle.
 */
export function orderKeys(resources: DesiredResource[]): string[] {
  const byKey = new Map(resources.map((r, i) => [r.key, { r, i }]));
  const indegree = new Map<string, number>(resources.map((r) => [r.key, 0]));
  const successors = new Map<string, string[]>(resources.map((r) => [r.key, []]));

  for (const r of resources) {
    for (const dep of r.dependsOn) {
      if (!byKey.has(dep)) {
        continue; // dependency outside the managed set — nothing to order against
      }
      successors.get(dep)!.push(r.key);
      indegree.set(r.key, (indegree.get(r.key) ?? 0) + 1);
    }
  }

  const ready = resources.filter((r) => (indegree.get(r.key) ?? 0) === 0).map((r) => r.key);
  const order: string[] = [];

  const priority = (key: string): [number, number] => {
    const entry = byKey.get(key)!;
    return [tierOf(entry.r.type), entry.i];
  };

  while (ready.length > 0) {
    ready.sort((a, b) => {
      const [ta, ia] = priority(a);
      const [tb, ib] = priority(b);
      return ta - tb || ia - ib;
    });
    const key = ready.shift()!;
    order.push(key);
    for (const next of successors.get(key)!) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
      }
    }
  }

  if (order.length !== resources.length) {
    const cyclic = resources.map((r) => r.key).filter((k) => !order.includes(k));
    throw new Error(`Dependency cycle among: ${cyclic.join(", ")}`);
  }
  return order;
}
