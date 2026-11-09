/**
 * Duplicate-person detector for `ct dupes`. Deterministic, no ML, no I/O.
 *
 * Blocking keys limit which pairs are scored; vetoes reject outright; signals add up to a score;
 * the score maps to a tier (T1 >= 85, T2 60-84, T3 35-59, below 35 is discarded).
 */
import {
  cleanName,
  diminutiveStem,
  isPlaceholderName,
  levenshtein,
  nameTokens,
  normalizeDate,
  normalizePhone,
} from "./normalize.js";

/** The person fields the detector reads. */
export interface DupePerson {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
  email?: string | null;
  mobile?: string | null;
  phonePrivate?: string | null;
  birthday?: string | null;
  zip?: string | null;
  street?: string | null;
  sexId?: number | null;
  /** Value of the configured Optigem field (see `--optigem-field`). */
  optigem?: string | null;
}

export type MatchClass =
  "exact" | "nameswap" | "middlename" | "firsttoken" | "shortform" | "diminutive" | "fuzzy" | "none";

export type Tier = "T1" | "T2" | "T3";

export interface Candidate {
  /** Smaller person id first. */
  a: number;
  b: number;
  score: number;
  tier: Tier;
  /** Best first-name evidence; `none` when the pair matched on contact data only. */
  matchClass: MatchClass | "ct";
  signals: string[];
  /** Where the pair came from. */
  source: "detector" | "ct" | "both";
  /** ChurchTools already tagged this pair as a confirmed duplicate. */
  markedDuplicate?: boolean;
}

export const FIRST_NAME_WEIGHTS: Record<Exclude<MatchClass, "none">, number> = {
  exact: 35,
  nameswap: 33,
  middlename: 30,
  firsttoken: 28,
  shortform: 24,
  diminutive: 24,
  fuzzy: 20,
};

export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function tierOf(score: number): Tier | null {
  if (score >= 85) return "T1";
  if (score >= 60) return "T2";
  if (score >= 35) return "T3";
  return null;
}

interface Prep {
  id: number;
  fn: string;
  ft: string[];
  ln: string;
  lt: string[];
  nick: string;
  email: string;
  phones: string[];
  birthday: string | null;
  zip: string;
  street: string;
  sex: number | null;
  optigem: string;
  full: string;
}

function prep(p: DupePerson): Prep {
  const fn = cleanName(p.firstName);
  const ln = cleanName(p.lastName);
  const phones = [normalizePhone(p.mobile), normalizePhone(p.phonePrivate)].filter(
    (x, i, arr): x is string => x !== null && arr.indexOf(x) === i,
  );
  return {
    id: p.id,
    fn,
    ft: nameTokens(fn),
    ln,
    lt: nameTokens(ln),
    nick: cleanName(p.nickname),
    email: (p.email ?? "").trim().toLowerCase(),
    phones,
    birthday: normalizeDate(p.birthday),
    zip: (p.zip ?? "").trim(),
    street: cleanName(p.street),
    sex: p.sexId ? p.sexId : null,
    optigem: (p.optigem ?? "").trim(),
    full: `${fn} ${ln}`.trim(),
  };
}

function subset(a: string[], b: string[]): boolean {
  return a.length > 0 && a.every((t) => b.includes(t));
}

function surnameCompatible(a: Prep, b: Prep): boolean {
  if (a.ln === "" || b.ln === "") return false;
  if (a.ln === b.ln) return true;
  return subset(a.lt, b.lt) || subset(b.lt, a.lt);
}

const ns = (s: string): string => s.replace(/[\s-]/g, "");

function classifyFirstName(a: Prep, b: Prep): { cls: MatchClass; viaNickname: boolean } {
  const none = { cls: "none" as MatchClass, viaNickname: false };
  if (a.fn === "" || b.fn === "") return none;
  const surnameOk = surnameCompatible(a, b);
  if (a.fn === b.ln && a.ln === b.fn && a.fn !== a.ln) return { cls: "nameswap", viaNickname: false };
  if (!surnameOk) return none;
  if (a.fn === b.fn) return { cls: "exact", viaNickname: false };
  if ((a.nick !== "" && (a.nick === b.fn || a.nick === b.nick)) || (b.nick !== "" && b.nick === a.fn)) {
    return { cls: "exact", viaNickname: true };
  }
  // Digits in a first name: only an exact match counts (Kids1 vs Kids2 must not match).
  if (/\d/.test(a.fn) || /\d/.test(b.fn)) return none;
  const [short, long] = ns(a.fn).length <= ns(b.fn).length ? [a, b] : [b, a];
  if (subset(short.ft, long.ft) || subset(long.ft, short.ft))
    return { cls: "middlename", viaNickname: false };
  if (a.ft[0] === b.ft[0]) return { cls: "firsttoken", viaNickname: false };
  const s = ns(short.fn);
  const l = ns(long.fn);
  if (s.length >= 3 && (l.startsWith(s) || l.endsWith(s))) return { cls: "shortform", viaNickname: false };
  const sa = diminutiveStem(ns(a.fn));
  const sb = diminutiveStem(ns(b.fn));
  if (sa === sb && sa.length >= 3) return { cls: "diminutive", viaNickname: false };
  const x = ns(a.fn);
  const y = ns(b.fn);
  if ((sa !== x && sa.length >= 3 && y.startsWith(sa)) || (sb !== y && sb.length >= 3 && x.startsWith(sb))) {
    return { cls: "diminutive", viaNickname: false };
  }
  if (Math.min(x.length, y.length) >= 4 && levenshtein(x, y) <= 2)
    return { cls: "fuzzy", viaNickname: false };
  return none;
}

interface Context {
  emailCount: Map<string, number>;
  phoneCount: Map<string, number>;
  nameCount: Map<string, number>;
}

export interface PairScore {
  score: number;
  matchClass: MatchClass;
  signals: string[];
  veto?: string;
}

function placeholderVeto(p: Prep, ctx: Context): boolean {
  return (
    isPlaceholderName(p.fn) ||
    isPlaceholderName(p.ln) ||
    isPlaceholderName(p.full) ||
    (ctx.nameCount.get(p.full) ?? 0) >= 4
  );
}

function scorePrepared(a: Prep, b: Prep, ctx: Context): PairScore {
  const signals: string[] = [];
  const veto = (reason: string): PairScore => ({ score: 0, matchClass: "none", signals, veto: reason });
  if (placeholderVeto(a, ctx) || placeholderVeto(b, ctx)) return veto("placeholder");
  if (a.birthday && b.birthday && a.birthday !== b.birthday) return veto("birthday");
  if (a.sex !== null && b.sex !== null && a.sex !== b.sex) return veto("sex");

  let score = 0;
  if (a.email !== "" && a.email === b.email) {
    const n = ctx.emailCount.get(a.email) ?? 0;
    if (n <= 2) {
      score += 45;
      signals.push("email-unique");
    } else if (n < 8) {
      score += 12;
      signals.push("email-shared");
    }
  }
  const sharedPhone = a.phones.find((p) => b.phones.includes(p));
  if (sharedPhone !== undefined) {
    const n = ctx.phoneCount.get(sharedPhone) ?? 0;
    if (n <= 2) {
      score += 40;
      signals.push("phone-unique");
    } else if (n < 8) {
      score += 12;
      signals.push("phone-shared");
    }
  }
  if (a.optigem !== "" && a.optigem === b.optigem) {
    score += 30;
    signals.push("optigem");
  }
  if (a.birthday && a.birthday === b.birthday) {
    score += 28;
    signals.push("birthday");
  }
  if (a.zip !== "" && a.zip === b.zip && a.street !== "" && a.street === b.street) {
    score += 18;
    signals.push("address");
  }
  const { cls, viaNickname } = classifyFirstName(a, b);
  if (cls !== "none") {
    score += FIRST_NAME_WEIGHTS[cls];
    signals.push(viaNickname ? "name:nickname" : `name:${cls}`);
  } else if (surnameCompatible(a, b)) {
    score += 6;
    signals.push("surname-only");
  } else {
    score -= 10;
    signals.push("no-name-evidence");
  }
  return { score, matchClass: cls, signals };
}

/** Score one pair outside the detector (used to rate pairs ChurchTools itself suggested). */
export function scorePair(pa: DupePerson, pb: DupePerson, all: readonly DupePerson[]): PairScore {
  return scorePrepared(prep(pa), prep(pb), buildContext(all.map(prep)));
}

function buildContext(preps: Prep[]): Context {
  const emailCount = new Map<string, number>();
  const phoneCount = new Map<string, number>();
  const nameCount = new Map<string, number>();
  for (const p of preps) {
    if (p.email !== "") emailCount.set(p.email, (emailCount.get(p.email) ?? 0) + 1);
    for (const ph of p.phones) phoneCount.set(ph, (phoneCount.get(ph) ?? 0) + 1);
    if (p.full !== "") nameCount.set(p.full, (nameCount.get(p.full) ?? 0) + 1);
  }
  return { emailCount, phoneCount, nameCount };
}

export interface DetectOptions {
  /** Pair keys (see {@link pairKey}) that carry a suppressing relationship. */
  suppressed?: ReadonlySet<string>;
}

/** Blocking keys of one person. */
function blockingKeys(p: Prep, ctx: Context, surnameCount: Map<string, number>): string[] {
  const keys: string[] = [];
  if (p.email !== "" && (ctx.emailCount.get(p.email) ?? 0) < 8) keys.push(`em:${p.email}`);
  for (const ph of p.phones) if ((ctx.phoneCount.get(ph) ?? 0) < 8) keys.push(`mo:${ph}`);
  if (p.fn !== "" && p.ln !== "") {
    keys.push(`nn:${p.fn}|${p.ln}`);
    keys.push(`sw:${[p.fn, p.ln].sort().join("|")}`);
  }
  if (p.ln !== "" && p.birthday) keys.push(`lb:${p.ln}:${p.birthday}`);
  if (p.ln !== "" && (surnameCount.get(p.ln) ?? 0) <= 40) keys.push(`ln:${p.ln}`);
  // Compound surnames also block on each part, so "Muster Beispiel" meets "Beispiel".
  if (p.lt.length > 1) {
    for (const t of p.lt) if ((surnameCount.get(t) ?? 0) <= 40) keys.push(`ln:${t}`);
  }
  if (p.zip !== "" && p.street !== "") keys.push(`ad:${p.zip}:${p.street}`);
  return keys;
}

/** Find duplicate candidates among `persons` (callers pass active persons only). */
export function detect(persons: readonly DupePerson[], options: DetectOptions = {}): Candidate[] {
  const preps = persons.map(prep);
  const byId = new Map(preps.map((p) => [p.id, p]));
  const ctx = buildContext(preps);
  const surnameCount = new Map<string, number>();
  for (const p of preps) if (p.ln !== "") surnameCount.set(p.ln, (surnameCount.get(p.ln) ?? 0) + 1);

  const blocks = new Map<string, number[]>();
  for (const p of preps) {
    for (const k of blockingKeys(p, ctx, surnameCount)) {
      const list = blocks.get(k);
      if (list) list.push(p.id);
      else blocks.set(k, [p.id]);
    }
  }
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const ids of blocks.values()) {
    if (ids.length > 40) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = pairKey(ids[i]!, ids[j]!);
        if (seen.has(key)) continue;
        seen.add(key);
        if (options.suppressed?.has(key)) continue;
        const res = scorePrepared(byId.get(ids[i]!)!, byId.get(ids[j]!)!, ctx);
        if (res.veto) continue;
        const tier = tierOf(res.score);
        if (!tier) continue;
        out.push({
          a: Math.min(ids[i]!, ids[j]!),
          b: Math.max(ids[i]!, ids[j]!),
          score: res.score,
          tier,
          matchClass: res.matchClass,
          signals: res.signals,
          source: "detector",
        });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
}
