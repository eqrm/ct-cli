/**
 * Offline data sources for tab completion (#132).
 *
 * Everything here runs on a Tab keypress, which imposes two hard rules:
 *
 * - **Nothing contacts ChurchTools and nothing reads a credential.** Completion is
 *   allowed to look at the local, non-secret config repo (`ct.envs.json`, the state
 *   file, the working directory) and at nothing else. There is no client, no token
 *   store and no `prepareEnv` in this module, on purpose.
 * - **A failure yields no candidates, never an error and never a hang.** A missing,
 *   unreadable, malformed or slow file is the normal case while a config repo is
 *   being edited; the shell must simply offer nothing instead of printing a stack
 *   trace into the command line. So every read is wrapped in {@link offline}.
 *
 * That is also why these read the files directly rather than going through
 * `loadEnvProfile`/`loadState`: those validate and throw friendly errors, which is
 * right for a command and wrong for a keypress.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { RESOURCES } from "../resources/registry.js";

/** A source slower than this is abandoned — the shell must never wait on `ct`. */
const SOURCE_TIMEOUT_MS = 150;

/** Run a source with the two guarantees above: no throw, no hang, `fallback` on failure. */
async function offline<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandon = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), SOURCE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([read().catch(() => fallback), abandon]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object under `field`, or an empty one for anything that is not a JSON object. */
function objectField(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) return {};
  const nested = value[field];
  return isObject(nested) ? nested : {};
}

/** The environment names declared in the profile file — the values `--env` accepts. */
export function envNames(path: string): Promise<string[]> {
  return offline(
    async () => Object.keys(objectField(JSON.parse(await readFile(path, "utf8")), "environments")),
    [],
  );
}

/**
 * The state file a named environment declares, or `undefined` when it leaves the
 * `ct-state.<env>.json` convention alone. This is the same `state` field the commands
 * read through `loadEnvProfile`; completion has to honour it too, or it answers about
 * a different state file than the one `ct state rm` will edit.
 */
export function envStatePath(path: string, name: string): Promise<string | undefined> {
  return offline(async () => {
    const profile = objectField(JSON.parse(await readFile(path, "utf8")), "environments")[name];
    const declared = isObject(profile) ? profile.state : undefined;
    return typeof declared === "string" && declared !== "" ? declared : undefined;
  }, undefined);
}

/**
 * The logical keys under management in a state file — the values `ct state rm` accepts.
 *
 * `type` narrows them to the keys of that resource type, because `ct state rm <type>
 * <key>` rejects a key of any other type: offering it would only complete into an error.
 */
export function stateKeys(path: string, type?: string): Promise<string[]> {
  return offline(async () => {
    const resources = objectField(JSON.parse(await readFile(path, "utf8")), "resources");
    return Object.entries(resources)
      .filter(([, entry]) => type === undefined || (isObject(entry) && entry.type === type))
      .map(([key]) => key);
  }, []);
}

/** The resource types the registry knows, straight from the registry so it cannot drift. */
export function resourceTypes(): string[] {
  return Object.keys(RESOURCES);
}

/**
 * `~` is the shell's notion, not the filesystem's. The installed hooks turn off the
 * shell's own filename fallback (`complete -F` without `-o default`, `complete -f`), so
 * if `ct` does not resolve the tilde itself, `--backup-dir ~/b<Tab>` offers nothing at
 * all. Only the directory being read is expanded — the candidates keep the `~/` the
 * user typed, so the shell's prefix filter still matches them.
 */
function expandTilde(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Filesystem candidates for a partially typed path.
 *
 * The shells filter the returned list against the word being typed, so the entries
 * must carry the directory prefix the user already typed. Dot-entries are offered
 * only once the user has typed a dot, matching what every shell does by default.
 */
export function paths(partial: string, kind: "file" | "directory"): Promise<string[]> {
  return offline(async () => {
    const cut = partial.lastIndexOf("/");
    const prefix = cut === -1 ? "" : partial.slice(0, cut + 1);
    const base = partial.slice(cut + 1);
    const entries = await readdir(expandTilde(prefix === "" ? "." : prefix), { withFileTypes: true });
    return entries
      .filter((entry) => base.startsWith(".") || !entry.name.startsWith("."))
      .filter((entry) => kind === "file" || entry.isDirectory())
      .map((entry) => `${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
  }, []);
}
