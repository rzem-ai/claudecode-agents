#!/usr/bin/env bash
#
# board-hook-contract.sh - hold the board hooks to the runtime's actual event
# shapes, and to the rule that a hook may move a card only on evidence.
#
# Every field asserted here was read out of the shipped CLI's own zod schemas
# rather than the docs pages, which truncate:
#
#   TaskCompleted   task_id, task_subject, task_description?, teammate_name?,
#                   team_name?                    (no task_title, no task_name)
#   SubagentStart   agent_id, agent_type          (no spawn prompt of any name)
#   SubagentStop    stop_hook_active, agent_id, agent_transcript_path,
#                   agent_type, last_assistant_message?, background_tasks?
#                                                 (no status, no completion_reason)
#
# Three of the fleet's hooks were reading fields from that "no" column. A hook
# that reads a field which does not exist does not fail loudly - it silently
# takes its fallback path forever, and the fallback looked like normal
# operation. These cases exist so that never goes unnoticed again.
#
# Usage:  evals/lib/board-hook-contract.sh [-v]
#
# Nothing here touches a real board: CLAUDECODE_AGENTS_BOARD=off for the offline
# cases, a throwaway config and state directory, and the live pass below runs
# against a board root created under $TMP.

set -uo pipefail

VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$LIB_DIR/../.." && pwd)
HOOKS="$REPO_ROOT/claudecode-agents/hooks"

command -v jq >/dev/null 2>&1 || {
    printf 'board-hook-contract: jq is needed to drive the hooks\n' >&2; exit 2; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/board-hook-contract.XXXXXX") || exit 2
trap 'rm -rf "$TMP"' EXIT

export CLAUDECODE_AGENTS_CONFIG_DIR="$TMP/config"
export CLAUDECODE_AGENTS_STATE_DIR="$TMP/state"
export CLAUDECODE_AGENTS_BOARD=off
# The library defaults the board root to $HOME/.memory. Nothing offline here
# ever spawns the binary, but the default is not something a test suite should
# be one bug away from writing into: point it at the throwaway tree instead.
export CLAUDECODE_AGENTS_BOARD_ROOT="$TMP/no-board"
mkdir -p "$CLAUDECODE_AGENTS_CONFIG_DIR" "$CLAUDECODE_AGENTS_STATE_DIR"

# Board items are the plugin's own task ids, not UUIDs. The hooks uppercase a
# ref before logging, so assertions match the resolved id rather than the text
# that happened to be in the task subject.
PAGE_A=BD-1
PAGE_B=BD-2

PASSED=0
FAILED=0

# run <hook> <json> -> writes exit code to $RC, hook log to $LOG
run_hook() {
    local hook="$1" json="$2"
    LOG="$TMP/log.$$"
    : > "$LOG"
    RC=0
    printf '%s' "$json" | BOARD_LOG_FILE="$LOG" "$HOOKS/$hook" >"$TMP/out" 2>"$TMP/err" || RC=$?
}

check() {
    # $1 case name, $2 description of the requirement, $3 predicate result (0 ok)
    if [ "$3" -eq 0 ]; then
        PASSED=$((PASSED + 1))
        printf '  ok    %-42s %s\n' "$1" "$2"
    else
        FAILED=$((FAILED + 1))
        printf '  FAIL  %-42s %s\n' "$1" "$2"
        if [ "$VERBOSE" -eq 1 ]; then
            printf '        exit=%s\n' "$RC"
            sed 's/^/        log: /' "$LOG" 2>/dev/null | head -10
        fi
    fi
}

log_has() { grep -qF "$1" "$LOG" 2>/dev/null; }

printf '\nTaskCompleted: the documented subject field\n'

# R05. The runtime sends task_subject. A marker in it must bind the item.
run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship the refresh [board:$PAGE_A]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$s}')"
log_has "names board item $PAGE_A"; check task_subject-binds "a [board:] marker in task_subject resolves the item" $?

# The legacy names stay readable, so an older build is not broken by the fix.
run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship the refresh [board:$PAGE_A]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_title:$s}')"
log_has "names board item $PAGE_A"; check task_title-fallback "the legacy task_title is still read as a fallback" $?

# Subject wins when both are present and disagree.
run_hook board-task-completed.sh \
    "$(jq -nc --arg a "Real [board:$PAGE_A]" --arg b "Stale [board:$PAGE_B]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$a,task_title:$b}')"
log_has "names board item $PAGE_A" && ! log_has "$PAGE_B"; check subject-wins "task_subject wins over a conflicting task_title" $?

# A ref is a BD id in any case, a sub-task id, or a task file path. A
# tracker URL and a UUID are not refs.
run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship the refresh [board:bd-12]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$s}')"
log_has "names board item BD-12"; check identifier-binds "a lower-case id resolves, uppercased" $?

run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship [board:BD-12.3]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$s}')"
log_has "names board item BD-12.3"; check subtask-binds "a sub-task id resolves" $?

run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship [board:/home/x/.memory/board/tasks/BD-12 - Ship-the-refresh.md]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$s}')"
log_has "names board item BD-12" && ! log_has "SHIP"; check path-binds "a task file path resolves to its id, not its title" $?

run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship [board:https://tracker.example/team/issue/ABC-123/fix-thing-2]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$s}')"
! log_has "names board item"; check url-is-not-a-ref "a tracker URL is not a ref" $?

run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship [board:11111111-1111-1111-1111-111111111111]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$s}')"
! log_has "names board item"; check uuid-is-not-a-ref "a UUID is no longer a ref" $?

printf '\nTaskCompleted: only an explicit issue task closes an issue\n'

# R06. Bind two items in the session, then complete an unmarked task. Neither
# item may move: the old code picked whichever was touched most recently.
mkdir -p "$CLAUDECODE_AGENTS_STATE_DIR/sessions/s2"
printf '%s\n' "$PAGE_A" > "$CLAUDECODE_AGENTS_STATE_DIR/sessions/s2/last-item"
printf '%s\n' "$PAGE_B" > "$CLAUDECODE_AGENTS_STATE_DIR/sessions/s2/last-item"
run_hook board-task-completed.sh \
    "$(jq -nc --arg c "$TMP" '{session_id:"s2",cwd:$c,task_id:"t2",task_subject:"Fix the parser"}')"
! log_has "$PAGE_A" && ! log_has "$PAGE_B"; check unmarked-moves-nothing "an unmarked execution task moves no card" $?
log_has "no column moves"; check unmarked-explains "and says why, rather than failing silently" $?

# The environment binding must not close an issue either. It says which item is
# in flight, never that this task finished it.
run_hook board-task-completed.sh \
    "$(CLAUDECODE_AGENTS_BOARD_PAGE_ID=$PAGE_A jq -nc --arg c "$TMP" \
        '{session_id:"s3",cwd:$c,task_id:"t3",task_subject:"Partial work"}')"
! log_has "$PAGE_A"; check env-does-not-close "CLAUDECODE_AGENTS_BOARD_PAGE_ID alone does not close an issue" $?

printf '\nTaskCompleted: the gate tests the checkout that did the work\n'

# R03. Parent tree passes, worktree fails. The hook is told cwd=worktree and
# CLAUDE_PROJECT_DIR=parent, which is exactly what an isolated coder produces.
mkdir -p "$TMP/parent/.claude" "$TMP/worktree/.claude"
printf 'pass\n' > "$TMP/parent/.claude/test-status"
printf 'fail\nassertion failed in session.test.ts\n' > "$TMP/worktree/.claude/test-status"
RC=0
printf '%s' "$(jq -nc --arg c "$TMP/worktree" \
    '{session_id:"s4",cwd:$c,task_id:"t4",task_subject:"done"}')" \
    | CLAUDE_PROJECT_DIR="$TMP/parent" BOARD_LOG_FILE="$TMP/log.$$" \
      "$HOOKS/board-task-completed.sh" >"$TMP/out" 2>"$TMP/err" || RC=$?
LOG="$TMP/log.$$"
[ "$RC" -eq 2 ]; check worktree-is-tested "a failing worktree blocks even when the parent passes" $?

# R03, the other half: a pass that predates the code it approves is not evidence.
mkdir -p "$TMP/stale/.claude"
printf 'pass\n' > "$TMP/stale/.claude/test-status"
sleep 1
printf 'console.log("edited after the tests ran")\n' > "$TMP/stale/app.js"
run_hook board-task-completed.sh \
    "$(jq -nc --arg c "$TMP/stale" '{session_id:"s5",cwd:$c,task_id:"t5",task_subject:"done"}')"
log_has "has been modified since"; check stale-pass-ignored "a pass older than the tree is not treated as a pass" $?

# A fresh pass on an untouched tree still works, or the gate is just broken.
mkdir -p "$TMP/fresh/.claude"
printf 'console.log("code")\n' > "$TMP/fresh/app.js"
sleep 1
printf 'pass\n' > "$TMP/fresh/.claude/test-status"
run_hook board-task-completed.sh \
    "$(jq -nc --arg c "$TMP/fresh" '{session_id:"s6",cwd:$c,task_id:"t6",task_subject:"done"}')"
[ "$RC" -eq 0 ] && log_has "tests pass; moving to"; check fresh-pass-honoured "a pass newer than the tree is still honoured" $?

# A missing cwd means there is no checkout to verify, so it must refuse.
run_hook board-task-completed.sh \
    '{"session_id":"s7","cwd":"/nonexistent/nowhere","task_id":"t7","task_subject":"done"}'
[ "$RC" -eq 2 ]; check absent-cwd-blocks "an unusable cwd blocks rather than testing \$PWD" $?

printf '\nSubagentStart: binding without a spawn prompt\n'

# R07. The documented event carries agent identity only. With a session
# binding it must record the item; without one it must do nothing and say so.
run_hook board-subagent-start.sh \
    '{"session_id":"s8","agent_id":"a1","agent_type":"claudecode-agents:coder"}'
log_has "unbound"; check start-unbound-noop "a documented-shape start event with no binding moves nothing" $?

RC=0
printf '%s' '{"session_id":"s9","agent_id":"a2","agent_type":"claudecode-agents:coder"}' \
    | CLAUDECODE_AGENTS_BOARD_PAGE_ID="$PAGE_A" BOARD_LOG_FILE="$TMP/log.$$" \
      "$HOOKS/board-subagent-start.sh" >"$TMP/out" 2>"$TMP/err" || RC=$?
LOG="$TMP/log.$$"
log_has "picked up $PAGE_A"; check start-env-binds "an explicit session binding is recorded" $?

printf '\nSubagentStop: no status field exists\n'

# R15. The runtime sends no status, so the hook must not claim it saw one.
# This asserts the honest log line, not a behaviour change: the Blocked-on-
# failure path stays unreachable until the runtime emits something to reach it.
run_hook board-subagent-stop.sh \
    "$(jq -nc '{session_id:"s10",agent_id:"a3",agent_type:"claudecode-agents:scout",
                stop_hook_active:false,agent_transcript_path:"/dev/null",
                last_assistant_message:"## Done\n- x\n\n## Not done\n- none\n\n## Unverified\n- none\n\n## Decisions needed\n- none\n"}')"
log_has "no status field on SubagentStop"; check stop-status-honest "the hook records that no status field is sent" $?

printf '\nSubagentStop: a structured-output run carries no handoff\n'

# Measured against Claude Code 2.1.236 with a live probe, not read from docs: a
# subagent spawned from a workflow with a schema is forced through
# StructuredOutput, and its SubagentStop payload OMITS last_assistant_message
# entirely. Not JSON in that field, not an empty string - the key is absent.
#
# The hook read it as `// ""`, treated the absent status as success, and failed
# validate_handoff with "the final message is empty", exiting 2. Every workflow
# spawns fleet agents with schemas - scout and reviewer in review-round,
# researcher in deep-research, scout and spec-writer in spec-to-plan - and the
# SubagentStop matcher covers all ten fleet names, so the gate had been
# refusing to let those runs stop. Scoping the matcher (README item 12) fixed
# this for the built-in Plan and general-purpose lanes; it cannot help when the
# schema-carrying agent is itself a fleet agent.
#
# A run with no handoff field is not a malformed handoff. It is a run that was
# never asked for one.
run_hook board-subagent-stop.sh \
    "$(jq -nc '{session_id:"s11",agent_id:"a4",agent_type:"claudecode-agents:scout",
                stop_hook_active:false,agent_transcript_path:"/dev/null"}')"
[ "$RC" -eq 0 ]; check stop-structured-run-passes "a schema-spawned run with no handoff field is not a malformed handoff" $?

# A guard on the validator, NOT coverage of the empty-handoff case. The runtime
# builds the field as `.trim() || void 0`, so `last_assistant_message: ""` never
# actually arrives - an empty handoff drops the key instead, and the transcript
# section below is what catches it. This case stays because it stops a future
# reader from deciding that empty is close enough to absent, but it should not
# be counted as proof that an empty handoff is refused.
run_hook board-subagent-stop.sh \
    "$(jq -nc '{session_id:"s12",agent_id:"a5",agent_type:"claudecode-agents:scout",
                stop_hook_active:false,agent_transcript_path:"/dev/null",
                last_assistant_message:""}')"
[ "$RC" -eq 2 ]; check stop-empty-message-blocks "an empty final message is still a malformed handoff" $?

# And prose in place of the four headings stays refused, so the fix cannot be a
# blanket softening of the gate.
run_hook board-subagent-stop.sh \
    "$(jq -nc '{session_id:"s13",agent_id:"a6",agent_type:"claudecode-agents:scout",
                stop_hook_active:false,agent_transcript_path:"/dev/null",
                last_assistant_message:"I fixed it. Looks good to me."}')"
[ "$RC" -eq 2 ]; check stop-prose-blocks "prose in place of a handoff is still refused" $?

printf '\nSubagentStop: absent means ask the transcript\n'

# The runtime builds the field as `xd(content).trim() || void 0`, so a final
# message that is empty or whitespace becomes undefined and drops out of the
# payload entirely. Two very different runs therefore arrive here IDENTICAL:
# a schema spawn, which was never asked for a handoff, and a fleet agent that
# was asked and produced nothing - which is the exact thing the gate exists to
# catch. `last_assistant_message: ""` is unreachable, so no test of it can
# cover this.
#
# agent_transcript_path is what tells them apart, and both shapes below were
# read off real transcripts from the 10 September probe: the schema run's last
# assistant content block is a StructuredOutput tool_use, the other's is text.

mk_transcript() {
    # $1 file, $2 "structured" | "text" | "emptytext" | "none"
    case "$2" in
      structured) printf '%s\n' \
        '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}' \
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{"verdict":"approve"}}]}}' > "$1" ;;
      text) printf '%s\n' \
        '{"type":"assistant","message":{"content":[{"type":"text","text":"## Done\n- x\n\n## Not done\n- None\n\n## Unverified\n- None\n\n## Decisions needed\n- None"}]}}' > "$1" ;;
      emptytext) printf '%s\n' \
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}' \
        '{"type":"assistant","message":{"content":[{"type":"text","text":"   "}]}}' > "$1" ;;
      none) printf '%s\n' '{"type":"user","message":{"content":[]}}' > "$1" ;;
    esac
}

stop_absent() {
    # $1 transcript path (may not exist)
    jq -nc --arg t "$1" '{session_id:"s20",agent_id:"a20",agent_type:"claudecode-agents:scout",
                          stop_hook_active:false,agent_transcript_path:$t}'
}

mk_transcript "$TMP/t-structured.jsonl" structured
run_hook board-subagent-stop.sh "$(stop_absent "$TMP/t-structured.jsonl")"
[ "$RC" -eq 0 ] && log_has "StructuredOutput"; check stop-transcript-structured-passes "a StructuredOutput final block is a run that owed no handoff" $?

# The case the gate exists for, and the one it had stopped catching.
mk_transcript "$TMP/t-empty.jsonl" emptytext
run_hook board-subagent-stop.sh "$(stop_absent "$TMP/t-empty.jsonl")"
[ "$RC" -eq 2 ]; check stop-transcript-empty-handoff-blocks "a fleet agent that was asked and said nothing still fails" $?

# A text block that IS a handoff can only reach here if the runtime dropped a
# field it should have sent; recover it rather than guess.
mk_transcript "$TMP/t-text.jsonl" text
run_hook board-subagent-stop.sh "$(stop_absent "$TMP/t-text.jsonl")"
[ "$RC" -eq 0 ]; check stop-transcript-recovers-a-handoff "a recoverable handoff is read rather than refused" $?

# Cannot tell is not the same as either answer, and it must not deadlock a run.
run_hook board-subagent-stop.sh "$(stop_absent "$TMP/nonexistent.jsonl")"
[ "$RC" -eq 0 ] && log_has "could not be read"; check stop-transcript-unreadable-passes "an unreadable transcript says so and lets the run stop" $?

run_hook board-subagent-stop.sh \
    "$(jq -nc '{session_id:"s21",agent_id:"a21",agent_type:"claudecode-agents:scout",stop_hook_active:false}')"
[ "$RC" -eq 0 ]; check stop-no-transcript-path-passes "and so does an event carrying no transcript path at all" $?

mk_transcript "$TMP/t-none.jsonl" none
run_hook board-subagent-stop.sh "$(stop_absent "$TMP/t-none.jsonl")"
[ "$RC" -eq 0 ]; check stop-transcript-no-assistant-passes "a transcript with no assistant content decides nothing" $?

# `last` was taken over a list already filtered to StructuredOutput-or-text, so
# a final block that is neither - an ordinary tool call with no closing prose -
# was invisible and the reader reached back to an EARLIER text block and called
# it the final message. That re-created the original failure: exit 2, telling an
# agent to re-emit a handoff, quoting text that was never one.
printf '%s\n' \
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check the config file."}]}}' \
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}' \
  > "$TMP/t-trailing-tool.jsonl"
run_hook board-subagent-stop.sh "$(stop_absent "$TMP/t-trailing-tool.jsonl")"
[ "$RC" -eq 0 ]; check stop-transcript-trailing-tool-passes "a transcript ending in a tool call is not a handoff to validate" $?
log_has "ends in text"; [ $? -ne 0 ]; check stop-transcript-does-not-claim-text "and the hook does not claim it ended in text" $?

# The discriminator has to discriminate: any tool_use last must not read as a
# StructuredOutput one, or the load-bearing test of the whole fix proves nothing.
printf '%s\n' \
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{"a":1}}]}}' \
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{}}]}}' \
  > "$TMP/t-tool-after-structured.jsonl"
run_hook board-subagent-stop.sh "$(stop_absent "$TMP/t-tool-after-structured.jsonl")"
log_has "StructuredOutput"; [ $? -ne 0 ]; check stop-transcript-tool-is-not-structured "a later ordinary tool call is not read as structured output" $?

# Only assistant turns speak for the agent.
printf '%s\n' \
  '{"type":"assistant","message":{"content":[{"type":"text","text":"## Done\n- x\n\n## Not done\n- None\n\n## Unverified\n- None\n\n## Decisions needed\n- None"}]}}' \
  '{"type":"user","message":{"content":[{"type":"text","text":"not the agent talking"}]}}' \
  > "$TMP/t-user-last.jsonl"
run_hook board-subagent-stop.sh "$(stop_absent "$TMP/t-user-last.jsonl")"
[ "$RC" -eq 0 ]; check stop-transcript-ignores-user-turns "a user turn after the agent's does not become the handoff" $?

# The `!= yes` hardening: a payload jq cannot read must not fall through and be
# validated as an empty handoff.
RC=0
printf '' | BOARD_LOG_FILE="$TMP/log.$$" "$HOOKS/board-subagent-stop.sh" >"$TMP/out" 2>"$TMP/err" || RC=$?
[ "$RC" -eq 0 ]; check stop-empty-stdin-does-not-block "empty stdin is not a malformed handoff" $?

printf '\nSubagentStop: the matcher covers the whole roster\n'

# The matcher is what decides whether an agent's handoff is checked at all, so
# an agent missing from it fails open and silently: no format gate, no card
# comment, and no route to the human queue for its blockers.
MATCHER=$(jq -r '.hooks.SubagentStop[0].matcher' "$HOOKS/hooks.json")
for agent in lead scout spec-writer coder reviewer ui-designer tech-writer researcher fleet-steward refuter; do
    printf '%s' "$MATCHER" | grep -q "[(|]$agent[|)]"
    check "matcher-$agent" "the matcher names $agent" $?
done

printf '\nhooks.json: the plugin-root placeholder must survive to the runtime\n'

# ${CLAUDE_PLUGIN_ROOT} is resolved after the command string reaches a shell,
# and single quotes are precisely the quoting that forbids expansion: the
# session looks for a file literally named ${CLAUDE_PLUGIN_ROOT}/... and every
# hook fails open, non-blocking, on every tool call - the board writes and the
# scope guard together. Found live on 11 September 2026, not by this suite,
# because the suite runs the hook scripts directly by path and so validated
# everything about them except whether a session could find them.
RC=0
jq -r '.hooks[][].hooks[].command' "$HOOKS/hooks.json" | grep -qF "'\${CLAUDE_PLUGIN_ROOT}" && RC=1
check commands-not-single-quoted "no command single-quotes the plugin-root placeholder" $RC

RC=0
jq -r '.hooks[][].hooks[].command' "$HOOKS/hooks.json" | grep -qvF '${CLAUDE_PLUGIN_ROOT}' && RC=1
check commands-use-plugin-root "every command locates its script by the plugin root" $RC

printf '\nThe library: an empty comment never reaches the binary\n'

# board_comment already refuses a whitespace-only text, but board_comment_raw is
# the other public entry point and had no guard of its own: a caller reaching it
# directly could post a card comment that says nothing at all. Not reachable
# from the three hooks, so the library is called directly here. Nothing leaves
# the process either way: board_comment_raw never consults the enable switch,
# so the guard is the only thing that can stop the call reaching the shim.
RC=0
LOG="$TMP/log.raw"
: > "$LOG"
(
    BOARD_LOG_FILE="$LOG"
    CLAUDECODE_AGENTS_BOARD=on
    unset BOARD_DRY_RUN
    # shellcheck source=/dev/null
    . "$HOOKS/lib/board.sh"
    board_comment_raw probe BD-1 "   "
) >"$TMP/out" 2>"$TMP/err" || RC=$?
[ "$RC" -ne 0 ] && log_has "nothing posted"; check comment-raw-refuses-empty "board_comment_raw refuses a whitespace-only comment" $?

printf '\nLive backend: the hooks move a real item through the binary\n'

# Everything above proves the hooks read the right fields and decide the right
# thing. None of it proves the decision reaches the board, because the board
# call is exactly what CLAUDECODE_AGENTS_BOARD=off switches off. These three
# cases run the binary against a throwaway root - never the memory tree - so a
# shim that cannot be found, a status spelling the config does not hold, or a
# comment flag the CLI has renamed is caught here rather than in a real run.
#
# Which board, though. The shim prefers ~/.local/bin/board, which on an
# installed machine is a binary from some earlier build: a branch that changes
# src/cli.ts would be "live-tested" against code it did not write, and a CLI
# regression would pass here and fail in the real run. So when bun is present
# the live pass runs the checkout's own cli.ts through a wrapper and points the
# hook library at it with BOARD_SHIM, which the library honours. Only a machine
# without bun falls back to the shim and whatever it resolves.
SHIM="$REPO_ROOT/claudecode-agents/board/board.sh"
LIVE_VIA="the shim, $SHIM"
if command -v bun >/dev/null 2>&1; then
    SHIM="$TMP/board-from-checkout"
    printf '#!/usr/bin/env bash\nexec bun "%s" "$@"\n' \
        "$REPO_ROOT/claudecode-agents/board/src/cli.ts" > "$SHIM"
    chmod +x "$SHIM"
    LIVE_VIA="bun on the checkout's src/cli.ts"
fi
export BOARD_SHIM="$SHIM"
if ! "$SHIM" --version >/dev/null 2>&1; then
    printf '  skipped: board not resolvable via %s; build it with claudecode-agents/board/build.sh\n' "$LIVE_VIA"
else
    printf '  running against %s\n' "$LIVE_VIA"
    LIVE="$TMP/live"; mkdir -p "$LIVE/board"
    printf 'project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]\ndefault_status: "To Do"\n' > "$LIVE/board/config.yml"
    export CLAUDECODE_AGENTS_BOARD_ROOT="$LIVE"
    export CLAUDECODE_AGENTS_BOARD=on
    unset BOARD_DRY_RUN
    ID="$("$SHIM" task create "Live item" --json | jq -r .task.id)"

    # run_hook passes no environment, and SubagentStart's only supported binding
    # is the variable, so it is exported around the call and taken away again.
    export CLAUDECODE_AGENTS_BOARD_PAGE_ID="$ID"
    run_hook board-subagent-start.sh \
        "$(jq -nc --arg t "claudecode-agents:coder" \
            '{session_id:"live",agent_id:"a1",agent_type:$t}')"
    unset CLAUDECODE_AGENTS_BOARD_PAGE_ID
    [ "$("$SHIM" task view "$ID" --json | jq -r .task.status)" = "Doing" ]; check live-start-doing "SubagentStart moves the item to Doing" $?

    # No status field: the runtime does not send one (see the header), so the
    # route to the human queue is a Blocker: line, and that is what is driven here.
    run_hook board-subagent-stop.sh \
        "$(jq -nc '{session_id:"live",agent_id:"a1",agent_type:"claudecode-agents:coder",
                    stop_hook_active:false,agent_transcript_path:"/dev/null",
                    last_assistant_message:"## Done\n- Moved a live item through the binary\n\n## Not done\n- None\n\n## Unverified\n- None\n\n## Decisions needed\n- Blocker: which key?\n"}')"
    [ "$("$SHIM" task view "$ID" --json | jq -r .task.status)" = "Blocked by human" ]; check live-blocker "a Blocker: line moves the item to Blocked by human" $?

    # The author is "@$HOOK", and HOOK is the hook's own name - SubagentStop,
    # not the script's filename. The comment body is .body, not .content.
    "$SHIM" task view "$ID" --json \
        | jq -e '.task.comments[] | select(.author == "@SubagentStop") | select(.body | test("which key"))' >/dev/null
    check live-comment "the blocker text lands as an authored comment" $?

    export CLAUDECODE_AGENTS_BOARD=off
fi

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
if [ "$FAILED" -ne 0 ]; then
    printf 'A board hook is reading a field the runtime does not send, or moving a card without evidence.\n'
    exit 1
fi
printf 'The board hooks match the runtime event shapes and move cards only on evidence.\n'
