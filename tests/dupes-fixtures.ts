/** Shared fictitious fixtures for the `ct dupes` review tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CtApiError } from "../src/api/ctClient.js";
import type { ReviewDeps } from "../src/dupes/actions.js";
import type { DupesClient } from "../src/dupes/ct.js";
import { makeRedactor } from "../src/dupes/redact.js";
import { DupesStore, SCAN_SCHEMA, type ScanFile } from "../src/dupes/store.js";

export const dirs: string[] = [];
export function cleanDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const raw = (id: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  guid: `guid-${id}`,
  firstName: "Erika",
  lastName: "Muster",
  birthday: "1990-05-05",
  optigemId: "",
  emails: [{ id: id * 10, email: `p${id}@example.org`, isDefault: true }],
  campusId: 0,
  statusId: 0,
  meta: { createdDate: `2020-01-0${id}T00:00:00Z` },
  lastLogin: null,
  ...over,
});

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

export interface FakeOpts {
  persons?: Record<number, Record<string, unknown>>;
  patchFails?: boolean;
  stays?: boolean;
  personDiff?: unknown[];
  previewFails?: boolean;
  goneAfterError?: boolean;
  /** Ids that answer 404 from the start. */
  gone?: number[];
}

export interface FakeState {
  merged: Set<number>;
}

/** Fake ChurchTools for persons 1 and 2 (and optionally more). */
export function fakeClient(
  calls: Call[],
  opts: FakeOpts = {},
  state: FakeState = { merged: new Set() },
): DupesClient {
  const persons: Record<number, Record<string, unknown>> = opts.persons ?? {
    1: raw(1),
    2: raw(2, { lastName: "Beispiel", mobile: "0151" }),
  };
  return {
    get: async (path: string) => {
      const m = /^\/persons\/(\d+)$/.exec(path);
      if (m) {
        const id = Number(m[1]);
        if (opts.gone?.includes(id) || state.merged.has(id)) {
          if (!(opts.stays && state.merged.has(id))) throw new CtApiError("gone", 404, {});
        }
        return persons[id];
      }
      if (/^\/persons\/(\d+)\/merge\/(\d+)$/.test(path)) {
        if (opts.previewFails) throw new CtApiError("nope", 500, {});
        return {
          personDiff: opts.personDiff ?? [
            { key: "lastName", name: "Nachname", old: "Muster", new: "Beispiel", printDiff: true },
            { key: "guid", name: "GUID", old: "guid-1", new: "guid-2", printDiff: false },
            { key: null, name: "Something", old: "x", new: "y", printDiff: true },
          ],
          groupsDiff: { old: [{ id: 10 }], new: [{ id: 11 }, { id: 12 }], both: [{ id: 13 }] },
        };
      }
      if (path === "/person/masterdata") {
        return {
          campuses: [{ id: 0, name: "Hauptcampus" }],
          statuses: [{ id: 0, name: "Mitglied" }],
          sexes: [],
        };
      }
      if (/^\/persons\/\d+\/relationships$/.test(path)) return [];
      throw new Error(`unexpected GET ${path}`);
    },
    getAll: async (path: string) => {
      if (path === "/persons") {
        return {
          data: Object.values(persons).map((p) => ({
            id: p.id,
            firstName: p.firstName,
            lastName: p.lastName,
          })),
        };
      }
      throw new Error(`unexpected getAll ${path}`);
    },
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      const m = /^\/persons\/(\d+)\/merge\/(\d+)$/.exec(path);
      if (method === "PATCH" && m) {
        if (opts.patchFails) {
          if (opts.goneAfterError) state.merged.add(Number(m[2]));
          throw new CtApiError("boom", 500, {});
        }
        state.merged.add(Number(m[2]));
      }
      return {};
    },
  } as unknown as DupesClient;
}

export function setup(opts: FakeOpts = {}, redact = false) {
  const base = mkdtempSync(join(tmpdir(), "ct-dupes-review-"));
  dirs.push(base);
  const store = new DupesStore("https://example.church.tools", { CT_DUPES_DIR: base });
  const scan: ScanFile = {
    schema: SCAN_SCHEMA,
    host: "https://example.church.tools",
    scannedAt: "2026-01-01T00:00:00.000Z",
    personsScanned: 2,
    candidates: [
      {
        a: 1,
        b: 2,
        score: 90,
        tier: "T1",
        matchClass: "exact",
        signals: [],
        source: "detector",
        state: "open",
      },
      {
        a: 3,
        b: 4,
        score: 50,
        tier: "T3",
        matchClass: "fuzzy",
        signals: [],
        source: "detector",
        state: "open",
      },
    ],
  };
  const calls: Call[] = [];
  const state: FakeState = { merged: new Set() };
  const deps: ReviewDeps = {
    client: fakeClient(calls, opts, state),
    store,
    host: "https://example.church.tools",
    redactor: makeRedactor(redact, "secret"),
    optigemField: "optigemId",
    types: { noDuplicate: 4, duplicate: 7 },
    operator: { id: 99, name: "Op Erator" },
    labels: { campusId: new Map([[0, "Hauptcampus"]]), statusId: new Map([[0, "Mitglied"]]) },
    now: () => new Date("2026-02-01T10:00:00.000Z"),
  };
  return { deps, scan, store, calls, state };
}

export const patches = (calls: Call[]): Call[] => calls.filter((c) => c.method === "PATCH");
