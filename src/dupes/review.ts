/**
 * Interactive review loop for `ct dupes review`. All terminal I/O goes through {@link ReviewIO}
 * so the loop can be driven by a script in tests.
 */
import { CtApiError } from "../api/ctClient.js";
import { MERGE_CONFIRMED } from "./finance.js";
import {
  loadMergePreview,
  loadPerson,
  loadRawPerson,
  markNoDuplicate,
  mergePersons,
  type DupesClient,
  type MergeDiffEntry,
  type PersonRecord,
  type RelationshipTypeIds,
} from "./ct.js";
import type { Redactor } from "./redact.js";
import type { DupesStore, ScanFile, StoredCandidate } from "./store.js";

export interface ReviewIO {
  ask(question: string): Promise<string>;
  print(line: string): void;
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
  now?: () => Date;
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

export type ReviewOutcome = "merged" | "dismissed" | "skipped" | "pending" | "quit";

/** ChurchTools proposes the older person as the original: older creation date, else the lower id. */
export function olderOf(a: PersonRecord, b: PersonRecord): PersonRecord {
  if (a.createdDate !== "" && b.createdDate !== "" && a.createdDate !== b.createdDate) {
    return a.createdDate < b.createdDate ? a : b;
  }
  return a.id < b.id ? a : b;
}

/**
 * Build the merge PATCH body: the original's person object, with the duplicate's value for every
 * field the operator took from the duplicate. `email` is a read-only display key in the diff; the
 * person object carries addresses in `emails`, so that is the key written.
 */
export function buildMergeBody(
  original: Record<string, unknown>,
  duplicate: Record<string, unknown>,
  diffs: readonly MergeDiffEntry[],
  fromDuplicate: ReadonlySet<string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...original };
  for (const d of diffs) {
    if (d.key === null || !fromDuplicate.has(d.key)) continue;
    if (d.key === "email") {
      if (duplicate.emails !== undefined) body.emails = duplicate.emails;
      continue;
    }
    body[d.key] = d.key in duplicate ? duplicate[d.key] : d.new;
  }
  return body;
}

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
  if (cand.markedDuplicate) io.print("  (already tagged as duplicate in ChurchTools)");

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
  const older = olderOf(a, b);
  const mark = (p: PersonRecord): string => (p.id === older.id ? " (older, ChurchTools' default)" : "");
  io.print(`  A${mark(a)}`);
  io.print(`  B${mark(b)}`);
  const olderKey = older.id === a.id ? "a" : "b";
  const keep =
    (await askChoice(io, `  Keep which person (the survivor)? [a/b, Enter = ${olderKey}] > `, [
      "a",
      "b",
      "",
    ])) || olderKey;
  const survivor = keep === "a" ? a : b;
  const loser = keep === "a" ? b : a;

  let preview;
  let originalRaw: Record<string, unknown>;
  let duplicateRaw: Record<string, unknown>;
  try {
    [preview, originalRaw, duplicateRaw] = await Promise.all([
      loadMergePreview(client, survivor.id, loser.id),
      loadRawPerson(client, survivor.id),
      loadRawPerson(client, loser.id),
    ]);
  } catch (err) {
    store.audit({ action: "merge-error", survivingId: survivor.id, loserId: loser.id }, now());
    io.print(
      `  Could not load the merge preview${err instanceof CtApiError ? ` (HTTP ${err.status})` : ""}.`,
    );
    return "pending";
  }

  const fromDuplicate = new Set<string>();
  let leading = survivor.optigem;
  let orphaned = loser.optigem;
  const bothOptigem = survivor.optigem !== "" && loser.optigem !== "";
  if (bothOptigem && survivor.optigem !== loser.optigem) {
    const pick = await askChoice(
      io,
      `  Both have an Optigem ID. Leading ID: [s]urvivor (${r.value(survivor.optigem)}) or [l]oser (${r.value(loser.optigem)}) > `,
      ["s", "l"],
    );
    if (pick === "l") {
      [leading, orphaned] = [loser.optigem, survivor.optigem];
      fromDuplicate.add(deps.optigemField);
    }
  }
  const optigemDecided = bothOptigem && survivor.optigem !== loser.optigem;

  const choosable = preview.personDiff.filter(
    (d): d is MergeDiffEntry & { key: string } =>
      d.key !== null && !(optigemDecided && d.key === deps.optigemField),
  );
  if (choosable.length > 0) io.print("  Fields that differ (default: keep the survivor's value):");
  for (const d of choosable) {
    const v = (x: string): string => (x === "" ? "(empty)" : r.value(x));
    const ans = await askChoice(
      io,
      `    ${d.name}: survivor=${v(d.old)}  other=${v(d.new)}  keep [s]urvivor's or [o]ther's? [Enter = s] > `,
      ["s", "o", ""],
    );
    if (ans === "o") fromDuplicate.add(d.key);
  }
  const applied: MergeDiffEntry[] = [...choosable];
  if (optigemDecided) {
    applied.push({
      key: deps.optigemField,
      name: "Optigem ID",
      old: survivor.optigem,
      new: loser.optigem,
      printDiff: true,
    });
  }
  const body = buildMergeBody(originalRaw, duplicateRaw, applied, fromDuplicate);

  const gd = preview.groupsDiff;
  io.print(`  ${gd.new.length} group(s) move over, ${gd.both.length} shared.`);
  io.print(
    `  Plan: keep person ${r.id(survivor.id)}, merge person ${r.id(loser.id)} into it through ChurchTools' ` +
      "merge API (memberships and related records move over).",
  );
  if ((await askChoice(io, "  Proceed? [y/n] > ", ["y", "n"])) === "n") return "skipped";

  store.audit(
    {
      action: "merge-started",
      survivingId: survivor.id,
      loserId: loser.id,
      personDiff: preview.personDiff.map((d) => ({ key: d.key, original: d.old, duplicate: d.new })),
      groupsDiff: {
        original: gd.old.map((g) => g.id),
        duplicate: gd.new.map((g) => g.id),
        both: gd.both.map((g) => g.id),
      },
      fromDuplicate: [...fromDuplicate],
    },
    now(),
  );
  try {
    await mergePersons(client, survivor.id, loser.id, body);
  } catch (err) {
    store.audit({ action: "merge-error", survivingId: survivor.id, loserId: loser.id }, now());
    io.print(`  Merge failed${err instanceof CtApiError ? ` (HTTP ${err.status})` : ""}.`);
    return "pending";
  }

  let duplicateStillExists = false;
  let duplicateCheckFailed = false;
  try {
    await loadPerson(client, loser.id, deps.optigemField);
    duplicateStillExists = true;
    io.print("  ChurchTools kept the duplicate record (it was not deleted); the merge is recorded anyway.");
  } catch (err) {
    if (!(err instanceof CtApiError && err.status === 404)) {
      duplicateCheckFailed = true;
      io.print("  Merged, but could not check whether the duplicate record still exists.");
    }
  }
  store.audit(
    {
      action: MERGE_CONFIRMED,
      survivingId: survivor.id,
      loserId: loser.id,
      leadingOptigemId: bothOptigem ? leading : "",
      orphanedOptigemId: bothOptigem ? orphaned : "",
      mergedBy: deps.operator.name,
      mergedById: deps.operator.id,
      ...(duplicateStillExists ? { duplicateStillExists: true } : {}),
      ...(duplicateCheckFailed ? { duplicateCheckFailed: true } : {}),
    },
    now(),
  );
  io.print("  Merged.");
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
