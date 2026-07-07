/**
 * Human-readable, Terraform-style rendering of a {@link Plan}.
 * Machine consumers should use the plan object directly (`ct plan --json`).
 */
import pc from "picocolors";
import { type Plan, type PlanAction, summarize } from "./types.js";

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
  return value === undefined ? "(none)" : JSON.stringify(value);
}

export function renderPlan(plan: Plan): string {
  const changed = plan.items.filter((i) => i.action !== "no-op");
  const drifted = plan.items.filter((i) => i.drift && i.drift.length > 0);
  const stale = plan.items.filter((i) => i.note === "stale");
  const unresolved = plan.items.filter((i) => i.note === "unresolved-type");
  const lines: string[] = [];

  if (changed.length === 0 && drifted.length === 0 && stale.length === 0 && unresolved.length === 0) {
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

  const s = summarize(plan);
  lines.push("");
  lines.push(pc.bold(`Plan: ${s.create} to create, ${s.update} to update, ${s.delete} to delete.`));
  return lines.join("\n");
}
