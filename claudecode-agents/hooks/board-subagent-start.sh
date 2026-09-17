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
# There is no spawn prompt on this event. The SubagentStart schema in the
# shipped CLI is the common fields plus agent_id and agent_type - no
# `instructions`, no `prompt`, no `initial_prompt`. The comment that used to sit
# here said the field name was "confirmed"; it was not, and the Board-Item:
# binding it promised has never fired once.
#
# The environment variable is therefore the whole supported binding: one
# dedicated session, one board item, named at launch.
#
#   CLAUDECODE_AGENTS_BOARD_PAGE_ID=1111... claude --agent claudecode-agents:lead
#
# This is narrower than the multi-item promise it replaces, and it should not be
# described as the same thing. Restoring per-agent binding needs a supported way
# to correlate a spawn with its subagent identity; a shared "latest prompt" file
# is not it, because two agents spawned together would race for the same line.
# `instructions` is still read first so that a runtime which starts sending one
# works without another change here.
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

if [ -z "$page_id" ] && [ -n "${CLAUDECODE_AGENTS_BOARD_PAGE_ID:-}" ]; then
  if page_id="$(normalise_page_id "$CLAUDECODE_AGENTS_BOARD_PAGE_ID")"; then
    source_of_id="CLAUDECODE_AGENTS_BOARD_PAGE_ID"
  else
    board_log "$HOOK" "CLAUDECODE_AGENTS_BOARD_PAGE_ID is set but is not a board item id or task file path"
    page_id=""
  fi
fi

if [ -z "$page_id" ]; then
  board_log "$HOOK" "no board item for ${agent_type:-unknown agent} (${agent_id:-no id}): this session is unbound. Launch with CLAUDECODE_AGENTS_BOARD_PAGE_ID set to bind one item to the session. Nothing moved. See hooks/README.md."
  exit 0
fi

if ! state_bind_agent "$session_id" "$agent_id" "$page_id" "$agent_type"; then
  board_log "$HOOK" "could not write the state file under $CLAUDECODE_AGENTS_STATE_DIR; later hooks will not find item $page_id"
fi

board_log "$HOOK" "${agent_type:-agent} ${agent_id:-} picked up $page_id (from the $source_of_id)"
board_write "$HOOK" "$page_id" "$BOARD_COL_DOING"

exit 0
