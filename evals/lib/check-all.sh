#!/usr/bin/env bash
#
# check-all.sh - every deterministic check in the repository, in one command.
#
# None of these calls a model, opens a network connection, or writes to a real
# board, so this is the thing to run before a commit and CI should run it. The
# model evals under evals/run.sh are separate and cost money.
#
#   handoff-parity        the two handoff validators agree, 28 fixtures
#   handoff-extractor     review-round reads a handoff exactly as the hook does
#   board-hook-contract   the board hooks read fields the runtime sends
#   scope-hook-contract   each role is held to its invariants, and can still work
#   roster-contract       every agent is known to the matcher, runner and evals
#   workflow-logic        the workflow branches decide on evidence
#   runner-gate           the eval runner fails when the run failed
#   board                 the board package type-checks, bundles, and its
#                         fleet-owned tests pass (CHECK_ALL_BOARD_FULL=1 for
#                         the whole upstream suite, which takes about 5 min)
#   glossary              the generated rule still matches the canonical skill
#   versions              plugin.json, the marketplace entry and the newest
#                         CHANGELOG release carry the same version
#
# Usage:  evals/lib/check-all.sh [-v]

set -uo pipefail

VERBOSE="${1:-}"
LIB_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$LIB_DIR/../.." && pwd)

FAILED=()

run() {
    # $1 label, rest: command
    local label="$1"; shift
    printf '\n=== %s ===\n' "$label"
    if "$@" ${VERBOSE:+"$VERBOSE"}; then
        printf '%s: ok\n' "$label"
    else
        printf '%s: FAILED\n' "$label"
        FAILED+=("$label")
    fi
}

printf '\n=== shell and node syntax ===\n'
syntax_failed=0
while IFS= read -r f; do
    bash -n "$f" 2>&1 || { printf '  syntax FAIL %s\n' "$f"; syntax_failed=1; }
done < <(find "$REPO_ROOT/claudecode-agents/hooks" "$REPO_ROOT/scripts" "$REPO_ROOT/evals" \
            -name '*.sh' -type f 2>/dev/null)
for f in "$REPO_ROOT"/claudecode-agents/workflows/*.js; do
    node -e "
      const fs=require('fs');
      const src=fs.readFileSync('$f','utf8').replace(/^export const meta/m,'const meta');
      new Function('agent','parallel','pipeline','phase','log','args','return (async()=>{'+src+'})()');
    " 2>&1 || { printf '  parse FAIL %s\n' "$f"; syntax_failed=1; }
done
if [ "$syntax_failed" -eq 0 ]; then printf 'syntax: ok\n'; else FAILED+=("syntax"); fi

run handoff-parity      "$LIB_DIR/handoff-parity.sh"
run handoff-extractor   "$LIB_DIR/handoff-extractor-parity.sh"
run board-hook-contract "$LIB_DIR/board-hook-contract.sh"
run scope-hook-contract "$LIB_DIR/scope-hook-contract.sh"
run roster-contract     "$LIB_DIR/roster-contract.sh"
run workflow-logic      node "$LIB_DIR/workflow-logic.mjs"
run runner-gate         "$LIB_DIR/runner-gate.sh"

printf '\n=== board ===\n'
if ! command -v bun >/dev/null 2>&1; then
    printf 'board: skipped (bun is not on PATH)\n'
else
    # The five test files the fleet owns. The rest of the upstream suite takes
    # about five minutes, and check-all.sh has to stay under two, so it runs
    # only under CHECK_ALL_BOARD_FULL=1.
    BOARD_TESTS=(
        src/test/board-root.test.ts
        src/test/cli-board.test.ts
        src/test/cli-board-behaviour.test.ts
        src/test/no-git.test.ts
        src/test/serve-board.test.ts
    )
    BOARD_TMP=$(mktemp -d "${TMPDIR:-/tmp}/check-all-board.XXXXXX")
    board_failed=0
    (
        cd "$REPO_ROOT/claudecode-agents/board" || exit 1
        # A fresh clone has no node_modules, and tsc then reports hundreds of
        # missing-module errors that look like the package is broken rather
        # than uninstalled.
        [ -d node_modules ] || bun install --frozen-lockfile >/dev/null || exit 1
        bunx tsc --noEmit || exit 1
        bun build --target=bun src/cli.ts --outdir "$BOARD_TMP" >/dev/null || exit 1
        if [ "${CHECK_ALL_BOARD_FULL:-}" = "1" ]; then
            bun test --timeout=10000 || exit 1
        else
            bun test --timeout=10000 "${BOARD_TESTS[@]}" || exit 1
        fi
    ) || board_failed=1
    rm -rf "$BOARD_TMP"
    if [ "$board_failed" -eq 0 ]; then
        printf 'board: ok\n'
    else
        printf 'board: FAILED\n'
        FAILED+=("board")
    fi
fi

printf '\n=== glossary ===\n'
if "$REPO_ROOT/scripts/gen-glossary-rule.sh" --check; then
    printf 'glossary: ok\n'
else
    printf 'glossary: FAILED\n'
    FAILED+=("glossary")
fi

# The marketplace listing shows the version in .claude-plugin/marketplace.json,
# not the one in the plugin's own manifest, and 0.16.0 and 0.17.0 both shipped
# with the entry still saying 0.15.1. The three numbers move together or the
# release is not visible.
printf '\n=== versions ===\n'
if python3 - "$REPO_ROOT" <<'PY'
import json, re, sys
root = sys.argv[1]
plugin = json.load(open(f"{root}/claudecode-agents/.claude-plugin/plugin.json"))["version"]
entry = next(p for p in json.load(open(f"{root}/.claude-plugin/marketplace.json"))["plugins"] if p["name"] == "claudecode-agents")["version"]
m = re.search(r"^## \[(\d+\.\d+\.\d+)\]", open(f"{root}/claudecode-agents/CHANGELOG.md").read(), re.M)
changelog = m.group(1) if m else None
print(f"plugin.json {plugin}, marketplace entry {entry}, newest CHANGELOG release {changelog}")
sys.exit(0 if plugin == entry == changelog else 1)
PY
then
    printf 'versions: ok\n'
else
    printf 'versions: FAILED\n'
    FAILED+=("versions")
fi

printf '\n---\n'
if [ "${#FAILED[@]}" -ne 0 ]; then
    printf 'FAILED: %s\n' "${FAILED[*]}"
    exit 1
fi
printf 'Every deterministic check passes.\n'
