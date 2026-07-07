/**
 * Whether this module is the process entrypoint (i.e. run as the `ct` binary),
 * as opposed to being imported (e.g. by tests).
 *
 * The naive `import.meta.url === "file://" + process.argv[1]` check breaks when
 * the binary is invoked through a symlink — npm link, a global install, or a
 * Homebrew shim all leave `argv[1]` as the symlink path while `import.meta.url`
 * is the module's realpath. Resolving both to their realpath makes the
 * comparison robust; each side falls back to its raw path if resolution fails,
 * so an unresolvable argv1 still gets compared against the module's realpath.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(
  argv1: string | undefined,
  metaUrl: string,
  realpath: (p: string) => string = realpathSync,
): boolean {
  if (!argv1) {
    return false;
  }
  const modulePath = fileURLToPath(metaUrl);
  const resolve = (p: string): string => {
    try {
      return realpath(p);
    } catch {
      return p;
    }
  };
  return resolve(argv1) === resolve(modulePath);
}
