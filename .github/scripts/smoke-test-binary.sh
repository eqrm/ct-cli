#!/usr/bin/env bash
# Smoke-tests one compiled `ct` binary (`bun build --compile` output) with no Node
# and no ChurchTools instance available.
#
# `ct --help` alone doesn't prove much: the risky part of compiling this CLI is
# jiti's *runtime* TypeScript transpilation of a user's `.config.ts` — that only
# happens once a command actually loads a config file, not on `--help`. So this
# also runs `ct plan` against a real fixture config (tests/fixtures/sample.config.ts)
# with a bogus CT_HOST. That command is expected to fail — but it must fail at the
# *auth* step (authedSession() in src/api/session.ts: either "Not logged in", the
# expected outcome on a fresh CI runner with no stored credentials, or the
# host-mismatch "Refusing to send the stored login token" if a credential happens
# to be present for a different host), which only runs AFTER the config file has
# been located, transpiled by jiti, and evaluated. If the binary instead fails to
# find/parse the config, that's a real jiti-in-a-compiled-binary bug, not one of
# the expected auth failures, and this script flags it as such.
#
# What this proves: the compiled binary can locate and run, and can dynamically
# transpile + evaluate a TypeScript config file at runtime.
# What this does NOT prove: a real `ct plan`/`ct apply` against a live ChurchTools
# instance — no network call is made.
set -euo pipefail

bin="$1"
chmod +x "$bin"

echo "== ct --help =="
"$bin" --help

# The version constant is injected at compile time (bun --define, see
# build-binaries.sh). If that injection ever stops working the binary falls back
# to reading package.json, which does not exist inside the compiled bundle — so
# it would silently ship "0.0.0-unknown", the exact dishonest answer #116 removed.
# Nothing else in CI executes `--version` on the compiled path, so assert it here.
echo
echo "== ct --version =="
version_line="$("$bin" --version)"
echo "$version_line"
expected="$(node -p 'require("./package.json").version')"
if ! grep -Eq "^${expected} \(" <<<"$version_line"; then
  echo "FAIL: expected --version to start with the package.json version ${expected}; got '${version_line}' (build-time version injection is broken)" >&2
  exit 1
fi

echo
echo "== ct plan (config-load exercise, no network/creds) =="
set +e
out="$(CT_HOST=https://ci-smoke-test.invalid "$bin" plan \
  --config tests/fixtures/sample.config.ts \
  --state /tmp/ct-smoke-state.json 2>&1)"
rc=$?
set -e

echo "$out"

if [ "$rc" -eq 0 ]; then
  echo "FAIL: expected a non-zero exit (no stored/CI credentials) but the command succeeded" >&2
  exit 1
fi

if ! grep -Eq "Not logged in|Refusing to send the stored login token" <<<"$out"; then
  echo "FAIL: expected an auth-layer error ('Not logged in' or the host-mismatch refusal) proving config load succeeded; got a different failure (possible config-load/jiti bug in the compiled binary)" >&2
  exit 1
fi

echo
echo "OK: binary parsed the fixture TS config at runtime and failed at the auth step, as expected."
