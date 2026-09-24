#!/usr/bin/env bash
#
# run.sh - run the fleet's smoke evals.
#
# One eval per agent: three to five prompts, a rubric, a baseline score
# (glossary, "Eval"). Each prompt runs through `claude -p` in a throwaway copy
# of a fixture repo, and the result is scored three ways:
#
#   handoff gate  the four-heading format, checked by evals/lib/handoff-check.sh
#                 against the run's FINAL ASSISTANT MESSAGE, which is the one
#                 string the SubagentStop hook sees. Every eval shares it,
#                 because three hooks parse that format.
#   agent gate    evals/<agent>/checks.sh, when the agent has one. These are the
#                 mechanical facts - did the reviewer edit a file, did the
#                 spec-writer write outside docs/specs, did anything reach .env.
#   rubric        evals/<agent>/rubric.md, graded by a second `claude -p` call.
#
# A gate is pass or fail and a failed gate fails the eval whatever the rubric
# says. The rubric is a percentage. Both are reported.
#
# Usage:
#   evals/run.sh                        every agent
#   evals/run.sh reviewer scout         named agents
#   evals/run.sh --list                 what exists, and how many prompts each
#   evals/run.sh --dry-run              show the commands, run nothing
#   evals/run.sh --no-judge             gates only, no grader call
#   evals/run.sh reviewer --prompt 2    one prompt
#   evals/run.sh --update-baseline      record this run as the baseline
#   evals/run.sh --help
#
# Environment:
#   EVAL_CLAUDE_BIN     claude binary (default: claude)
#   EVAL_AGENT_FLAG     flag that selects the agent (default: --agent). If the
#                       CLI spells it differently on your version, set it here
#                       rather than editing this script.
#   EVAL_CLAUDE_ARGS    extra args for every run (default: --permission-mode acceptEdits)
#   EVAL_JUDGE_MODEL    model for the grader (default: sonnet)
#   EVAL_TIMEOUT        per-prompt timeout in seconds (default: 900, needs timeout(1))
#   EVAL_OUTPUT_FORMAT  json, text, or auto (default). auto picks json when jq
#                       is installed, because json carries the final assistant
#                       message in its own field and text does not label it.
#                       Ignored if EVAL_CLAUDE_ARGS already sets --output-format.

set -uo pipefail

SCRIPT_NAME=$(basename "$0")
EVAL_ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$EVAL_ROOT/.." && pwd)

CLAUDE_BIN="${EVAL_CLAUDE_BIN:-claude}"
AGENT_FLAG="${EVAL_AGENT_FLAG:---agent}"
CLAUDE_ARGS="${EVAL_CLAUDE_ARGS:---permission-mode acceptEdits}"
JUDGE_MODEL="${EVAL_JUDGE_MODEL:-sonnet}"
TIMEOUT_SECS="${EVAL_TIMEOUT:-900}"
OUTPUT_FORMAT="${EVAL_OUTPUT_FORMAT:-auto}"

ALL_AGENTS="lead scout spec-writer coder scripter reviewer ui-designer tech-writer researcher fleet-steward refuter"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_ROOT="$EVAL_ROOT/results/$STAMP"

DO_LIST=0
DRY_RUN=0
DO_JUDGE=1
ONE_PROMPT=""
UPDATE_BASELINE=0
KEEP_WORKSPACE=0
AGENTS=""

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '%s: warning: %s\n' "$SCRIPT_NAME" "$*" >&2; }
die()  { printf '%s: error: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 2; }

usage() { sed -n '3,42p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --list)            DO_LIST=1 ;;
        -n|--dry-run)      DRY_RUN=1 ;;
        --no-judge)        DO_JUDGE=0 ;;
        --keep-workspace)  KEEP_WORKSPACE=1 ;;
        --update-baseline) UPDATE_BASELINE=1 ;;
        --prompt)          shift; ONE_PROMPT="${1:-}" ;;
        --judge-model)     shift; JUDGE_MODEL="${1:-}" ;;
        --out)             shift; OUT_ROOT="${1:-}" ;;
        -h|--help)         usage; exit 0 ;;
        -*)                die "unknown option: $1 (try --help)" ;;
        *)                 AGENTS="$AGENTS $1" ;;
    esac
    shift
done

[ -n "$AGENTS" ] || AGENTS="$ALL_AGENTS"

# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------

prompt_files() {
    # $1 agent. Sorted, so 01- runs before 02-.
    local a="$1"
    find "$EVAL_ROOT/$a/prompts" -name '*.md' -type f 2>/dev/null | LC_ALL=C sort
}

if [ "$DO_LIST" -eq 1 ]; then
    say "Evals in $EVAL_ROOT"
    say ""
    printf '%-16s %-8s %-8s %-8s %s\n' AGENT PROMPTS RUBRIC GATE BASELINE
    for a in $ALL_AGENTS; do
        n=$(prompt_files "$a" | wc -l | tr -d ' ')
        r="no"; [ -f "$EVAL_ROOT/$a/rubric.md" ] && r="yes"
        g="no"; [ -f "$EVAL_ROOT/$a/checks.sh" ] && g="yes"
        b="unset"
        if [ -f "$EVAL_ROOT/$a/baseline.json" ]; then
            b=$(sed -n 's/.*"score"[[:space:]]*:[[:space:]]*\("*[0-9.a-z]*"*\).*/\1/p' "$EVAL_ROOT/$a/baseline.json" | head -1)
            [ -n "$b" ] || b="unset"
            [ "$b" = "null" ] && b="unset"
        fi
        printf '%-16s %-8s %-8s %-8s %s\n' "$a" "$n" "$r" "$g" "$b"
    done
    exit 0
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if [ "$DRY_RUN" -eq 0 ] && ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    die "$CLAUDE_BIN not found on PATH. Set EVAL_CLAUDE_BIN or use --dry-run."
fi

# The gate must read the final assistant message and nothing else, because
# that is all `SubagentStop` reads. The json output format names it in a field
# of its own; the text format leaves the runner guessing, which is the
# difference documented in README.md under "What the gate reads".
case "$CLAUDE_ARGS" in
    *--output-format*) OUTPUT_FORMAT=preset ;;
esac
if [ "$OUTPUT_FORMAT" = "auto" ]; then
    if command -v jq >/dev/null 2>&1; then
        OUTPUT_FORMAT=json
    else
        OUTPUT_FORMAT=text
        warn "no jq, so the run falls back to text output and the gate reads the whole capture. See README.md, \"What the gate reads\"."
    fi
fi
case "$OUTPUT_FORMAT" in
    preset) FORMAT_ARGS="" ;;
    *)      FORMAT_ARGS="--output-format $OUTPUT_FORMAT" ;;
esac

TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_CMD="timeout $TIMEOUT_SECS"
elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_CMD="gtimeout $TIMEOUT_SECS"
else
    warn "no timeout(1) on this box, so a hung prompt will hang the run."
fi

mkdir -p "$OUT_ROOT"

# What was actually exercised. A baseline is only evidence if you can say which
# definitions produced it, and "the ones in the repo at the time" is not an
# answer anyone can check six weeks later. Written once per run, beside the
# results: the commit, whether the tree was dirty, and a hash per agent file.
if command -v python3 >/dev/null 2>&1; then
    python3 - "$REPO_ROOT" "$OUT_ROOT" <<'PY' || warn 'could not record definition provenance'
import hashlib, json, subprocess, sys
from pathlib import Path

root, out = map(Path, sys.argv[1:3])


def git(*a):
    try:
        return subprocess.check_output(['git', '-C', str(root), *a], text=True,
                                       stderr=subprocess.DEVNULL).strip()
    except Exception:
        return None


agents = root / 'claudecode-agents' / 'agents'
skills = root / 'claudecode-agents' / 'skills'
files = {}
for p in sorted(list(agents.glob('*.md')) + list(skills.glob('*/SKILL.md'))):
    files[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()

(out / 'definition-provenance.json').write_text(
    json.dumps(
        {
            'commit': git('rev-parse', 'HEAD'),
            'branch': git('rev-parse', '--abbrev-ref', 'HEAD'),
            'dirty': bool(git('status', '--porcelain')),
            'plugin_dir': str(root / 'claudecode-agents'),
            'files': files,
        },
        indent=2,
    )
    + '\n'
)
PY
fi

SUMMARY_TSV="$OUT_ROOT/summary.tsv"
SUMMARY_TXT="$OUT_ROOT/summary.txt"
: > "$SUMMARY_TSV"
printf 'agent\tprompt\thandoff\tchecks\trubric_passed\trubric_total\n' >> "$SUMMARY_TSV"

RUN_FAILED=0

# ---------------------------------------------------------------------------
# One prompt
# ---------------------------------------------------------------------------

build_workspace() {
    # $1 workspace path, $2 fixture name
    local ws="$1" fixture="$2"
    mkdir -p "$ws"
    if [ "$fixture" != "none" ]; then
        if [ ! -d "$EVAL_ROOT/fixtures/$fixture" ]; then
            warn "fixture '$fixture' does not exist; using an empty workspace."
        else
            cp -R "$EVAL_ROOT/fixtures/$fixture/." "$ws/"
        fi
    fi
    if [ -d "$EVAL_ROOT/fixtures/inputs" ]; then
        mkdir -p "$ws/.eval-inputs"
        cp -R "$EVAL_ROOT/fixtures/inputs/." "$ws/.eval-inputs/"
    fi
}

manifest() {
    # $1 directory. Checksum plus path, one line per file, sorted. The
    # read-only gates are the diff of two of these, so the paths are relative
    # to the workspace and the checksum is what catches an in-place edit.
    (
        cd "$1" 2>/dev/null || exit 0
        find . -type f -print0 2>/dev/null | while IFS= read -r -d '' f; do
            printf '%s  %s\n' "$(cksum < "$f" | awk '{print $1 "-" $2}')" "$f"
        done
    ) | LC_ALL=C sort
}

run_prompt() {
    # $1 agent, $2 prompt file, $3 output dir
    local agent="$1" pfile="$2" pdir="$3"
    local fixture text ws rc

    mkdir -p "$pdir"

    fixture=$(sed -n 's/^#!fixture:[[:space:]]*//p' "$pfile" | head -1)
    [ -n "$fixture" ] || fixture="sample-app"

    # Directive lines never reach the model.
    text=$(grep -v '^#!' "$pfile")

    ws="$pdir/workspace"
    printf '%s\n' "$text" > "$pdir/prompt.txt"

    if [ "$DRY_RUN" -eq 1 ]; then
        info "$(basename "$pfile" .md): $CLAUDE_BIN -p $AGENT_FLAG $agent $CLAUDE_ARGS $FORMAT_ARGS  (fixture: $fixture)"
        return 0
    fi

    build_workspace "$ws" "$fixture"
    manifest "$ws" > "$pdir/before.manifest"

    # --plugin-dir loads the definitions from THIS checkout, and the agent is
    # named with its plugin scope. Without both, a bare `--agent scout` resolved
    # against whatever is installed on the machine: nothing at all on a clean
    # box, and a stale or shadowing user-scoped copy on a configured one. Either
    # way the run proved nothing about the files in the pull request.
    # shellcheck disable=SC2086
    ( cd "$ws" && $TIMEOUT_CMD "$CLAUDE_BIN" \
        --plugin-dir "$REPO_ROOT/claudecode-agents" \
        -p "$text" $AGENT_FLAG "claudecode-agents:$agent" $CLAUDE_ARGS $FORMAT_ARGS ) \
        > "$pdir/raw-output.txt" 2> "$pdir/stderr.txt"
    rc=$?
    printf '%s\n' "$rc" > "$pdir/exit-code.txt"

    # R12. The exit code used to be stored and warned about, and nothing more:
    # if the capture happened to contain a valid handoff and the fixture was
    # unchanged, every gate passed and the runner exited 0. A stub that returned
    # a valid handoff inside an is_error envelope and then exited 7 was reported
    # as "All gates passed".
    if [ "$rc" -ne 0 ]; then
        RUN_FAILED=1
        printf 'FAIL runtime: claude exited %s\n' "$rc" > "$pdir/runtime.txt"
        warn "$agent / $(basename "$pfile"): claude exited $rc (see $pdir/stderr.txt)"
    else
        printf 'PASS runtime\n' > "$pdir/runtime.txt"
    fi
    # An error envelope with a zero exit is the same failure wearing a hat.
    if command -v jq >/dev/null 2>&1 && \
       jq -e -s '
         [.[] | if type == "array" then .[] else . end]
         | any(.[]; type == "object" and .type == "result" and .is_error == true)
       ' "$pdir/raw-output.txt" >/dev/null 2>&1; then
        RUN_FAILED=1
        printf 'FAIL runtime: the result envelope reports is_error=true\n' > "$pdir/runtime.txt"
        warn "$agent / $(basename "$pfile"): the result envelope reports is_error=true"
    fi

    # transcript.txt is the final assistant message alone, because that is the
    # only thing the SubagentStop hook is given. Everything the CLI printed is
    # kept beside it in raw-output.txt.
    "$EVAL_ROOT/lib/final-message.sh" "$pdir/raw-output.txt" \
        > "$pdir/transcript.txt" 2> "$pdir/final-message.method" || true

    manifest "$ws" > "$pdir/after.manifest"
    diff "$pdir/before.manifest" "$pdir/after.manifest" > "$pdir/manifest.diff" 2>&1 || true
    # Added, modified and removed, all three. A file the agent deleted is as
    # much a violation of a read-only gate as one it rewrote.
    {
        LC_ALL=C comm -13 "$pdir/before.manifest" "$pdir/after.manifest" 2>/dev/null || true
        LC_ALL=C comm -23 "$pdir/before.manifest" "$pdir/after.manifest" 2>/dev/null || true
    } | sed 's/^[0-9-]*  //' | LC_ALL=C sort -u > "$pdir/changed-files.txt"
}

score_prompt() {
    # $1 agent, $2 prompt file, $3 output dir. Writes the summary row.
    local agent="$1" pfile="$2" pdir="$3"
    local pname handoff checks passed total judge_out
    pname=$(basename "$pfile" .md)

    handoff="SKIP"
    checks="-"
    passed=0
    total=0

    if [ -f "$pdir/transcript.txt" ]; then
        if "$EVAL_ROOT/lib/handoff-check.sh" "$pdir/transcript.txt" > "$pdir/handoff.txt" 2>&1; then
            handoff="PASS"
        else
            handoff="FAIL"
            RUN_FAILED=1
        fi

        if [ -x "$EVAL_ROOT/$agent/checks.sh" ]; then
            if "$EVAL_ROOT/$agent/checks.sh" "$pdir" "$pname" > "$pdir/checks.txt" 2>&1; then
                checks="PASS"
            else
                checks="FAIL"
                RUN_FAILED=1
            fi
        fi

        if [ "$DO_JUDGE" -eq 1 ] && [ -f "$EVAL_ROOT/$agent/rubric.md" ]; then
            judge_out="$pdir/judge.txt"
            build_judge_prompt "$agent" "$pname" "$pdir" > "$pdir/judge-prompt.txt"
            # shellcheck disable=SC2086
            $TIMEOUT_CMD "$CLAUDE_BIN" -p "$(cat "$pdir/judge-prompt.txt")" \
                --model "$JUDGE_MODEL" > "$judge_out" 2> "$pdir/judge-stderr.txt" || true
            total=$(grep -c '^RESULT ' "$judge_out" 2>/dev/null | tr -d ' ')
            passed=$(grep -c '^RESULT [^ ]* PASS' "$judge_out" 2>/dev/null | tr -d ' ')
            [ -n "$total" ] || total=0
            [ -n "$passed" ] || passed=0
            if [ "$total" -eq 0 ]; then
                warn "$agent / $pname: the grader returned no RESULT lines (see $judge_out)"
            fi
        fi
    else
        RUN_FAILED=1
    fi

    # A partial handoff is still extracted, because it helps diagnosis. It does
    # not undo a runtime failure: the summary verdict and the process exit have
    # to agree, or the summary is not evidence of anything.
    if [ -f "$pdir/runtime.txt" ] && grep -q '^FAIL ' "$pdir/runtime.txt"; then
        checks='FAIL'
        RUN_FAILED=1
    fi

    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$agent" "$pname" "$handoff" "$checks" "$passed" "$total" \
        >> "$SUMMARY_TSV"
    printf '  %-28s handoff %-4s  checks %-4s  rubric %s/%s\n' \
        "$pname" "$handoff" "$checks" "$passed" "$total"
}

build_judge_prompt() {
    # $1 agent, $2 prompt name, $3 output dir
    local agent="$1" pname="$2" pdir="$3"
    cat "$EVAL_ROOT/lib/judge-prompt.md"
    printf '\n## The agent under test\n\n%s\n' "$agent"
    printf '\n## The rubric\n\n'
    cat "$EVAL_ROOT/$agent/rubric.md"
    printf '\n## The prompt the agent was given\n\n'
    cat "$pdir/prompt.txt"
    printf '\n## Files the agent changed in the workspace\n\n'
    if [ -s "$pdir/changed-files.txt" ]; then
        cat "$pdir/changed-files.txt"
    else
        printf '(none)\n'
    fi
    printf '\n## The agent transcript - its final message, which is all the board ever sees\n\n'
    cat "$pdir/transcript.txt"
    printf '\n## End of transcript\n\n'
    printf 'Grade the criteria under the rubric heading "Prompt %s", and every\n' "$pname"
    printf 'criterion under "All prompts". Ignore criteria belonging to other prompts.\n'
}

# ---------------------------------------------------------------------------
# Baselines
# ---------------------------------------------------------------------------

baseline_score() {
    local f="$EVAL_ROOT/$1/baseline.json"
    [ -f "$f" ] || { printf 'unset\n'; return; }
    local v
    v=$(sed -n 's/.*"score"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p' "$f" | head -1)
    [ -n "$v" ] || v="unset"
    printf '%s\n' "$v"
}

write_baseline() {
    # $1 agent, $2 score, $3 gates
    local agent="$1" score="$2" gates="$3" sha="unknown"
    if command -v git >/dev/null 2>&1; then
        sha=$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)
    fi
    cat > "$EVAL_ROOT/$agent/baseline.json" <<BASELINE
{
  "agent": "$agent",
  "score": $score,
  "gates": "$gates",
  "recorded": "$(date -u +%Y-%m-%d)",
  "commit": "$sha",
  "note": "Rubric criteria passed as a percentage, over every prompt in this eval. Gates are pass or fail and are not part of the percentage."
}
BASELINE
    info "baseline for $agent set to $score ($gates)"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

say "$SCRIPT_NAME"
say "  repo      $REPO_ROOT"
say "  results   $OUT_ROOT"
say "  agents   $AGENTS"
[ "$DO_JUDGE" -eq 0 ] && say "  grader    off (--no-judge)"
[ "$DRY_RUN" -eq 1 ] && say "  mode      DRY RUN"

for agent in $AGENTS; do
    case " $ALL_AGENTS " in
        *" $agent "*) ;;
        *) die "'$agent' is not one of the eleven: $ALL_AGENTS" ;;
    esac

    prompts=$(prompt_files "$agent")
    if [ -z "$prompts" ]; then
        warn "$agent has no prompts; skipping."
        continue
    fi

    say ""
    say "$agent"

    for pfile in $prompts; do
        pname=$(basename "$pfile" .md)
        if [ -n "$ONE_PROMPT" ]; then
            case "$pname" in
                "$ONE_PROMPT"|"$ONE_PROMPT"-*|0"$ONE_PROMPT"-*) ;;
                *) continue ;;
            esac
        fi
        pdir="$OUT_ROOT/$agent/$pname"
        run_prompt "$agent" "$pfile" "$pdir"
        [ "$DRY_RUN" -eq 1 ] && continue
        score_prompt "$agent" "$pfile" "$pdir"
        [ "$KEEP_WORKSPACE" -eq 1 ] || rm -rf "$pdir/workspace"
    done
done

[ "$DRY_RUN" -eq 1 ] && { say ""; say "Dry run. Nothing was executed."; exit 0; }

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

{
    printf 'Fleet smoke evals - %s\n\n' "$STAMP"
    printf '%-16s %-8s %-8s %-10s %-10s %s\n' AGENT GATES RUBRIC BASELINE DELTA VERDICT
    for agent in $AGENTS; do
        rows=$(awk -F'\t' -v a="$agent" 'NR > 1 && $1 == a' "$SUMMARY_TSV")
        [ -n "$rows" ] || continue
        gates_failed=$(printf '%s\n' "$rows" | awk -F'\t' '$3 == "FAIL" || $4 == "FAIL"' | wc -l | tr -d ' ')
        passed=$(printf '%s\n' "$rows" | awk -F'\t' '{s += $5} END {print s + 0}')
        total=$(printf '%s\n' "$rows" | awk -F'\t' '{s += $6} END {print s + 0}')
        if [ "$total" -gt 0 ]; then
            score=$(awk -v p="$passed" -v t="$total" 'BEGIN {printf "%.0f", 100 * p / t}')
        else
            score="0"
        fi
        base=$(baseline_score "$agent")
        if [ "$base" = "unset" ]; then
            delta="n/a"
        else
            delta=$(awk -v s="$score" -v b="$base" 'BEGIN {printf "%+d", s - b}')
        fi
        if [ "$gates_failed" -gt 0 ]; then
            verdict="FAIL ($gates_failed gate)"
        elif [ "$base" != "unset" ] && [ "$(awk -v s="$score" -v b="$base" 'BEGIN {print (s < b - 5) ? 1 : 0}')" = "1" ]; then
            verdict="REGRESSED"
        else
            verdict="ok"
        fi
        printf '%-16s %-8s %-8s %-10s %-10s %s\n' \
            "$agent" "$([ "$gates_failed" -gt 0 ] && echo "$gates_failed FAIL" || echo ok)" \
            "$score%" "$base" "$delta" "$verdict"
        if [ "$UPDATE_BASELINE" -eq 1 ]; then
            write_baseline "$agent" "$score" "$([ "$gates_failed" -gt 0 ] && echo failing || echo passing)"
        fi
    done
    printf '\nRows: %s\n' "$SUMMARY_TSV"
} | tee "$SUMMARY_TXT"

say ""
if [ "$RUN_FAILED" -eq 1 ]; then
    say "One or more gates failed. Read $SUMMARY_TXT, then the handoff.txt and"
    say "checks.txt under $OUT_ROOT."
    exit 1
fi
say "All gates passed."
exit 0
