/**
 * Automatic pre-write backup. Before any apply/destroy touches ChurchTools, the
 * current *actual* values of the managed resources are dumped to a timestamped
 * JSON file, so the affected area can be inspected/restored.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeBackup(
  dir: string,
  host: string,
  actual: Map<string, Record<string, unknown>>,
  now: Date = new Date(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/:/g, "-");
  const path = join(dir, `ct-backup-${stamp}.json`);
  const payload = {
    host,
    capturedAt: now.toISOString(),
    resources: Object.fromEntries(actual),
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}
