/**
 * Finance export: merges where both persons carried an Optigem ID. Each row names both persons
 * (ids, names and Optigem IDs as they were before the merge), the surviving person in ChurchTools
 * and the Optigem ID it now carries. Finance decides which ID stays in Optigem and updates it.
 *
 * JSON schema `ct-cli.dupes.optigem-merges/1` (stable; additive changes only within version 1):
 *
 * ```json
 * {
 *   "schema": "ct-cli.dupes.optigem-merges/1",
 *   "generatedAt": "2026-01-31T09:00:00.000Z",
 *   "host": "https://example.church.tools",
 *   "since": "2026-01-01" | null,
 *   "merges": [
 *     {
 *       "survivingPersonId": 123,
 *       "survivingPersonName": "Erika Muster",
 *       "survivingPersonOptigemId": "10001",
 *       "mergedPersonId": 456,
 *       "mergedPersonName": "Erika Beispiel",
 *       "mergedPersonOptigemId": "10002",
 *       "leadingOptigemId": "10001",
 *       "orphanedOptigemId": "10002",
 *       "identicalIds": false,
 *       "mergedAt": "2026-01-30T14:12:00.000Z",
 *       "mergedBy": "Erika Muster"
 *     }
 *   ]
 * }
 * ```
 *
 * The CSV has the same rows with the header
 * `surviving_person_id,surviving_person_name,surviving_person_optigem_id,merged_person_id,merged_person_name,merged_person_optigem_id,leading_optigem_id,orphaned_optigem_id,identical_ids,merged_at,merged_by`.
 *
 * `leadingOptigemId` is the ID the surviving person carries in ChurchTools after the merge,
 * `orphanedOptigemId` the other one. Names and per-person IDs are empty for merges logged before
 * they were recorded.
 */
export const FINANCE_SCHEMA = "ct-cli.dupes.optigem-merges/1";

export interface FinanceMerge {
  survivingPersonId: number;
  survivingPersonName: string;
  survivingPersonOptigemId: string;
  mergedPersonId: number | null;
  mergedPersonName: string;
  mergedPersonOptigemId: string;
  leadingOptigemId: string;
  orphanedOptigemId: string;
  identicalIds: boolean;
  mergedAt: string;
  mergedBy: string;
}

export interface FinanceExport {
  schema: typeof FINANCE_SCHEMA;
  generatedAt: string;
  host: string;
  since: string | null;
  merges: FinanceMerge[];
}

/** Audit action written when the operator confirms CT's merge page is done. */
export const MERGE_CONFIRMED = "merge-confirmed";

/** Extract finance rows from audit lines. */
export function financeMerges(audit: ReadonlyArray<Record<string, unknown>>, since?: string): FinanceMerge[] {
  const out: FinanceMerge[] = [];
  for (const e of audit) {
    if (e.action !== MERGE_CONFIRMED) continue;
    const leading = typeof e.leadingOptigemId === "string" ? e.leadingOptigemId : "";
    const orphaned = typeof e.orphanedOptigemId === "string" ? e.orphanedOptigemId : "";
    if (leading === "" || orphaned === "") continue;
    const ts = String(e.ts);
    if (since && ts.slice(0, 10) < since) continue;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    out.push({
      survivingPersonId: Number(e.survivingId),
      survivingPersonName: str(e.survivingName),
      survivingPersonOptigemId: str(e.survivingOptigemId),
      mergedPersonId: typeof e.loserId === "number" ? e.loserId : null,
      mergedPersonName: str(e.loserName),
      mergedPersonOptigemId: str(e.loserOptigemId),
      leadingOptigemId: leading,
      orphanedOptigemId: orphaned,
      identicalIds: leading === orphaned,
      mergedAt: ts,
      mergedBy: typeof e.mergedBy === "string" ? e.mergedBy : "",
    });
  }
  return out;
}

function csvCell(v: string | number | boolean | null): string {
  const s = v === null ? "" : String(v);
  // Neutralise spreadsheet formula injection as well as CSV metacharacters.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(merges: readonly FinanceMerge[]): string {
  const header = [
    "surviving_person_id",
    "surviving_person_name",
    "surviving_person_optigem_id",
    "merged_person_id",
    "merged_person_name",
    "merged_person_optigem_id",
    "leading_optigem_id",
    "orphaned_optigem_id",
    "identical_ids",
    "merged_at",
    "merged_by",
  ].join(",");
  const rows = merges.map((m) =>
    [
      m.survivingPersonId,
      m.survivingPersonName,
      m.survivingPersonOptigemId,
      m.mergedPersonId,
      m.mergedPersonName,
      m.mergedPersonOptigemId,
      m.leadingOptigemId,
      m.orphanedOptigemId,
      m.identicalIds,
      m.mergedAt,
      m.mergedBy,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[header, ...rows].join("\n")}\n`;
}

export function buildFinanceExport(
  merges: FinanceMerge[],
  host: string,
  since: string | undefined,
  now: Date,
): FinanceExport {
  return { schema: FINANCE_SCHEMA, generatedAt: now.toISOString(), host, since: since ?? null, merges };
}
