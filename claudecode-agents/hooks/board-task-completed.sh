#!/usr/bin/env bash
# TaskCompleted: one hook, two outcomes.
#
#   tests pass -> move the board item to Done, exit 0.
#   tests fail -> move the board item to Blocked with a comment saying the test
#                 gate failed and how, then exit 2 so the task cannot be marked
#                 complete.
#
# The comment takes the same shape as the ones board-subagent-stop.sh posts: a
# headline naming the transition and its source, then the detail underneath. This
# hook never sees a handoff - it has the task title, the test command or the
# marker file, and the output - so the comment says only those things.
#
# The board write happens on both paths, and it happens before the exit, so the
# gate firing never costs the board its update. A board that cannot be written
# never changes the verdict: the exit 2 is about the tests and nothing else.
#
# "Tests pass" is not something the harness tells us, so it is resolved in
# order: a configured test command, then a test-status marker file, then the
# gate mode. See hooks/README.md, "The test gate".
set -euo pipefail

HOOK=TaskCompleted
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/board.sh
. "$HOOK_DIR/lib/board.sh"

trap 'board_log "$HOOK" "unexpected error on line $LINENO; task allowed through"; exit 0' ERR

CLAUDECODE_AGENTS_TEST_GATE="${CLAUDECODE_AGENTS_TEST_GATE:-lenient}"
CLAUDECODE_AGENTS_TEST_COMMAND="${CLAUDECODE_AGENTS_TEST_COMMAND:-}"
CLAUDECODE_AGENTS_TEST_TIMEOUT="${CLAUDECODE_AGENTS_TEST_TIMEOUT:-300}"
CLAUDECODE_AGENTS_TEST_STATUS_MAX_AGE="${CLAUDECODE_AGENTS_TEST_STATUS_MAX_AGE:-3600}"

file_mtime() {
  stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1" 2>/dev/null || printf '0'
}

input="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  board_log "$HOOK" "jq is not installed, so the test gate cannot run. Task allowed through. Install jq (macOS: brew install jq)."
  exit 0
fi

session_id="$(printf '%s' "$input" | jq -r '.session_id // ""')"
cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
export BOARD_CWD="$cwd"
task_id="$(printf '%s' "$input" | jq -r '.task_id // ""')"
# `task_subject` is the field the runtime actually sends. Checked against the
# TaskCompleted schema in the shipped CLI, which carries task_id, task_subject,
# task_description, teammate_name and team_name - and neither `task_title` nor
# `task_name`, which appear nowhere in the binary. Those two are kept only as
# fallbacks for an older build; on this one they never match, which is why every
# completion used to fall through to the last-item guess below.
task_title="$(printf '%s' "$input" | jq -r '.task_subject // .task_title // .task_name // ""')"

# The checkout that produced the work, not whatever CLAUDE_PROJECT_DIR happens
# to name. coder runs with `isolation: worktree`, so when a completion is
# emitted from a worktree the project variable still points at the parent - and
# testing the parent lets a passing parent approve failing worktree code.
# There is no safe default here: if we cannot see the directory the work
# happened in, we cannot verify it, so refuse rather than test the wrong tree.
work_dir="$cwd"
if [ -z "$work_dir" ] || [ ! -d "$work_dir" ]; then
  trap - ERR
  printf 'Cannot verify completion: the hook received no usable cwd, so there is no checkout to test.\n' >&2
  exit 2
fi
work_dir="$(cd "$work_dir" && pwd -P)"

# ------------------------------------------------------------ the board item
#
# Native tasks are not board items - most of them should resolve to nothing at
# all, and that is correct rather than a failure. Only a task whose title
# carries a [board:<id>] marker, or a session with exactly one item in flight,
# moves a column.
#
# The marker is the whole binding, and nothing else stands in for it. The old
# fallbacks - the item most recently picked up in this session, then
# CLAUDECODE_AGENTS_BOARD_PAGE_ID - both answered "which item is in flight?" when
# the question is "does *this task* finish that issue?". An issue with twenty
# execution tasks went to Done on the first one, and with two items in flight
# it went to Done on whichever was touched last. Guessing an item is worse than
# moving nothing: a card that silently says Done is read as finished work.
page_id=""
if page_id="$(page_id_from_task_title "$task_title")"; then
  board_log "$HOOK" "task \"$task_title\" names board item $page_id"
else
  page_id=""
  board_log "$HOOK" "task ${task_id:-unknown} carries no [board:...] marker, so it is an execution task rather than the completion of a tracked issue; the gate still runs, no column moves"
fi

# --------------------------------------------------------------- the verdict
verdict=""        # pass | fail | unknown
detail=""

if [ -n "$CLAUDECODE_AGENTS_TEST_COMMAND" ]; then
  runner=""
  if [ "$CLAUDECODE_AGENTS_TEST_TIMEOUT" -gt 0 ] 2>/dev/null; then
    if command -v timeout >/dev/null 2>&1; then
      runner="timeout $CLAUDECODE_AGENTS_TEST_TIMEOUT"
    elif command -v gtimeout >/dev/null 2>&1; then
      runner="gtimeout $CLAUDECODE_AGENTS_TEST_TIMEOUT"
    fi
  fi
  board_log "$HOOK" "running the test command in $work_dir: $CLAUDECODE_AGENTS_TEST_COMMAND"
  # Run it as the condition of an if, not after `set +e`: the ERR trap fires on
  # any failing command regardless of errexit, and a failing test suite is the
  # expected case here, not an unexpected error.
  # bash -c, not eval of "$runner $CMD": prefixing timeout as text onto the
  # command breaks anything compound. "cd app && npm test" became
  # "timeout 300 cd app && npm test", which fails on `timeout cd` and never
  # runs the suite - and the gate then blocks the task for tests that were
  # never executed. Running the command as one shell string keeps pipelines,
  # && chains and loops working, with or without timeout present.
  if out="$(cd "$work_dir" && $runner bash -c "$CLAUDECODE_AGENTS_TEST_COMMAND" 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    verdict=pass
    detail="\`$CLAUDECODE_AGENTS_TEST_COMMAND\` passed."
  else
    verdict=fail
    detail="$(printf '`%s` exited %s.\n\nLast lines of output:\n\n%s' \
      "$CLAUDECODE_AGENTS_TEST_COMMAND" "$rc" "$(printf '%s\n' "$out" | tail -15 | cut -c1-200)")"
  fi
fi

# Is any file in the work tree newer than the marker? An age window alone
# cannot answer "did this pass happen after the code it is approving?" - inside
# a one-hour lifetime you can edit a file and the old pass still approves it.
# Comparing against the tree does answer it, without needing a trusted runner to
# stamp a commit into the marker. -quit stops at the first hit, so this stays
# cheap even on a large checkout.
tree_changed_since() {
  # $1 marker file, $2 work dir
  [ -n "$(find "$2" \
      \( -name .git -o -name node_modules -o -name .claude -o -name dist \
         -o -name build -o -name target -o -name .venv -o -name __pycache__ \) -prune -o \
      -type f -newer "$1" -print -quit 2>/dev/null)" ]
}

status_file="${CLAUDECODE_AGENTS_TEST_STATUS_FILE:-$work_dir/.claude/test-status}"
if [ -z "$verdict" ] && [ -f "$status_file" ]; then
  age=$(( $(date +%s) - $(file_mtime "$status_file") ))
  word="$(head -1 "$status_file" | tr -d '\r' | awk '{print tolower($1)}')"
  case "$word" in
    # A failure is honoured whatever its age. Trust here is asymmetric on
    # purpose: a stale "fail" can only block a completion, which is safe, while
    # a stale "pass" approves code it never saw.
    fail|failed|red)
      verdict=fail
      detail="$(printf '%s reports a failure.\n\n%s' "$status_file" "$(sed -n '2,16p' "$status_file" | cut -c1-200)")" ;;
    pass|passed|ok|green)
      if [ "$age" -gt "$CLAUDECODE_AGENTS_TEST_STATUS_MAX_AGE" ]; then
        board_log "$HOOK" "$status_file reports a pass but is ${age}s old (limit ${CLAUDECODE_AGENTS_TEST_STATUS_MAX_AGE}s); treating it as stale"
      elif tree_changed_since "$status_file" "$work_dir"; then
        board_log "$HOOK" "$status_file reports a pass, but $work_dir has been modified since it was written, so it is not evidence about the current code; ignoring it"
      else
        verdict=pass; detail="$status_file reports a pass, and nothing in $work_dir has changed since."
      fi ;;
    *)
      board_log "$HOOK" "$status_file does not start with pass or fail (found \"$word\"); ignoring it" ;;
  esac
fi

if [ -z "$verdict" ]; then
  verdict=unknown
fi

# Which run this was, for the archive a cut comment points at. This hook's own
# comment is bounded well under the cap - the test detail is at most fifteen
# lines cut to 200 characters each - so it should never be the one that cuts.
# It can be if board.env lowers BOARD_COMMENT_MAX_CHARS, and the archiving
# lives in board_cap_comment either way, so all this hook owes it is a label.
BOARD_RUN_SESSION="$session_id"
BOARD_RUN_STATUS="test gate: $verdict"

# ---------------------------------------------------------------- the outcome
case "$verdict" in
  pass)
    board_log "$HOOK" "tests pass; moving to \"$BOARD_COL_DONE\""
    board_write "$HOOK" "$page_id" "$BOARD_COL_DONE"
    exit 0
    ;;
  fail)
    board_log "$HOOK" "tests failed; moving to \"$BOARD_COL_BLOCKED\" and blocking completion"
    headline="Blocked. The test gate failed, so the task could not be marked complete."
    if [ -n "$task_title" ]; then
      headline="Blocked. The test gate failed on \"$(printf '%s' "$task_title" | cut -c1-120)\", so the task could not be marked complete."
    fi
    comment="$(printf '%s\n\n%s\n' "$headline" "$detail")"
    # The write happens first, so the exit below cannot skip it.
    board_write "$HOOK" "$page_id" "$BOARD_COL_BLOCKED" "$comment"
    trap - ERR
    {
      printf 'Tests are not passing, so this task cannot be marked complete.\n\n'
      printf '%s\n\n' "$detail"
      printf 'Fix the failures and complete the task again. The board item is in "%s".\n' "$BOARD_COL_BLOCKED"
    } >&2
    exit 2
    ;;
  *)
    if [ "$CLAUDECODE_AGENTS_TEST_GATE" = "strict" ]; then
      board_log "$HOOK" "no test result available and the gate is strict; blocking completion"
      board_write "$HOOK" "$page_id" "$BOARD_COL_BLOCKED" "$(printf '%s\n\n%s\n' \
        "Blocked. The test gate failed, so the task could not be marked complete." \
        "No test result was available and CLAUDECODE_AGENTS_TEST_GATE is strict. Set CLAUDECODE_AGENTS_TEST_COMMAND, or write the result to $status_file with pass or fail on the first line.")"
      trap - ERR
      {
        printf 'No test result was available and CLAUDECODE_AGENTS_TEST_GATE is strict, so this task\n'
        printf 'cannot be marked complete. Run the tests and write the result to %s\n' "$status_file"
        printf '(first line "pass" or "fail"), or set CLAUDECODE_AGENTS_TEST_COMMAND. See hooks/README.md.\n'
      } >&2
      exit 2
    fi
    board_log "$HOOK" "no test gate configured (no CLAUDECODE_AGENTS_TEST_COMMAND, no usable $status_file); moving to \"$BOARD_COL_DONE\" ungated. Set CLAUDECODE_AGENTS_TEST_GATE=strict to refuse instead."
    board_write "$HOOK" "$page_id" "$BOARD_COL_DONE"
    exit 0
    ;;
esac
