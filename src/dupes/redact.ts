/**
 * Stable pseudonyms for `--redact`. The same value always maps to the same short tag within one
 * machine (keyed with a local secret), so equal values stay visibly equal, but nothing can be
 * reversed or guessed from the output.
 */
import { createHmac } from "node:crypto";

export interface Redactor {
  readonly enabled: boolean;
  /** A person id, as shown to the operator. */
  id(id: number | string): string;
  /** Any personal value (name, email, optigem id, ...). Empty stays empty. */
  value(v: string | null | undefined): string;
  /** A "First Last" display name. */
  name(first: string | null | undefined, last: string | null | undefined): string;
  /** An ids-in-text mask for error text (digit runs become `#`). */
  text(s: string): string;
}

export function makeRedactor(enabled: boolean, secret: string): Redactor {
  const tag = (kind: string, v: string): string =>
    createHmac("sha256", secret).update(`${kind}\0${v}`).digest("hex").slice(0, 4);
  return {
    enabled,
    id: (id) => (enabled ? `P-${tag("id", String(id))}` : String(id)),
    value: (v) => {
      const s = v ?? "";
      if (!enabled || s === "") return s;
      return `~${tag("v", s)}`;
    },
    name: (first, last) => {
      const s = `${first ?? ""} ${last ?? ""}`.trim();
      if (!enabled || s === "") return s;
      return `Name-${tag("n", s)}`;
    },
    text: (s) => (enabled ? s.replace(/\d+/g, "#") : s),
  };
}
