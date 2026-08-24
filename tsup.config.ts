import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

// Baked into the bundle as a plain string literal (#116). Injecting the one field
// we need keeps the rest of the manifest — devDependencies, scripts, the whole
// dependency list — out of the published artifact, which a default JSON import
// could not: esbuild cannot tree-shake it. src/version.ts falls back to reading
// package.json when this is undefined (running from source).
const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  define: { __CT_VERSION__: JSON.stringify(version) },
});
