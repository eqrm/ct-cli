import type { CtClient } from "../api/ctClient.js";

export interface RawChurchAuthRight {
  id?: string | number;
  datenfeld?: string | null;
  bezeichnung?: string | null;
  isRevocable?: boolean | number;
}

export type ChurchAuthMasterDataTable = Record<string, unknown> | unknown[];

export interface ChurchAuthMasterData {
  auth_table: Record<string, Record<string, RawChurchAuthRight>>;
  churchauth?: Record<string, ChurchAuthMasterDataTable>;
}

interface ChurchAuthMasterDataResponse {
  data?: Partial<ChurchAuthMasterData>;
  auth_table?: ChurchAuthMasterData["auth_table"];
  churchauth?: ChurchAuthMasterData["churchauth"];
}

export interface PermissionRightDefinition {
  authId: number;
  module: string;
  technicalName: string;
  description: string;
  scopeField: string | null;
  revocable: boolean;
}

/**
 * Read and validate the one legacy master-data payload shared by catalog capture and reports.
 * Keeping the envelope handling here prevents the two consumers from silently drifting apart.
 */
export async function fetchChurchAuthMasterData(
  client: Pick<CtClient, "legacyPostForm">,
): Promise<ChurchAuthMasterData> {
  const response = await client.legacyPostForm<ChurchAuthMasterDataResponse>("churchauth/ajax", {
    func: "getMasterData",
  });
  const master = response.data ?? response;
  if (!master.auth_table || typeof master.auth_table !== "object" || Array.isArray(master.auth_table)) {
    throw new Error(
      "Unexpected response from churchauth/ajax getMasterData: no data.auth_table. The legacy endpoint " +
        "or its shape may have changed.",
    );
  }
  return {
    auth_table: master.auth_table,
    ...(master.churchauth ? { churchauth: master.churchauth } : {}),
  };
}

/** Normalize auth_table once for every consumer of the ChurchAuth master-data response. */
export function permissionRightDefinitions(master: ChurchAuthMasterData): PermissionRightDefinition[] {
  const result: PermissionRightDefinition[] = [];
  const seen = new Set<number>();
  for (const [module, rights] of Object.entries(master.auth_table)) {
    for (const [technicalName, raw] of Object.entries(rights ?? {})) {
      const authId = Number(raw.id);
      if (!Number.isFinite(authId)) {
        throw new Error(
          `Unexpected response from churchauth/ajax getMasterData: ${module}:${technicalName} has no numeric id.`,
        );
      }
      if (seen.has(authId)) {
        throw new Error(
          `Unexpected response from churchauth/ajax getMasterData: duplicate authId ${authId} ` +
            `at ${module}:${technicalName}.`,
        );
      }
      seen.add(authId);
      const scopeField = raw.datenfeld == null ? "" : String(raw.datenfeld).trim();
      result.push({
        authId,
        module,
        technicalName,
        description: raw.bezeichnung == null ? "" : String(raw.bezeichnung),
        scopeField: scopeField || null,
        revocable: Boolean(raw.isRevocable),
      });
    }
  }
  return result;
}
