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

/** ChurchTools' merge UI proposes the person with the lower id as the original. */
export function olderOf(a: PersonRecord, b: PersonRecord): PersonRecord {
  return a.id < b.id ? a : b;
}

interface EmailEntry {
  id?: unknown;
  email?: string;
  isDefault?: boolean;
  [k: string]: unknown;
}

const emailKey = (e: EmailEntry): string => String(e.email ?? "").toLowerCase();

/**
 * Union of both address lists: the original's entries stay as they are, the duplicate's addresses
 * that are not present yet (case-insensitive) are appended without their `id`. With
 * `preferDuplicate` the duplicate's default (else first) address becomes the only default.
 */
export function mergeEmails(
  original: unknown,
  duplicate: unknown,
  preferDuplicate: boolean,
): { emails: EmailEntry[]; primary: string | null } | null {
  const o = Array.isArray(original) ? (original as EmailEntry[]) : null;
  const d = Array.isArray(duplicate) ? (duplicate as EmailEntry[]) : null;
  if (!o && !d) return null;
  const emails: EmailEntry[] = (o ?? []).map((e) => ({ ...e }));
  const known = new Set(emails.map(emailKey));
  for (const e of d ?? []) {
    if (known.has(emailKey(e))) continue;
    known.add(emailKey(e));
    const copy = { ...e };
    delete copy.id;
    emails.push(copy);
  }
  let primary: string | null = null;
  if (preferDuplicate && d && d.length > 0) {
    const pick = d.find((e) => e.isDefault === true) ?? d[0]!;
    primary = String(pick.email ?? "");
    for (const e of emails) e.isDefault = emailKey(e) === primary.toLowerCase();
  }
  return { emails, primary };
}

/**
 * Build the merge PATCH body: the original's person object with the duplicate's value for every
 * field the operator took from the duplicate. Addresses are never replaced: `emails` is the union
 * of both lists (see {@link mergeEmails}); `email` is only a display key. A chosen field that the
 * duplicate object does not carry is skipped and reported in `warnings`.
 */
export function buildMergeBody(
  original: Record<string, unknown>,
  duplicate: Record<string, unknown>,
  diffs: readonly MergeDiffEntry[],
  fromDuplicate: ReadonlySet<string>,
): { body: Record<string, unknown>; warnings: string[] } {
  const body: Record<string, unknown> = { ...original };
  const warnings: string[] = [];
  const merged = mergeEmails(original.emails, duplicate.emails, fromDuplicate.has("email"));
  if (merged) {
    body.emails = merged.emails;
    if (merged.primary !== null && "email" in body) body.email = merged.primary;
  }
  for (const d of diffs) {
    if (d.key === null || d.key === "email" || !fromDuplicate.has(d.key)) continue;
    if (d.key in duplicate) body[d.key] = duplicate[d.key];
    else warnings.push(`${d.name}: value cannot be carried over automatically, set it in ChurchTools.`);
  }
  return { body, warnings };
}

async function duplicateGone(deps: ReviewDeps, id: number): Promise<boolean | null> {
  try {
    await loadPerson(deps.client, id, deps.optigemField);
    return false;
  } catch (err) {
    return err instanceof CtApiError && err.status === 404 ? true : null;
  }
}

/** A `merge-started` without `merge-confirmed` for this pair, if any. */
function unfinishedMerge(store: DupesStore, a: number, b: number): Record<string, unknown> | null {
  const audit = store.readAudit();
  const same = (e: Record<string, unknown>): boolean =>
    (e.survivingId === a && e.loserId === b) || (e.survivingId === b && e.loserId === a);
  let started: Record<string, unknown> | null = null;
  for (const e of audit) {
    if (!same(e)) continue;
    if (e.action === "merge-started") started = e;
    if (e.action === MERGE_CONFIRMED) started = null;
  }
  return started;
}

/** Handle one candidate. Returns what happened. */
export async function reviewCandidate(deps: ReviewDeps, cand: StoredCandidate): Promise<ReviewOutcome> {
  const { client, io, redactor: r, store } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const confirm = (
    survivingId: number,
    loserId: number,
    leading: string,
    orphaned: string,
    extra: Record<string, unknown>,
  ): void => {
    store.audit(
      {
        action: MERGE_CONFIRMED,
        survivingId,
        loserId,
        leadingOptigemId: leading,
        orphanedOptigemId: orphaned,
        mergedBy: deps.operator.name,
        mergedById: deps.operator.id,
        ...extra,
      },
      now(),
    );
  };
  let a: PersonRecord;
  let b: PersonRecord;
  try {
    [a, b] = await Promise.all([
      loadPerson(client, cand.a, deps.optigemField),
      loadPerson(client, cand.b, deps.optigemField),
    ]);
  } catch (err) {
    if (err instanceof CtApiError && err.status === 404) {
      const started = unfinishedMerge(store, cand.a, cand.b);
      if (started && (await duplicateGone(deps, Number(started.loserId))) === true) {
        confirm(
          Number(started.survivingId),
          Number(started.loserId),
          typeof started.leadingOptigemId === "string" ? started.leadingOptigemId : "",
          typeof started.orphanedOptigemId === "string" ? started.orphanedOptigemId : "",
          { recovered: true },
        );
        io.print("  An earlier merge of this pair had not been recorded; recorded it now.");
        return "merged";
      }
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

  // The Optigem ID is decided here, never by the generic field prompt: a lone ID is always kept.
  const bothOptigem = survivor.optigem !== "" && loser.optigem !== "";
  let leading = survivor.optigem !== "" ? survivor.optigem : loser.optigem;
  let orphaned = bothOptigem ? loser.optigem : "";
  if (bothOptigem && survivor.optigem !== loser.optigem) {
    const pick = await askChoice(
      io,
      `  Both have an Optigem ID. Leading ID: [s]urvivor (${r.value(survivor.optigem)}) or [l]oser (${r.value(loser.optigem)}) > `,
      ["s", "l"],
    );
    if (pick === "l") [leading, orphaned] = [loser.optigem, survivor.optigem];
  }

  const fromDuplicate = new Set<string>();
  const choosable = preview.personDiff.filter(
    (d): d is MergeDiffEntry & { key: string } => d.key !== null && d.key !== deps.optigemField,
  );
  if (choosable.length > 0)
    io.print("  Fields that differ (default: the non-empty value, else the survivor's):");
  for (const d of choosable) {
    const v = (x: string): string => (x === "" ? "(empty)" : r.value(x));
    const def = d.old === "" && d.new !== "" ? "o" : "s";
    const ans =
      (await askChoice(
        io,
        `    ${d.name}: survivor=${v(d.old)}  other=${v(d.new)}  keep [s]urvivor's or [o]ther's? [Enter = ${def}] > `,
        ["s", "o", ""],
      )) || def;
    if (ans === "o") fromDuplicate.add(d.key);
  }
  const applyChoices = (original: Record<string, unknown>): ReturnType<typeof buildMergeBody> => {
    const res = buildMergeBody(original, duplicateRaw, choosable, fromDuplicate);
    if (leading !== "") res.body[deps.optigemField] = leading;
    return res;
  };
  for (const w of applyChoices(originalRaw).warnings) io.print(`  ${w}`);

  const gd = preview.groupsDiff;
  io.print(`  ${gd.new.length} group(s) move over, ${gd.both.length} shared.`);
  io.print(
    `  Plan: keep person ${r.id(survivor.id)}, merge person ${r.id(loser.id)} into it through ChurchTools' ` +
      "merge API (memberships and related records move over).",
  );
  if ((await askChoice(io, "  Proceed? [y/n] > ", ["y", "n"])) === "n") return "skipped";

  // Re-read the original right before writing so concurrent edits are not overwritten.
  let body: Record<string, unknown>;
  try {
    body = applyChoices(await loadRawPerson(client, survivor.id)).body;
  } catch (err) {
    store.audit({ action: "merge-error", survivingId: survivor.id, loserId: loser.id }, now());
    io.print(`  Could not re-read the survivor${err instanceof CtApiError ? ` (HTTP ${err.status})` : ""}.`);
    return "pending";
  }

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
      leadingOptigemId: leading,
      orphanedOptigemId: orphaned,
    },
    now(),
  );
  try {
    await mergePersons(client, survivor.id, loser.id, body);
  } catch (err) {
    store.audit({ action: "merge-error", survivingId: survivor.id, loserId: loser.id }, now());
    io.print(`  Merge failed${err instanceof CtApiError ? ` (HTTP ${err.status})` : ""}.`);
    if ((await duplicateGone(deps, loser.id)) === true) {
      io.print("  The duplicate no longer exists, so the merge went through; recorded.");
      confirm(survivor.id, loser.id, leading, orphaned, { afterError: true });
      return "merged";
    }
    return "pending";
  }

  const gone = await duplicateGone(deps, loser.id);
  if (gone === false) {
    io.print("  ChurchTools kept the duplicate record (it was not deleted); the merge is recorded anyway.");
  } else if (gone === null) {
    io.print("  Merged, but could not check whether the duplicate record still exists.");
  }
  confirm(survivor.id, loser.id, leading, orphaned, {
    ...(gone === false ? { duplicateStillExists: true } : {}),
    ...(gone === null ? { duplicateCheckFailed: true } : {}),
  });
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
