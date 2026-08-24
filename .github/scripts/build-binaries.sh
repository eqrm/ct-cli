#!/usr/bin/env bash
# Cross-compiles the three standalone `ct` binaries into release/.
#
# `bun build --compile` embeds a prebuilt runtime per target, so all three are
# produced from one Linux runner; only *executing* them needs the target OS,
# which is what the smoke-test jobs are for.
#
# Shared by two jobs on purpose (#116): the `build` job compiles the binaries the
# smoke tests run, and the `release` job recompiles them AFTER semantic-release
# has bumped package.json, so the attached binaries report the version they were
# released as instead of the repo's 0.1.0 placeholder (`ct --version` bakes in
# package.json's version at build time). Keeping one script keeps the two
# invocations from drifting apart. Both jobs pin the SAME bun version (see
# release.yml) so the recompile really is the smoke-tested build plus a different
# version constant. The release job re-runs the smoke test on the recompiled
# linux binary — the only one it can execute — so no artifact ships unexecuted.
set -euo pipefail

# `ct --version` reads a build-time constant (src/version.ts); bun's --define
# substitutes it, exactly as tsup.config.ts does for the npm bundle. The value has
# to arrive as a JS string *expression*, hence the JSON quoting.
version="$(node -p 'require("./package.json").version')"
version_literal="$(node -p 'JSON.stringify(process.argv[1])' "$version")"
echo "Compiling ct binaries for version ${version}"

mkdir -p release
for target in darwin-arm64 darwin-x64 linux-x64; do
  bun build --compile --target="bun-${target}" \
    --define "__CT_VERSION__=${version_literal}" \
    ./src/index.ts --outfile "release/ct-${target}"
done
chmod +x release/ct-darwin-arm64 release/ct-darwin-x64 release/ct-linux-x64
