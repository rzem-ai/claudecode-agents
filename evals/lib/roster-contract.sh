#!/usr/bin/env bash
#
# roster-contract.sh - the roster agrees with itself.
#
# Adding an agent means editing twenty files, and the failure mode is not a
# broken one, it is a half-done one: a body with no eval directory, an eval
# directory the runner never runs, an agent the SubagentStop matcher does not
# name so its handoff is never checked. Each of those is silent.
#
# Every assertion here holds for the nine agents that existed before this file,
# so a failure means something new is incomplete rather than that the rules
# changed.
#
# Usage:  evals/lib/roster-contract.sh [-v]

set -uo pipefail

VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$LIB_DIR/../.." && pwd)
AGENT_DIR="$REPO_ROOT/claudecode-agents/agents"
HOOKS_JSON="$REPO_ROOT/claudecode-agents/hooks/hooks.json"
RUN_SH="$REPO_ROOT/evals/run.sh"
DESIGN_MD="$REPO_ROOT/docs/fleet-design.md"

PASSED=0
FAILED=0

check() {
    # $1 case name, $2 requirement, $3 predicate result (0 ok), $4 detail
    if [ "$3" -eq 0 ]; then
        PASSED=$((PASSED + 1))
        [ "$VERBOSE" -eq 1 ] && printf '  ok    %-34s %s\n' "$1" "$2"
    else
        FAILED=$((FAILED + 1))
        printf '  FAIL  %-34s %s\n' "$1" "$2"
        [ -n "${4:-}" ] && printf '        %s\n' "$4"
    fi
    return 0
}

WANT_SECTIONS='## Scope
## How you work
## Invariants
## Handoff'

# Space-flanked so membership below is an exact token match, not a substring
# match: \b treats a hyphen as a word boundary, so "writer" would match inside
# "spec-writer" even though it names no agent of its own.
ALL_AGENTS_LIST=" $(sed -n 's/^ALL_AGENTS="\(.*\)"/\1/p' "$RUN_SH") "

for body in "$AGENT_DIR"/*.md; do
    agent=$(basename "$body" .md)

    name=$(sed -n 's/^name: *//p' "$body" | head -1)
    [ "$name" = "$agent" ]
    check "$agent-name" "the name field matches the filename" $? "name: $name"

    lines=$(wc -l < "$body" | tr -d ' ')
    [ "$lines" -lt 60 ]
    check "$agent-length" "the body is under 60 lines" $? "$lines lines"

    got=$(grep '^## ' "$body")
    [ "$got" = "$WANT_SECTIONS" ]
    check "$agent-sections" "four H2 sections, in the contract's order" $? "$(printf '%s' "$got" | tr '\n' ' ')"

    ! grep -q '—\|–' "$body"
    check "$agent-dashes" "no em dashes and no en dashes" $?

    # glossary and handoff are the two skills every body must preload. The
    # third used to be using-memory, until 12 September 2026: it never shipped,
    # and the opencode-agents port's findings showed a frontmatter name that
    # resolves to nothing tells the agent a procedure is loaded when it is not.
    # Forward references were stripped; a body preloads only what resolves.
    for skill in glossary handoff; do
        grep -q "^  - $skill\$" "$body"
        check "$agent-skill-$skill" "preloads $skill" $?
    done

    # And the inverse of the old rule: no body names a skill that does not
    # exist in the plugin or the known superpowers dependency (brainstorming).
    while IFS= read -r sk; do
        sk="${sk#  - }"
        if [ "$sk" != "brainstorming" ] && [ ! -d "$REPO_ROOT/claudecode-agents/skills/$sk" ]; then
            check "$agent-skill-resolves-$sk" "preloaded skill $sk resolves" 1 "no skills/$sk in the plugin"
        fi
    done < <(awk '/^skills:/{f=1;next} f&&/^  - /{print} f&&!/^  - /{f=0}' "$body")

    # [(|] on the left, because the first name in the alternation is preceded
    # by the opening bracket rather than a pipe - which `lead` is.
    grep -q "[(|]$agent[|)]" "$HOOKS_JSON"
    check "$agent-matcher" "is named in the SubagentStop matcher" $? "not in hooks.json"

    [ -d "$REPO_ROOT/evals/$agent" ]
    check "$agent-evals" "has an evals directory" $?

    # The directory existing was the whole of this check, so the net stopped one
    # level short: the refuter eval shipped with two prompts while evals/README
    # said in the same breath that the glossary's "three to five prompts" was
    # "exactly what is here". Nothing was watching the number the sentence
    # claimed. Now something is.
    prompt_count=$(ls "$REPO_ROOT/evals/$agent/prompts" 2>/dev/null | wc -l | tr -d ' ')
    [ "${prompt_count:-0}" -ge 3 ] && [ "${prompt_count:-0}" -le 5 ]
    check "$agent-prompt-count" "has the three to five prompts the glossary defines an eval as" $? "has $prompt_count"

    case "$ALL_AGENTS_LIST" in
        *" $agent "*) true ;;
        *) false ;;
    esac
    check "$agent-runner" "is in the eval runner's ALL_AGENTS" $?

    # The design doc's roster table is what the lead routes by, and it drifted
    # silently once: the 24 September 2026 realignment moved five agents' model
    # or effort in frontmatter and left the table describing a fleet that no
    # longer existed. Column 4 is Model, column 5 is Effort; a body with no
    # effort line is n/a in the table.
    row=$(grep "^| \`$agent\` |" "$DESIGN_MD" | head -1)
    [ -n "$row" ]
    check "$agent-design-row" "has a row in the design doc's roster" $? "no row in docs/fleet-design.md"
    if [ -n "$row" ]; then
        row_model=$(printf '%s' "$row" | awk -F'|' '{gsub(/[ `]/,"",$4); print $4}')
        row_effort=$(printf '%s' "$row" | awk -F'|' '{gsub(/ /,"",$5); print $5}')
        fm_model=$(sed -n 's/^model: *//p' "$body" | head -1)
        fm_effort=$(sed -n 's/^effort: *//p' "$body" | head -1)
        [ "$row_model" = "$fm_model" ]
        check "$agent-design-model" "the roster's model matches frontmatter" $? "roster $row_model, frontmatter $fm_model"
        [ "$row_effort" = "${fm_effort:-n/a}" ]
        check "$agent-design-effort" "the roster's effort matches frontmatter" $? "roster $row_effort, frontmatter ${fm_effort:-none}"
    fi
done

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
if [ "$FAILED" -ne 0 ]; then
    printf 'The roster disagrees with itself: an agent exists that some part of the fleet does not know about.\n'
    exit 1
fi
printf 'Every agent body, the matcher, the eval runner, the eval directories and the design doc roster agree.\n'
