/**
 * Interactive review loop for `ct dupes review`. All terminal I/O goes through {@link ReviewIO}
 * so the loop can be driven by a script in tests.
 */
import { CtApiError } from "../api/ctClient.js";
import { MERGE_CONFIRMED } from "./finance.js";
import {
  findSharedGroups,
  loadMembership,
  loadPerson,
  markDuplicate,
  markNoDuplicate,
  patchMembership,
  removeMembership,
  type DupesClient,
  type PersonRecord,
  type RelationshipTypeIds,
} from "./ct.js";
import { buildMembershipPatch, diffMemberships, type MembershipDiff } from "./memberships.js";
import type { Redactor } from "./redact.js";
import type { DupesStore, ScanFile, StoredCandidate } from "./store.js";

export interface ReviewIO {
  ask(question: string): Promise<string>;
  print(line: string): void;
  openUrl(url: string): Promise<void>;
}

export interface ReviewDeps {
  client: DupesClient;
  store: DupesStore;
  host: string;
  redactor: Redactor;
  optigemField: string;
  types: RelationshipTypeIds;
  operator: { id: number; name: string };
  io: ReviewIO;
  /** URL template with `{host}`, `{original}`, `{duplicate}`. */
  mergeUrl: string;
  now?: () => Date;
}

export const DEFAULT_MERGE_URL = "{host}/persons/duplicates";

export function renderMergeUrl(template: string, host: string, original: number, duplicate: number): string {
  const values: Record<string, string> = {
    host: host.replace(/\/+$/, ""),
    original: String(original),
    duplicate: String(duplicate),
  };
  // A function replacer, so `$` in a value is taken literally.
  return template.replace(/\{(host|original|duplicate)\}/g, (_m, k: string) => values[k]!);
}

/** Rows of the side-by-side view: label plus both values. */
export function comparisonRows(a: PersonRecord, b: PersonRecord): Array<[string, string, string]> {
  return [
    ["first name", a.firstName, b.firstName],
    ["last name", a.lastName, b.lastName],
    ["nickname", a.nickname, b.nickname],
    ["email", a.email, b.email],
    ["mobile", a.mobile, b.mobile],
    ["phone", a.phonePrivate, b.phonePrivate],
    ["birthday", a.birthday ?? "", b.birthday ?? ""],
    ["street", a.street, b.street],
    ["zip / city", `${a.zip} ${a.city}`.trim(), `${b.zip} ${b.city}`.trim()],
    ["sex id", a.sexId === null ? "" : String(a.sexId), b.sexId === null ? "" : String(b.sexId)],
    [
      "campus id",
      a.campusId === null ? "" : String(a.campusId),
      b.campusId === null ? "" : String(b.campusId),
    ],
    [
      "status id",
      a.statusId === null ? "" : String(a.statusId),
      b.statusId === null ? "" : String(b.statusId),
    ],
    ["optigem id", a.optigem, b.optigem],
    ["created", a.createdDate.slice(0, 10), b.createdDate.slice(0, 10)],
    ["last edited", a.lastEditedDate.slice(0, 10), b.lastEditedDate.slice(0, 10)],
    ["last login", a.lastLogin.slice(0, 10), b.lastLogin.slice(0, 10)],
  ];
}

const DATE_ROWS = new Set(["created", "last edited", "last login"]);

function show(r: Redactor, label: string, v: string): string {
  return DATE_ROWS.has(label) ? v : r.value(v);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function renderComparison(a: PersonRecord, b: PersonRecord, r: Redactor): string[] {
  const lines = [`  ${pad("", 12)} ${pad(`A (#${r.id(a.id)})`, 26)} B (#${r.id(b.id)})`];
  for (const [label, va, vb] of comparisonRows(a, b)) {
    const same = va === vb ? "=" : " ";
    lines.push(`${same} ${pad(label, 12)} ${pad(show(r, label, va), 26)} ${show(r, label, vb)}`);
  }
  return lines;
}

async function askChoice(io: ReviewIO, question: string, allowed: string[]): Promise<string> {
  for (;;) {
    const ans = (await io.ask(question)).trim().toLowerCase();
    if (allowed.includes(ans)) return ans;
  }
}

function fmtDiff(d: MembershipDiff, r: Redactor): string {
  const v = (x: string): string => (x === "" ? "(empty)" : r.value(x));
  return `${d.label}: A=${v(d.survivor)}  B=${v(d.loser)}`;
}

export type ReviewOutcome = "merged" | "dismissed" | "skipped" | "pending" | "quit";

/** Handle one candidate. Returns what happened. */
export async function reviewCandidate(deps: ReviewDeps, cand: StoredCandidate): Promise<ReviewOutcome> {
  const { client, io, redactor: r, store } = deps;
  const now = deps.now ?? ((): Date => new Date());
  let a: PersonRecord;
  let b: PersonRecord;
  try {
    [a, b] = await Promise.all([
      loadPerson(client, cand.a, deps.optigemField),
      loadPerson(client, cand.b, deps.optigemField),
    ]);
  } catch (err) {
    if (err instanceof CtApiError && err.status === 404) {
      io.print("  One of the two persons no longer exists; skipping.");
      return "skipped";
    }
    throw err;
  }
  io.print("");
  for (const line of renderComparison(a, b, r)) io.print(line);
  const shared = await findSharedGroups(client, a.id, b.id);
  io.print(
    `  shared groups: ${shared.dynamic.length} dynamic, ${shared.static.length} static` +
      (cand.markedDuplicate ? "   (already tagged as duplicate in ChurchTools)" : ""),
  );
  const label = (g: { groupId: number; title: string }): string =>
    r.enabled ? `group ${r.id(g.groupId)}` : `${g.title || "(no name)"} (id ${g.groupId})`;
  for (const g of shared.dynamic) io.print(`    [dynamic] ${label(g)}`);
  for (const g of shared.static) io.print(`    [static]  ${label(g)}`);

  const action = await askChoice(io, "  [m]erge  [n]o duplicate  [s]kip  [q]uit > ", ["m", "n", "s", "q"]);
  if (action === "q") return "quit";
  if (action === "s") return "skipped";

  if (action === "n") {
    try {
      await markNoDuplicate(client, a.id, b.id, deps.types);
      store.audit({ action: "no-duplicate", a: a.id, b: b.id, writeBack: "ok" }, now());
      io.print("  Marked as not a duplicate in ChurchTools.");
    } catch (err) {
      store.audit({ action: "no-duplicate", a: a.id, b: b.id, writeBack: "failed" }, now());
      io.print("  The decision is saved locally, but ChurchTools did not accept the write-back.");
      if (err instanceof CtApiError) io.print(`  HTTP ${err.status}`);
    }
    return "dismissed";
  }

  // --- merge ---
  const keep = await askChoice(io, "  Keep which person (the survivor)? [a/b] > ", ["a", "b"]);
  const survivor = keep === "a" ? a : b;
  const loser = keep === "a" ? b : a;
  let leading = survivor.optigem;
  let orphaned = loser.optigem;
  if (survivor.optigem !== "" && loser.optigem !== "" && survivor.optigem !== loser.optigem) {
    const pick = await askChoice(
      io,
      `  Both have an Optigem ID. Leading ID: [s]urvivor (${r.value(survivor.optigem)}) or [l]oser (${r.value(loser.optigem)}) > `,
      ["s", "l"],
    );
    if (pick === "l") [leading, orphaned] = [loser.optigem, survivor.optigem];
    io.print("  Select this ID on ChurchTools' merge page too.");
  }
  const finance = survivor.optigem !== "" && loser.optigem !== "";

  // Plan the group work.
  const picks: Array<{
    groupId: number;
    diffs: MembershipDiff[];
    choices: Record<string, "survivor" | "loser">;
    snapshot: unknown;
  }> = [];
  for (const g of shared.static) {
    const [ms, ml] = await Promise.all([
      loadMembership(client, g.groupId, survivor.id),
      loadMembership(client, g.groupId, loser.id),
    ]);
    const diffs = diffMemberships(ms, ml);
    const choices: Record<string, "survivor" | "loser"> = {};
    const conflicts = diffs.filter((d) => d.conflict);
    if (conflicts.length > 0) io.print(`  Static group ${r.id(g.groupId)}: conflicting member fields`);
    for (const d of conflicts) {
      const ans = await askChoice(io, `    ${fmtDiff(d, r)}  keep [s]urvivor's or [l]oser's? > `, ["s", "l"]);
      choices[d.key] = ans === "l" ? "loser" : "survivor";
    }
    picks.push({ groupId: g.groupId, diffs, choices, snapshot: ml });
  }
  io.print(
    `  Plan: keep ${r.id(survivor.id)}, drop ${r.id(loser.id)} from ${shared.dynamic.length} dynamic and ` +
      `${shared.static.length} static shared group(s), then open ChurchTools' merge page.`,
  );
  if ((await askChoice(io, "  Proceed? [y/n] > ", ["y", "n"])) === "n") return "skipped";

  store.audit(
    {
      action: "merge-started",
      survivingId: survivor.id,
      loserId: loser.id,
      loserSnapshot: {
        optigem: loser.optigem,
        memberships: picks.map((p) => ({ groupId: p.groupId, m: p.snapshot })),
      },
    },
    now(),
  );
  try {
    for (const g of shared.dynamic) {
      await removeMembership(client, g.groupId, loser.id);
      store.audit({ action: "dynamic-group-removal", groupId: g.groupId, personId: loser.id }, now());
      io.print(`  Removed ${r.id(loser.id)} from dynamic group ${r.id(g.groupId)}.`);
    }
    for (const p of picks) {
      const body = buildMembershipPatch(p.diffs, p.choices);
      if (body) await patchMembership(client, p.groupId, survivor.id, body);
      await removeMembership(client, p.groupId, loser.id);
      store.audit(
        { action: "static-group-merge", groupId: p.groupId, survivorPatch: body, choices: p.choices },
        now(),
      );
      io.print(`  Merged memberships in static group ${r.id(p.groupId)}.`);
    }
  } catch (err) {
    store.audit({ action: "merge-error", survivingId: survivor.id, loserId: loser.id }, now());
    io.print(
      `  Group clean-up failed${err instanceof CtApiError ? ` (HTTP ${err.status})` : ""}; stopping before the merge page.`,
    );
    io.print("  Changes made before the failure stay applied; see the audit log (merge-started) to restore.");
    return "pending";
  }

  try {
    const created = await markDuplicate(client, survivor.id, loser.id, deps.types);
    store.audit({ action: "duplicate-tagged", survivingId: survivor.id, loserId: loser.id, created }, now());
  } catch (err) {
    store.audit({ action: "merge-error", survivingId: survivor.id, loserId: loser.id }, now());
    io.print(
      `  Could not tag the pair as "Dublette"${err instanceof CtApiError ? ` (HTTP ${err.status})` : ""}; ` +
        "it may not appear on ChurchTools' duplicate page.",
    );
  }
  const url = renderMergeUrl(deps.mergeUrl, deps.host, survivor.id, loser.id);
  io.print(
    r.enabled
      ? "  Opening ChurchTools' duplicate page (URL hidden)."
      : `  Open (copy if no browser opens): ${url}`,
  );
  io.print(
    `  On that page: tab "Dublette", search for ${r.name(survivor.firstName, survivor.lastName)}, ` +
      'check that Original is the survivor (else use "Original und Duplikat tauschen")' +
      (finance ? `, and pick Optigem ID ${r.value(leading)}.` : "."),
  );
  try {
    await io.openUrl(url);
  } catch {
    io.print("  Could not open a browser; open the page manually.");
  }
  for (;;) {
    const done = await askChoice(io, "  Merge finished in ChurchTools? [y/n] > ", ["y", "n"]);
    if (done === "n") {
      store.audit({ action: "merge-pending", survivingId: survivor.id, loserId: loser.id }, now());
      io.print(
        "  Note: the group changes above are already applied in ChurchTools; the loser's previous " +
          "memberships are in the audit log (merge-started).",
      );
      return "pending";
    }
    try {
      await loadPerson(client, loser.id, deps.optigemField);
      io.print("  The second person still exists in ChurchTools.");
      if ((await askChoice(io, "  Record the merge anyway? [y/n] > ", ["y", "n"])) === "n") continue;
    } catch (err) {
      if (!(err instanceof CtApiError && err.status === 404)) throw err;
    }
    break;
  }
  store.audit(
    {
      action: MERGE_CONFIRMED,
      survivingId: survivor.id,
      loserId: loser.id,
      leadingOptigemId: finance ? leading : "",
      orphanedOptigemId: finance ? orphaned : "",
      mergedBy: deps.operator.name,
      mergedById: deps.operator.id,
    },
    now(),
  );
  return "merged";
}

/** Walk the open candidates, best score first. Persists state after every decision. */
export async function runReview(
  deps: ReviewDeps,
  scan: ScanFile,
  limit?: number,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = { merged: 0, dismissed: 0, skipped: 0, pending: 0 };
  const open = scan.candidates.filter((c) => c.state === "open");
  const total = limit ? Math.min(limit, open.length) : open.length;
  let n = 0;
  for (const cand of open.slice(0, total)) {
    n++;
    deps.io.print(`\n[${n}/${total}] ${cand.tier} score ${cand.score} ${cand.matchClass} (${cand.source})`);
    const outcome = await reviewCandidate(deps, cand);
    if (outcome === "quit") break;
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    if (outcome === "merged") cand.state = "merged";
    if (outcome === "dismissed") cand.state = "dismissed";
    deps.store.saveScan(scan);
  }
  return counts;
}
