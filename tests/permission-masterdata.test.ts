import { describe, expect, it } from "vitest";
import { fetchChurchAuthMasterData, permissionRightDefinitions } from "../src/permissions/masterdata.js";

describe("shared ChurchAuth master-data decoder", () => {
  it("unwraps and normalizes the right catalog once for reports and catalog capture", async () => {
    const calls: Array<[string, Record<string, string>]> = [];
    const master = await fetchChurchAuthMasterData({
      legacyPostForm: async <T>(query: string, form: Record<string, string>) => {
        calls.push([query, form]);
        return {
          data: {
            auth_table: {
              churchwiki: {
                "view category": {
                  id: "502",
                  datenfeld: " cc_wikicategory ",
                  bezeichnung: "Wiki sehen ",
                  isRevocable: 1,
                },
              },
            },
            churchauth: { status: { "2": { id: 2, bezeichnung: "Aktiv" } } },
          },
        } as T;
      },
    });

    expect(calls).toEqual([["churchauth/ajax", { func: "getMasterData" }]]);
    expect(permissionRightDefinitions(master)).toEqual([
      {
        authId: 502,
        module: "churchwiki",
        technicalName: "view category",
        description: "Wiki sehen ",
        scopeField: "cc_wikicategory",
        revocable: true,
      },
    ]);
    expect(master.churchauth).toHaveProperty("status");
  });

  it("fails loudly when auth_table is missing", async () => {
    await expect(
      fetchChurchAuthMasterData({ legacyPostForm: async <T>() => ({ data: {} }) as T }),
    ).rejects.toThrow(/no data\.auth_table/);
  });

  it("rejects malformed right ids instead of letting consumers disagree", () => {
    expect(() =>
      permissionRightDefinitions({
        auth_table: { churchdb: { view: { bezeichnung: "Ansehen" } } },
      }),
    ).toThrow(/has no numeric id/);
  });

  it("warns and keeps the first definition when an authId is aliased under two modules", () => {
    const warnings: string[] = [];
    const definitions = permissionRightDefinitions(
      {
        auth_table: {
          churchdb: { view: { id: 1, bezeichnung: "Ansehen" } },
          churchwiki: { view: { id: 1, bezeichnung: "Ansehen (Wiki)" } },
        },
      },
      (message) => warnings.push(message),
    );

    // `ct permissions catalog --refresh` is the only way to act on a staleness warning; a
    // duplicate must degrade, not kill it.
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({ authId: 1, module: "churchdb" });
    expect(warnings).toEqual([
      "churchauth/ajax getMasterData reports authId 1 twice; ignoring the later definition at churchwiki:view.",
    ]);
  });

  it("falls back per field when the response splits the payload across the envelope", async () => {
    const master = await fetchChurchAuthMasterData({
      legacyPostForm: async <T>() =>
        ({
          data: { churchauth: { person: [] } },
          auth_table: { churchdb: { view: { id: 1, bezeichnung: "Ansehen" } } },
        }) as T,
    });

    expect(Object.keys(master.auth_table)).toEqual(["churchdb"]);
    expect(master.churchauth).toEqual({ person: [] });
  });
});
