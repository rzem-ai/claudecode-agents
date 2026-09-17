#!/usr/bin/env bash
# The one way the hooks and the MCP config reach the board binary.
#   1. ~/.local/bin/board, built by scripts/install-home.sh
#   2. bin/board beside this script, built by build.sh
#   3. bun run src/cli.ts, when Bun is present and nothing is built yet
# Exit 127 with a one-line reason otherwise; the hook library treats that as a soft failure.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$HOME/.local/bin/board" ]; then exec "$HOME/.local/bin/board" "$@"; fi
if [ -x "$here/bin/board" ]; then exec "$here/bin/board" "$@"; fi
if command -v bun >/dev/null 2>&1; then exec bun "$here/src/cli.ts" "$@"; fi
printf 'board: no binary at ~/.local/bin/board or %s/bin/board and no bun on PATH\n' "$here" >&2
exit 127
