/**
 * The CLI's own version — and which `ct` is actually running (#116). (The
 * ChurchTools *instance* version, and the minimum this tool requires, live in
 * `api/version.ts`; the two are unrelated.)
 *
 * `--version` is what you reach for when a plan does something unexpected, so it
 * has to answer two questions honestly: *which version* and *which binary*. It
 * used to answer neither — the version was the literal `"0.0.0"`, identical for
 * a released install and a locally linked dev build, which is worse than useless
 * because it reads like evidence.
 *
 * The version is baked in at build time from `package.json`: both `tsup` and
 * `bun build --compile` inline the JSON import, so an artifact carries the
 * version its working tree declared when it was built. That is the released
 * version for the published package — semantic-release bumps `package.json`
 * before `npm pack`/`npm publish`, each of which re-runs the build through the
 * `prepare` script (the same ordering `.releaserc.json` relies on for the
 * tarball, see #84). Running from source (`npm run dev`) reports the repo's
 * placeholder version, which the entry path below makes obvious.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

/** The version this build was compiled from. */
export const VERSION: string = pkg.version;

/**
 * Paths inside a `bun build --compile` binary's embedded filesystem. Bun's `fs`
 * shim reports them as existing, so they have to be recognised by prefix.
 */
const EMBEDDED_PREFIXES = ["/$bunfs/", "B:\\~BUN\\"];

/**
 * Absolute path of the running `ct`.
 *
 * `import.meta.url` points at the bundle (`.../dist/index.js`) or, when running
 * from source, at the checkout — which settles "am I running the pinned package
 * or something else on this machine?". Inside a standalone binary it points into
 * bun's embedded filesystem, which tells the user nothing; there, the binary's
 * own path on disk is the useful answer.
 */
export function resolveEntry(moduleUrl: string = import.meta.url): string {
  try {
    const path = fileURLToPath(moduleUrl);
    if (EMBEDDED_PREFIXES.some((prefix) => path.startsWith(prefix)) || !existsSync(path)) {
      return process.execPath;
    }
    return path;
  } catch {
    return process.execPath;
  }
}

/** What `ct --version` prints: `1.7.0 (/path/to/dist/index.js)`. */
export function versionLine(moduleUrl?: string): string {
  return `${VERSION} (${resolveEntry(moduleUrl)})`;
}
