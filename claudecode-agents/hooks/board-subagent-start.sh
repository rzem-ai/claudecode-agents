#!/usr/bin/env bash
# SubagentStart: move the board item into Doing and record which item this
# subagent is working on, so board-subagent-stop.sh and board-task-completed.sh
# can find it again.
#
# Fails soft, always. SubagentStart cannot block a spawn, and nothing about
# the board is allowed to matter to the session.
set -euo pipefail

HOOK=SubagentStart
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/board.sh
. "$HOOK_DIR/lib/board.sh"

trap 'board_log "$HOOK" "unexpected error on line $LINENO; session continues"; exit 0' ERR

input="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  board_log "$HOOK" "jq is not installed, so no hook input can be parsed. Install jq (macOS: brew install jq)."
  exit 0
fi

session_id="$(printf '%s' "$input" | jq -r '.session_id // ""')"
agent_id="$(printf '%s' "$input" | jq -r '.agent_id // ""')"
agent_type="$(printf '%s' "$input" | jq -r '.agent_type // ""')"
cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
export BOARD_CWD="$cwd"
# There is no spawn prompt on this event - the SubagentStart schema is the
# common fields plus agent_id and agent_type - so the binding comes from the
# checkout, not the spawn. In order: the focus file the lead wrote with
# task_focus (or the human with /work), then the item this session most
# recently picked up, then the launch-time environment variable, kept last so
# a stale one in a shell never overrides a focus. `instructions` is still read
# first so that a runtime which starts sending one works without another
# change here.
instructions="$(printf '%s' "$input" | jq -r '.instructions // .prompt // .initial_prompt // ""')"

page_id=""
source_of_id=""

if [ -n "$instructions" ]; then
  if page_id="$(page_id_from_instructions "$instructions")"; then
    source_of_id="Board-Item: line in the spawn prompt"
  else
    page_id=""
  fi
fi

if [ -z "$page_id" ]; then
  if page_id="$(board_focus_id "$HOOK")"; then source_of_id="focus file"; else page_id=""; fi
fi
if [ -z "$page_id" ]; then
  if page_id="$(state_session_page_id "$session_id")"; then source_of_id="session's last item"; else page_id=""; fi
fi

if [ -z "$page_id" ] && [ -n "${CLAUDECODE_AGENTS_BOARD_PAGE_ID:-}" ]; then
  if page_id="$(normalise_page_id "$CLAUDECODE_AGENTS_BOARD_PAGE_ID")"; then
    source_of_id="CLAUDECODE_AGENTS_BOARD_PAGE_ID"
  else
    board_log "$HOOK" "CLAUDECODE_AGENTS_BOARD_PAGE_ID is set but is not a board item id or task file path"
    page_id=""
  fi
fi

if [ -z "$page_id" ]; then
  board_log "$HOOK" "no board item for ${agent_type:-unknown agent} (${agent_id:-no id}): nothing is focused in this checkout. Call task_focus <id> (or run /work <id>) before spawning against an item. Nothing moved. See hooks/README.md."
  exit 0
fi

if ! state_bind_agent "$session_id" "$agent_id" "$page_id" "$agent_type"; then
  board_log "$HOOK" "could not write the state file under $CLAUDECODE_AGENTS_STATE_DIR; later hooks will not find item $page_id"
fi

board_log "$HOOK" "${agent_type:-agent} ${agent_id:-} picked up $page_id (from the $source_of_id)"
board_write "$HOOK" "$page_id" "$BOARD_COL_DOING"

exit 0
