// Compiles one standalone `ct` binary with Bun (called by build-binaries.sh).
//
// Ink (the `ct dupes --tui` view) imports `react-devtools-core` from a module it only
// loads when DEV=true. Bun hoists that import into the bundle, so a missing package breaks
// every binary at startup, and `--external` only moves the failure to runtime. The plugin
// swaps the package for an empty stub instead: devtools are never available in a binary.
//
// Usage: bun .github/scripts/build-binary.ts <bun-target> <outfile> <version>
const [target, outfile, version] = process.argv.slice(2);
if (!target || !outfile || !version) {
  console.error("usage: build-binary.ts <bun-target> <outfile> <version>");
  process.exit(2);
}

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  compile: { target: target as Bun.Build.Target, outfile },
  define: { __CT_VERSION__: JSON.stringify(version) },
  plugins: [
    {
      name: "stub-react-devtools-core",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "ct-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "ct-stub" }, () => ({
          contents: "export default { initialize() {}, connectToDevTools() {} };",
          loader: "js",
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
