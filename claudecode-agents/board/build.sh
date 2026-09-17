#!/usr/bin/env bash
# Build the board binary. Output: bin/board next to this script, or $1.
set -euo pipefail
cd "$(dirname "$0")"
out="${1:-bin/board}"
mkdir -p "$(dirname "$out")"
version="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json)"
bun install --frozen-lockfile >/dev/null
# Via scripts/build.ts, not `bun build --compile`: the CLI does not load
# bun-plugin-tailwind from bunfig.toml, which bundles an empty stylesheet.
BOARD_BUILD_OUTFILE="$out" BOARD_BUILD_VERSION="$version" bun scripts/build.ts
chmod 0755 "$out"
printf 'built %s (%s)\n' "$out" "$version"
