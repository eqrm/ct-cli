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

  it("rejects malformed and duplicate right ids instead of letting consumers disagree", () => {
    expect(() =>
      permissionRightDefinitions({
        auth_table: { churchdb: { view: { bezeichnung: "Ansehen" } } },
      }),
    ).toThrow(/has no numeric id/);

    expect(() =>
      permissionRightDefinitions({
        auth_table: {
          churchdb: { view: { id: 1 } },
          churchwiki: { view: { id: 1 } },
        },
      }),
    ).toThrow(/duplicate authId 1/);
  });
});
