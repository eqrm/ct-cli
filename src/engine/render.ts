/**
 * Human-readable, Terraform-style rendering of a {@link Plan}.
 * Machine consumers should use the plan object directly (`ct plan --json`).
 */
import pc from "picocolors";
import { type Plan, type PlanAction, summarize } from "./types.js";
import { isPendingRef, refLabel } from "../resolve/refs.js";

function sigil(action: PlanAction): string {
  switch (action) {
    case "create":
      return pc.green("+");
    case "update":
      return pc.yellow("~");
    case "delete":
      return pc.red("-");
    default:
      return " ";
  }
}

function fmt(value: unknown): string {
  if (value === undefined) return "(none)";
  // A pending reference (#20): its target is created in this same apply, so its id is unknown until
  // then. Render it like the permission scope pending marker instead of a raw sentinel object.
  if (isPendingRef(value)) return `<${refLabel(value.__pendingRef)} (created this apply)>`;
  return JSON.stringify(value);
}

export function renderPlan(plan: Plan): string {
  const changed = plan.items.filter((i) => i.action !== "no-op");
  const drifted = plan.items.filter((i) => i.drift && i.drift.length > 0);
  const stale = plan.items.filter((i) => i.note === "stale");
  const unresolved = plan.items.filter((i) => i.note === "unresolved-type");
  const fetchFailed = plan.items.filter((i) => i.note === "fetch-failed");
  const lines: string[] = [];

  if (
    changed.length === 0 &&
    drifted.length === 0 &&
    stale.length === 0 &&
    unresolved.length === 0 &&
    fetchFailed.length === 0
  ) {
    return pc.green("No changes. Desired state matches ChurchTools.");
  }

  for (const item of changed) {
    const id = item.id !== null ? pc.dim(` (#${item.id})`) : "";
    const note = item.note === "recreate" ? pc.yellow(" [recreate — missing in ChurchTools]") : "";
    lines.push(`  ${sigil(item.action)} ${item.type}.${item.key}${id}${note}`);
    for (const c of item.changes) {
      lines.push(
        item.action === "create"
          ? `      ${c.field}: ${fmt(c.to)}`
          : `      ${c.field}: ${fmt(c.from)} -> ${fmt(c.to)}`,
      );
      // A group-type change is a migration through a different endpoint, and it MOVES MEMBERSHIPS.
      // Rendering it as a plain field line would under-report what applying it does (#171), so the
      // mapping is spelled out under the field: every role, where it lands, and why.
      if (c.field === "groupTypeId" && item.groupTypeMigration) {
        lines.push(
          pc.dim(`        via POST /groups/${item.id}/grouptype — role mapping (members follow their role):`),
        );
        for (const entry of item.groupTypeMigration.entries) {
          const members = entry.members === 1 ? "1 member" : `${entry.members} members`;
          lines.push(
            pc.dim(
              `          ${entry.fromName} -> ${entry.toName}  (${members}, matched by ${entry.reason})`,
            ),
          );
        }
      }
    }
  }

  if (drifted.length > 0) {
    lines.push("");
    lines.push(pc.yellow("Drift detected (changed in ChurchTools since adoption):"));
    for (const item of drifted) {
      for (const c of item.drift ?? []) {
        lines.push(
          `  ! ${item.type}.${item.key} (#${item.id}): ${c.field} = ${fmt(c.to)} (last known ${fmt(c.from)})`,
        );
      }
    }
  }

  if (stale.length > 0) {
    lines.push("");
    lines.push(pc.yellow("Stale state entries (already gone from ChurchTools — prune from the state file):"));
    for (const item of stale) {
      lines.push(`  ! ${item.type}.${item.key} (#${item.id})`);
    }
  }

  if (unresolved.length > 0) {
    lines.push("");
    lines.push(pc.yellow("Unresolved types (no registry entry — not diffed, left untouched):"));
    for (const item of unresolved) {
      lines.push(`  ? ${item.type}.${item.key} (#${item.id})`);
    }
  }

  if (fetchFailed.length > 0) {
    lines.push("");
    lines.push(
      pc.yellow("Fetch failed (could not read from ChurchTools — diff unavailable, left untouched):"),
    );
    for (const item of fetchFailed) {
      lines.push(`  ? ${item.type}.${item.key} (#${item.id}) — fetch failed (${item.detail ?? "error"})`);
    }
  }

  const s = summarize(plan);
  lines.push("");
  // The summary line is the part that gets pasted into a PR comment and approved, so it must never
  // read as a complete plan when it is not (#126): a partial plan carries its own caveat inline.
  const incomplete =
    fetchFailed.length > 0
      ? pc.yellow(` INCOMPLETE — ${fetchFailed.length} resource(s) could not be read.`)
      : "";
  lines.push(
    pc.bold(`Plan: ${s.create} to create, ${s.update} to update, ${s.delete} to delete.`) + incomplete,
  );
  return lines.join("\n");
}
