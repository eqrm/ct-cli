/**
 * Name, phone and date normalisation for the duplicate detector (`ct dupes`).
 *
 * Pure functions only; no I/O. Digits are KEPT in names on purpose: `Kids1 Muster` and
 * `Kids2 Muster` are different records, and stripping digits collapsed both to `kids`.
 */

/** Lower-case, expand German umlauts, then strip remaining diacritics. */
export function deaccent(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Deaccented name with everything but `a-z 0-9 space -` removed. */
export function cleanName(input: string | null | undefined): string {
  return deaccent(input ?? "")
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a cleaned name into tokens on whitespace and hyphens. */
export function nameTokens(clean: string): string[] {
  return clean.split(/[\s-]+/).filter((t) => t !== "");
}

const PLACEHOLDER = /^(kids?|test|gast|guest|dummy|platzhalter|seat|person)\s*\d*$/i;

/** True for names such as `Kids 3`, `Test`, `Gast2`. */
export function isPlaceholderName(clean: string): boolean {
  return PLACEHOLDER.test(clean);
}

/** Strip a German diminutive ending. */
export function diminutiveStem(word: string): string {
  return word.replace(/(chen|lein|ie|i|y)$/, "");
}

/** Normalised phone key (last 9 digits, at least 7), or null when unusable. */
export function normalizePhone(input: string | null | undefined): string | null {
  let digits = (input ?? "").replace(/\D/g, "");
  digits = digits.replace(/^(00)?49/, "");
  digits = digits.replace(/^0/, "");
  if (digits.length < 7) return null;
  return digits.slice(-9);
}

/** `YYYY-MM-DD` prefix of a date string, or null. */
export function normalizeDate(input: string | null | undefined): string | null {
  const m = /\d{4}-\d{2}-\d{2}/.exec(input ?? "");
  return m ? m[0] : null;
}

/** Plain Levenshtein distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}
