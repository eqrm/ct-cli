import type { CtClient } from "../api/ctClient.js";
import { warn } from "../ui.js";

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
  // The fallback is per FIELD, not per envelope: instances have been seen answering with a `data`
  // object that carries only part of the payload, the rest sitting at the top level. Picking the
  // envelope first and then reading every field out of it would reject those.
  const authTable = response.data?.auth_table ?? response.auth_table;
  if (!authTable || typeof authTable !== "object" || Array.isArray(authTable)) {
    throw new Error(
      "Unexpected response from churchauth/ajax getMasterData: no data.auth_table. The legacy endpoint " +
        "or its shape may have changed.",
    );
  }
  const churchauth = response.data?.churchauth ?? response.churchauth;
  return {
    auth_table: authTable,
    ...(churchauth ? { churchauth } : {}),
  };
}

/**
 * Normalize auth_table once for every consumer of the ChurchAuth master-data response.
 * `onDuplicate` is injectable so tests can assert the warning without capturing stderr.
 */
export function permissionRightDefinitions(
  master: ChurchAuthMasterData,
  onDuplicate: (message: string) => void = warn,
): PermissionRightDefinition[] {
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
        // An instance whose plugin set aliases one right under two modules must not break
        // `ct permissions catalog --refresh` — that command is the only way to act on the
        // staleness warning. Keep the first definition and say what was dropped.
        onDuplicate(
          `churchauth/ajax getMasterData reports authId ${authId} twice; ignoring the later ` +
            `definition at ${module}:${technicalName}.`,
        );
        continue;
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
