/**
 * A right absent from THIS host's catalog is a host difference, not a config error (#178).
 *
 * One config serves an estate whose instances do not all have the same modules installed. Before
 * this, a declared right the active catalog did not define aborted the whole plan: 13 of 113 rights
 * did not exist on dev (Flow and Report are not installed there), so planning dev failed entirely —
 * including for the 100 rights that do apply. `ct` already handles the mirror case exactly the right
 * way (a LIVE grant whose authId the catalog cannot name is reported and left untouched, never
 * revoked); this pins the same posture in the declaring direction.
 *
 * The oracle for "is this a real right?" is ct's BUNDLED catalog, which is why every test here loads
 * a per-instance capture first: without one, the active catalog IS the bundled one and "missing here"
 * and "missing everywhere" are the same statement.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { buildPermissionPlan, desiredTuples } from "../src/permissions/plan.js";
import {
  CATALOG,
  catalogVerdict,
  scopeFieldVerdict,
  setStrictCatalog,
  useBundledCatalog,
  useCatalog,
} from "../src/permissions/catalog.js";
import { evaluateConfig } from "../src/config/context.js";
import type { State } from "../src/state/state.js";

/** A right the bundled catalog defines — the stand-in for `jpmFlowManager:*` on a Flow-less host. */
const ABSENT_HERE = "churchgroup:administer groups";
/** A dimension the bundled catalog defines, for the `preserveUnknown` half of the same story. */
const ABSENT_DIMENSION_HERE = "cdb_comment_viewer";

const state: State = { version: 1, host: "h", resources: {} };

/**
 * A per-instance capture standing in for eqrm-dev: it has ONE right, and deliberately not the one
 * the config below declares.
 */
function useHostCatalogWithout(): void {
  useCatalog(
    {
      $meta: {
        capturedFrom: "dev.church.tools",
        ctVersion: "3.137.0-RC13",
        capturedAt: "2026-09-21",
        rightCount: 1,
      },
      "churchcore:administer settings": { authId: 1, scopeField: null, revocable: true, desc: "" },
    },
    { perInstance: true },
  );
}

afterEach(() => {
  useBundledCatalog(); // the catalog is process-global — never leak a capture into another test
});

describe("catalogVerdict", () => {
  it("separates a host difference from a typo", () => {
    useHostCatalogWithout();
    expect(catalogVerdict("churchcore:administer settings")).toBe("known");
    expect(catalogVerdict(ABSENT_HERE)).toBe("host-missing");
    // Nothing ct has ever seen defines this, so it is a typo or a right ChurchTools deleted —
    // the case the hard error was written for, and the one `churchreport:edit masterdata` is.
    expect(catalogVerdict("jpmFlowManager:nosuchright")).toBe("unknown");
  });

  it("keeps every absence fatal while the bundled catalog is the active one", () => {
    // No capture loaded: "absent from the active catalog" and "absent from every catalog" are the
    // same statement, so a repo that has not captured its host's catalog sees today's behaviour.
    expect(CATALOG[ABSENT_HERE]).toBeDefined();
    expect(catalogVerdict("churchgroup:nosuchright")).toBe("unknown");
  });

  it("makes --strict-catalog fatal again", () => {
    useHostCatalogWithout();
    setStrictCatalog(true);
    expect(catalogVerdict(ABSENT_HERE)).toBe("unknown");
    expect(scopeFieldVerdict(ABSENT_DIMENSION_HERE)).toBe("unknown");
  });
});

describe("desiredTuples", () => {
  it("emits no tuple for a right this host does not have, and reports it", () => {
    useHostCatalogWithout();
    const skips: unknown[] = [];
    const tuples = desiredTuples(
      {
        key: "mitglied",
        domainType: "group_role",
        domainId: 5,
        grants: ["churchcore:administer settings", ABSENT_HERE],
      },
      state,
      new Set(),
      new Map(),
      (skip) => skips.push(skip),
    );
    // No tuple is the whole point: no tuple means no PUT, and because the host cannot carry a live
    // row under a name it does not define, nothing lands in toDelete either.
    expect(tuples).toEqual([{ authId: 1, dataId: [], type: "grant" }]);
    expect(skips).toEqual([{ domainType: "group_role", key: "mitglied", name: ABSENT_HERE, kind: "right" }]);
  });

  it("still throws for a name no catalog defines", () => {
    useHostCatalogWithout();
    expect(() =>
      desiredTuples(
        { key: "mitglied", domainType: "group_role", domainId: 5, grants: ["churchreport:no such right"] },
        state,
      ),
    ).toThrow(/Unknown permission/);
  });

  it("throws for a host-missing right under --strict-catalog", () => {
    useHostCatalogWithout();
    setStrictCatalog(true);
    expect(() =>
      desiredTuples({ key: "mitglied", domainType: "group_role", domainId: 5, grants: [ABSENT_HERE] }, state),
    ).toThrow(/Unknown permission/);
  });
});

describe("buildPermissionPlan", () => {
  it("plans everything else and warns once per skipped declaration", async () => {
    useHostCatalogWithout();
    const client = { get: vi.fn(async () => []) };
    const { items, warnings } = await buildPermissionPlan(client as never, state, [
      {
        key: "mitglied",
        domainType: "group_role",
        domainId: 5,
        grants: ["churchcore:administer settings", ABSENT_HERE],
      },
    ]);
    // The declaration is still planned — the skip costs it one grant, not the whole role.
    expect(items[0]?.diff.toPut).toEqual([{ authId: 1, dataId: [], type: "grant" }]);
    const skipWarning = warnings.find((w) => w.includes(ABSENT_HERE));
    expect(skipWarning).toMatch(/group_role "mitglied"/);
    expect(skipWarning).toMatch(/absent from this host's permission catalog/);
    // Both catalogs are named: without the bundled half the warning reads like a typo.
    expect(skipWarning).toMatch(/3\.137\.0-RC13/);
    expect(skipWarning).toMatch(/bundled catalog/);
    expect(skipWarning).toMatch(/never granted, never revoked/);
    expect(skipWarning).toMatch(/--strict-catalog/);
  });

  it("does not revoke the live grants of a domain whose declaration was partly skipped", async () => {
    useHostCatalogWithout();
    // The host grants authId 1 directly; the declaration names it plus a right the host lacks.
    const client = {
      get: vi.fn(async () => [
        {
          domainType: "group_role",
          domainId: 5,
          authId: 1,
          dataId: null,
          type: "grant",
          meta: { modifiedPid: 9 },
        },
      ]),
    };
    const { items } = await buildPermissionPlan(client as never, state, [
      {
        key: "mitglied",
        domainType: "group_role",
        domainId: 5,
        grants: ["churchcore:administer settings", ABSENT_HERE],
      },
    ]);
    expect(items[0]?.diff.toPut).toEqual([]);
    expect(items[0]?.diff.toDelete).toEqual([]);
  });

  it("reports a preserveUnknown dimension this host has no right for", async () => {
    useHostCatalogWithout();
    const client = { get: vi.fn(async () => []) };
    const { warnings } = await buildPermissionPlan(client as never, state, [
      {
        key: "mitglied",
        domainType: "group_role",
        domainId: 5,
        grants: ["churchcore:administer settings"],
        preserveUnknown: [ABSENT_DIMENSION_HERE],
      },
    ]);
    const warning = warnings.find((w) => w.includes(ABSENT_DIMENSION_HERE));
    expect(warning).toMatch(/preserveUnknown/);
    expect(warning).toMatch(/can preserve nothing here/);
  });
});

describe("config evaluation", () => {
  it("accepts a preserveUnknown dimension that exists on the other host", async () => {
    useHostCatalogWithout();
    const { permissions } = await evaluateConfig((ct) => {
      ct.groupRole({
        key: "mitglied",
        id: 5,
        grants: ["churchcore:administer settings"],
        preserveUnknown: [ABSENT_DIMENSION_HERE],
      });
    });
    // Kept verbatim in the declaration: the verdict belongs to the plan, which can name the host.
    expect(permissions[0]?.preserveUnknown).toEqual([ABSENT_DIMENSION_HERE]);
  });

  it("still rejects a dimension no catalog defines", async () => {
    useHostCatalogWithout();
    await expect(
      evaluateConfig((ct) => {
        ct.groupRole({
          key: "mitglied",
          id: 5,
          grants: ["churchcore:administer settings"],
          preserveUnknown: ["cdb_nosuchdimension"],
        });
      }),
    ).rejects.toThrow(/no right in the permission catalog scopes by/);
  });
});
