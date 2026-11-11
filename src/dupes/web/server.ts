/**
 * Browser UI for `ct dupes review`: a local HTTP server modelled on ChurchTools' "Dubletten
 * überprüfen" page, with the extras of ct dupes (shared group clean-up, Optigem, audit).
 *
 * The server listens on 127.0.0.1 only, on a random port. Every API call must carry a random
 * per-run token in the `X-Ct-Dupes-Token` header (the browser gets it in the URL fragment, which
 * is never sent to a server) and a `Host` header naming that exact address, so other pages in the
 * browser can neither read the data (no CORS headers, a custom header needs a preflight) nor drive
 * a merge, and DNS rebinding fails. The page itself carries no data.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CtApiError } from "../../api/ctClient.js";
import {
  executeMerge,
  formatValue,
  emailLabel,
  emailTypes,
  isMasterValue,
  loadPair,
  markNotDuplicate,
  recoverUnrecordedMerge,
  type MergeResult,
  type PairData,
  type ReviewDeps,
} from "../actions.js";
import { financeMerges, toCsv } from "../finance.js";
import { itemDiffers, setItemChoice, type SharedGroup } from "../groups.js";
import {
  canMergeBoth,
  differs,
  optigemOutcome,
  setChoice,
  unionOf,
  type MergeModel,
  type Side,
} from "../merge-model.js";
import type { ScanFile, StoredCandidate } from "../store.js";
import { PAGE_HTML } from "./page.js";

export interface PersonSummary {
  first: string;
  last: string;
  created?: string;
  login?: string;
}

/** ChurchTools' German field names; the merge preview sometimes reports only the key. */
const LABEL: Record<string, string> = {
  title: "Titel",
  firstName: "Vorname",
  lastName: "Nachname",
  nickname: "Spitzname",
  birthName: "Geburtsname",
  sexId: "Geschlecht",
  birthday: "Geburtstag",
  birthplace: "Geburtsort",
  nationalityId: "Nationalität",
  familyStatusId: "Familienstand",
  weddingDate: "Hochzeitstag",
  job: "Beruf",
  street: "Straße",
  addition: "Adresszusatz",
  zip: "PLZ",
  city: "Ort",
  country: "Land",
  phonePrivate: "Telefon privat",
  phoneWork: "Telefon geschäftlich",
  mobile: "Mobil",
  fax: "Fax",
  campusId: "Campus",
  statusId: "Status",
  departmentIds: "Bereich",
};

const SECTION: Record<string, string> = {
  sexId: "Informationen",
  birthday: "Informationen",
  birthplace: "Informationen",
  nationalityId: "Informationen",
  familyStatusId: "Informationen",
  weddingDate: "Informationen",
  job: "Informationen",
  campusId: "Kategorie",
  statusId: "Kategorie",
  departmentIds: "Bereich",
};

const SIDES: readonly Side[] = ["original", "duplicate", "none", "both"];

interface Card {
  id: string;
  name: string;
  created: string;
  login: string;
}

/** What the page needs for one direction of a pair; display strings only, already redacted. */
export interface PairView {
  key: string;
  original: Card;
  duplicate: Card;
  groupCounts: { original: number; duplicate: number; both: number };
  fields: Array<{
    key: string;
    label: string;
    section: string;
    original: string;
    duplicate: string;
    /** The union of both lists, for list fields (Bereich); empty otherwise. */
    both: string;
    choice: Side;
    differs: boolean;
    optigem: boolean;
  }>;
  emails: Array<{
    index: number;
    label: string;
    address: string;
    /** The Duplikat's contact label when it differs from the Original's (same address). */
    duplicateType: string;
    inOriginal: boolean;
    inDuplicate: boolean;
    include: boolean;
    isDefault: boolean;
  }>;
  groups: Array<{
    id: number;
    title: string;
    dynamic: boolean;
    items: Array<{
      key: string;
      label: string;
      original: string;
      duplicate: string;
      choice: Side;
      differs: boolean;
    }>;
  }>;
}

/** The choices the page sends with a merge. Anything not named keeps the server's default. */
export interface MergeChoices {
  fields?: Record<string, string>;
  emails?: Array<{ index: number; include: boolean; isDefault: boolean }>;
  groups?: Record<string, Record<string, string>>;
}

const day = (s: string | undefined): string => (s ? s.slice(0, 10) : "");

export function pairView(deps: ReviewDeps, p: PairData): PairView {
  const r = deps.redactor;
  const show = (key: string, v: unknown): string => {
    const text = formatValue(key, v, deps.labels);
    return isMasterValue(key, v, deps.labels) ? text : r.value(text);
  };
  const card = (x: PairData["original"]): Card => ({
    id: r.id(x.id),
    name: r.name(x.firstName, x.lastName),
    created: day(x.createdDate),
    login: day(x.lastLogin),
  });
  const gd = p.preview.groupsDiff;
  return {
    key: `${p.original.id}:${p.duplicate.id}`,
    original: card(p.original),
    duplicate: card(p.duplicate),
    groupCounts: { original: gd.old.length, duplicate: gd.new.length, both: gd.both.length },
    fields: p.model.fields.map((f) => ({
      key: f.key,
      label: f.optigem ? f.label : (LABEL[f.key] ?? f.label),
      section: f.optigem ? "Finanzen" : (SECTION[f.key] ?? "Adresse"),
      original: show(f.key, f.original),
      duplicate: show(f.key, f.duplicate),
      both: canMergeBoth(f.key) ? show(f.key, unionOf(f.original, f.duplicate)) : "",
      choice: f.choice,
      differs: differs(f),
      optigem: f.optigem,
    })),
    emails: p.model.emails.map((e, index) => {
      const t = emailTypes(e, deps.labels);
      return {
        index,
        label: emailLabel(e, deps.labels),
        address: r.value(e.address),
        duplicateType: e.originalEntry && e.duplicateEntry && t.duplicate !== t.original ? t.duplicate : "",
        inOriginal: e.originalEntry !== null,
        inDuplicate: e.duplicateEntry !== null,
        include: e.include,
        isDefault: e.isDefault,
      };
    }),
    groups: p.shared.map((g) => ({
      id: g.id,
      title: g.title,
      dynamic: g.dynamic,
      items: g.items.map((i) => ({
        key: i.key,
        label: i.label,
        original: show(i.key, i.original),
        duplicate: show(i.key, i.duplicate),
        choice: i.choice,
        differs: itemDiffers(i),
      })),
    })),
  };
}

/** Apply the page's choices to the loaded model. Unknown keys and sides are ignored. */
export function applyChoices(p: PairData, c: MergeChoices): { model: MergeModel; shared: SharedGroup[] } {
  let model = p.model;
  for (const [key, side] of Object.entries(c.fields ?? {})) {
    if (!SIDES.includes(side as Side) || !model.fields.some((f) => f.key === key)) continue;
    model = setChoice(model, key, side as Side);
  }
  if (Array.isArray(c.emails)) {
    const byIndex = new Map(c.emails.map((e) => [e.index, e]));
    model = {
      ...model,
      emails: model.emails.map((e, i) => {
        const ch = byIndex.get(i);
        return ch ? { ...e, include: ch.include === true, isDefault: ch.isDefault === true } : e;
      }),
    };
  }
  let shared = p.shared;
  for (const [gid, items] of Object.entries(c.groups ?? {})) {
    const g = shared.find((x) => String(x.id) === gid);
    if (!g || g.dynamic) continue;
    for (const [key, side] of Object.entries(items)) {
      if ((side !== "original" && side !== "duplicate") || !g.items.some((i) => i.key === key)) continue;
      shared = setItemChoice(shared, g.id, key, side);
    }
  }
  return { model, shared };
}

/** Result text for the page, in German like the rest of the UI. No person data. */
export function mergeMessages(res: MergeResult): string[] {
  const http = (s: number | null): string => (s ? ` (HTTP ${s})` : "");
  if (res.kind === "merged") {
    return [
      res.duplicateStillExists
        ? "Zusammengeführt. ChurchTools hat das Duplikat aber nicht gelöscht; der Merge ist protokolliert."
        : res.checkFailed
          ? "Zusammengeführt, aber es ließ sich nicht prüfen, ob das Duplikat noch existiert."
          : res.afterError
            ? "Die Anfrage meldete einen Fehler, das Duplikat ist aber weg; der Merge ist protokolliert."
            : "Zusammengeführt.",
      ...res.warnings,
    ];
  }
  const done =
    res.groupsDone && res.groupsDone.length > 0
      ? ` Bereits erledigt (nicht zurückgenommen): Gruppen ${res.groupsDone.map((g) => g.groupId).join(", ")}.`
      : "";
  if (res.stage === "reread")
    return [`Das Original ließ sich nicht neu laden${http(res.status)}. Nichts geändert.`];
  if (res.stage === "groups")
    return [
      `Gruppe ${res.groupId ?? "?"} ließ sich nicht vorbereiten${http(res.status)}. Nicht zusammengeführt.${done}`,
    ];
  const fields =
    res.fields && res.fields.length > 0 ? ` ChurchTools lehnt ab: ${res.fields.join(", ")}.` : "";
  const reason =
    res.reason === "error.forbidden.merge-authorized-person"
      ? " ChurchTools führt keine Person zusammen, die eigene Berechtigungen hat (Login mit Rechten). Erst die Berechtigungen entfernen oder das Paar als „Keine Dublette“ markieren."
      : res.reason
        ? ` Grund laut ChurchTools: ${res.reason}.`
        : "";
  return [
    `Zusammenführen fehlgeschlagen${http(res.status)}.${fields}${reason}${done || " Nichts geändert."}`,
  ];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, "too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  throw new HttpError(400, "bad json");
}

export interface ReviewServer {
  /** The address to open, with the token in the fragment. */
  url: string;
  /** Resolves when the page says it is done or `close()` is called. */
  closed: Promise<void>;
  close(): void;
}

export async function startReviewServer(
  deps: ReviewDeps,
  scan: ScanFile,
  names: Map<number, PersonSummary>,
  opts: { port?: number } = {},
): Promise<ReviewServer> {
  const token = randomBytes(24).toString("base64url");
  const tokenBuf = Buffer.from(token);
  const r = deps.redactor;
  const pairs = new Map<string, PairData>();
  let busy = false;
  let host = "";

  const candidate = (i: unknown): StoredCandidate => {
    const c = typeof i === "number" ? scan.candidates[i] : undefined;
    if (!c) throw new HttpError(404, "no such pair");
    return c;
  };
  /** The older person (lower id) is the Original unless the page swapped the pair. */
  const direction = (c: StoredCandidate, swapped: unknown): [number, number] => {
    const lo = Math.min(c.a, c.b);
    const hi = Math.max(c.a, c.b);
    return swapped === true ? [hi, lo] : [lo, hi];
  };
  const summary = (id: number): Card => {
    const n = names.get(id);
    return {
      id: r.id(id),
      name: n ? r.name(n.first, n.last) : "",
      created: day(n?.created),
      login: day(n?.login),
    };
  };
  const listView = (): unknown => ({
    host: deps.host,
    operator: deps.operator.name,
    redacted: r.enabled,
    candidates: scan.candidates.map((c, i) => {
      const [o, d] = direction(c, false);
      return {
        index: i,
        tier: c.tier,
        score: c.score,
        matchClass: c.matchClass,
        source: c.source,
        state: c.state,
        original: summary(o),
        duplicate: summary(d),
      };
    }),
  });

  async function api(method: string, path: string, body: Record<string, unknown>): Promise<unknown> {
    if (method === "GET" && path === "/api/list") return listView();
    if (method === "POST" && path === "/api/pair") {
      const c = candidate(body.index);
      const [o, d] = direction(c, body.swapped);
      try {
        const p = await loadPair(deps, o, d);
        pairs.set(`${o}:${d}`, p);
        return { pair: pairView(deps, p) };
      } catch (err) {
        if (err instanceof CtApiError && err.status === 404) {
          if (await recoverUnrecordedMerge(deps, c.a, c.b)) {
            c.state = "merged";
            deps.store.saveScan(scan);
            return {
              gone: true,
              message: "Ein früherer Merge dieses Paars war nicht protokolliert; jetzt nachgetragen.",
            };
          }
          return { gone: true, message: "Eine der beiden Personen existiert nicht mehr." };
        }
        throw new HttpError(
          502,
          `Paar ließ sich nicht laden${err instanceof CtApiError ? ` (HTTP ${err.status})` : ""}.`,
        );
      }
    }
    if (method === "POST" && path === "/api/merge") {
      const c = candidate(body.index);
      if (c.state !== "open") throw new HttpError(409, "Dieses Paar ist schon entschieden.");
      const [o, d] = direction(c, body.swapped);
      const p = pairs.get(`${o}:${d}`);
      if (!p) throw new HttpError(409, "Paar zuerst laden.");
      const { model, shared } = applyChoices(p, (body.choices ?? {}) as MergeChoices);
      const res = await executeMerge(deps, p, model, shared);
      if (res.kind === "merged") {
        c.state = "merged";
        deps.store.saveScan(scan);
        pairs.delete(`${o}:${d}`);
      }
      return { ok: res.kind === "merged", messages: mergeMessages(res), optigem: optigemOutcome(model) };
    }
    if (method === "POST" && path === "/api/dismiss") {
      const c = candidate(body.index);
      if (c.state !== "open") throw new HttpError(409, "Dieses Paar ist schon entschieden.");
      const res = await markNotDuplicate(deps, c.a, c.b);
      c.state = "dismissed";
      deps.store.saveScan(scan);
      return {
        ok: true,
        messages: [
          res.ok
            ? 'In ChurchTools als "Keine Dublette" markiert.'
            : `Lokal gespeichert, aber ChurchTools hat das Zurückschreiben abgelehnt${res.status ? ` (HTTP ${res.status})` : ""}.`,
        ],
      };
    }
    if (method === "POST" && path === "/api/finance-export") {
      // The one deliberate real-data output; pseudonyms would make it useless to finance.
      if (r.enabled)
        throw new HttpError(409, "Mit --redact nicht verfügbar. Bitte ct dupes export-finance verwenden.");
      const merges = financeMerges(deps.store.readAudit());
      return {
        count: merges.length,
        filename: `optigem-merges-${new Date().toISOString().slice(0, 10)}.csv`,
        csv: toCsv(merges),
      };
    }
    if (method === "POST" && path === "/api/quit") {
      setImmediate(close);
      return { ok: true };
    }
    throw new HttpError(404, "not found");
  }

  const send = (res: ServerResponse, status: number, type: string, body: string): void => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(body);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.headers.host !== host) return send(res, 421, "text/plain", "wrong host");
      const path = (req.url ?? "/").split("?")[0]!;
      if (req.method === "GET" && path === "/") return send(res, 200, "text/html; charset=utf-8", PAGE_HTML);
      if (!path.startsWith("/api/")) return send(res, 404, "text/plain", "not found");
      const given = Buffer.from(String(req.headers["x-ct-dupes-token"] ?? ""));
      if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf))
        return send(res, 403, "text/plain", "forbidden");
      const method = req.method ?? "GET";
      const write = method === "POST";
      if (write && busy)
        return send(res, 409, "application/json", JSON.stringify({ error: "Eine Aktion läuft noch." }));
      if (write) busy = true;
      try {
        const body = write ? await readJson(req) : {};
        const out = await api(method, path, body);
        send(res, 200, "application/json", JSON.stringify(out));
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        const msg = err instanceof HttpError ? err.message : "Interner Fehler.";
        send(res, status, "application/json", JSON.stringify({ error: msg }));
      } finally {
        if (write) busy = false;
      }
    })();
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((res) => (resolveClosed = res));
  function close(): void {
    server.close(() => resolveClosed());
    server.closeAllConnections();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  return { url: `http://${host}/#${token}`, closed, close };
}
