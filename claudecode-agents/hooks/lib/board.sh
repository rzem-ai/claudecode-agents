# shellcheck shell=bash
# Shared helpers for the board hooks. Sourced, never executed.
#
# Everything here is written for bash 3.2, because that is what /bin/bash is on
# macOS: no associative arrays, no ${var,,}, no mapfile, no globstar.
#
# The board is the plugin's own binary over a directory of markdown files in
# the memory tree. There is no endpoint, no token and no network: a status move
# is one `task edit -s`, a comment is one `task edit --comment`, and a failure
# is an exit code with its own stderr rather than an errors array smuggled
# inside a 200. Everything below is the envelope around those calls - the soft
# failure contract, the state files that bind a session to an item, and the
# archive a cut comment points at.

# Nothing here is secret any more, but a traced hook floods the transcript with
# a hundred lines nobody asked for. Keep it off.
set +x

CLAUDECODE_AGENTS_CONFIG_DIR="${CLAUDECODE_AGENTS_CONFIG_DIR:-$HOME/.config/claudecode-agents}"
CLAUDECODE_AGENTS_STATE_DIR="${CLAUDECODE_AGENTS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/claudecode-agents}"

# Defaults for everything the plan did not name. board.env overrides them.
# The five spellings are the `statuses` list the installer writes into
# board/config.yml, character for character.
BOARD_COL_TODO="${BOARD_COL_TODO:-To Do}"
BOARD_COL_DOING="${BOARD_COL_DOING:-Doing}"
BOARD_COL_BLOCKED="${BOARD_COL_BLOCKED:-Blocked}"
BOARD_COL_BLOCKED_HUMAN="${BOARD_COL_BLOCKED_HUMAN:-Blocked by human}"
BOARD_COL_DONE="${BOARD_COL_DONE:-Done}"

# How much of a comment reaches the card. The board takes one markdown body per
# comment and would happily store the lot, so the cap is for the reader rather
# than the backend: a card comment is a summary, and the whole text of a long
# run belongs in the archive a cut comment points at.
BOARD_COMMENT_MAX_CHARS="${BOARD_COMMENT_MAX_CHARS:-8000}"

# Which run a comment belongs to. A hook sets these before it calls board_write
# or board_comment, and the only thing that reads them is the archive a cut
# comment points at, so a hook that sets none of them still works and just gets
# an archive labelled "not recorded". Nothing here is secret and nothing here is
# ever a secret.
BOARD_RUN_SESSION="${BOARD_RUN_SESSION:-}"
BOARD_RUN_AGENT="${BOARD_RUN_AGENT:-}"
BOARD_RUN_AGENT_ID="${BOARD_RUN_AGENT_ID:-}"
BOARD_RUN_STATUS="${BOARD_RUN_STATUS:-}"

# board.env is optional. It lives in the 0700 config directory that
# permissions.deny already hides from every agent, and it is the one place a
# tree whose config.yml spells the statuses differently can say so.
if [ -f "$CLAUDECODE_AGENTS_CONFIG_DIR/board.env" ]; then
  # shellcheck disable=SC1091
  . "$CLAUDECODE_AGENTS_CONFIG_DIR/board.env"
fi

BOARD_LOG_FILE="${BOARD_LOG_FILE:-$CLAUDECODE_AGENTS_STATE_DIR/log/hooks.log}"

board_log() {
  # $1 hook name, rest message. stderr for the transcript, file for later.
  local hook="$1"; shift
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') [$hook] $*"
  printf '%s\n' "$line" >&2
  if mkdir -p "$(dirname "$BOARD_LOG_FILE")" 2>/dev/null; then
    printf '%s\n' "$line" >> "$BOARD_LOG_FILE" 2>/dev/null || true
  fi
}

# A board write must never break the session. Callers use this for anything
# that is only about the board.
board_soft_fail() {
  board_log "$1" "board write skipped: $2"
  return 1
}

board_disabled() {
  if [ "${CLAUDECODE_AGENTS_BOARD:-on}" = "off" ]; then return 0; fi
  if [ -f "$CLAUDECODE_AGENTS_STATE_DIR/disabled" ]; then return 0; fi
  return 1
}

require_tools() {
  local hook="$1" missing=""
  command -v jq >/dev/null 2>&1 || missing="$missing jq"
  if [ -n "$missing" ]; then
    board_log "$hook" "missing required tool(s):$missing. Install them (macOS: brew install jq) or the board hooks cannot run. Session continues."
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------- state files
#
# The state directory is how a later hook finds the board item a subagent was
# spawned against. See README, "Which board item".

state_session_dir() {
  # $1 session_id
  local sid="${1:-unknown-session}"
  sid="$(printf '%s' "$sid" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/sessions/%s' "$CLAUDECODE_AGENTS_STATE_DIR" "$sid"
}

state_bind_agent() {
  # $1 session_id, $2 agent_id, $3 page_id, $4 agent_type
  local dir; dir="$(state_session_dir "$1")"
  local aid; aid="$(printf '%s' "${2:-unknown-agent}" | tr -c 'A-Za-z0-9._-' '_')"
  local old_umask; old_umask="$(umask)"
  umask 077
  mkdir -p "$dir/agents" 2>/dev/null || { umask "$old_umask"; return 1; }
  {
    printf 'page_id=%s\n' "$3"
    printf 'agent_type=%s\n' "$4"
    printf 'bound_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } > "$dir/agents/$aid" 2>/dev/null || { umask "$old_umask"; return 1; }
  # Session-level pointer: the item most recently picked up in this session.
  # TaskCompleted has no agent_id, so this is its last resort.
  printf '%s\n' "$3" > "$dir/last-item" 2>/dev/null || true
  umask "$old_umask"
  return 0
}

state_agent_page_id() {
  # $1 session_id, $2 agent_id
  local dir; dir="$(state_session_dir "$1")"
  local aid; aid="$(printf '%s' "${2:-unknown-agent}" | tr -c 'A-Za-z0-9._-' '_')"
  [ -f "$dir/agents/$aid" ] || return 1
  local v
  v="$(sed -n 's/^page_id=//p' "$dir/agents/$aid" | head -1)"
  [ -n "$v" ] || return 1
  printf '%s\n' "$v"
}

state_session_page_id() {
  local dir; dir="$(state_session_dir "$1")"
  [ -f "$dir/last-item" ] || return 1
  local v; v="$(head -1 "$dir/last-item")"
  [ -n "$v" ] || return 1
  printf '%s\n' "$v"
}

# ---------------------------------------------------------------- run archives
#
# Where the overflow of a cut comment goes. A comment too long for a card is cut,
# and the note on the end of it names a file written here. Before this existed
# the note pointed at a "run transcript" that nothing anywhere writes, so the one
# message telling the human there was more to read pointed at nothing, on exactly the
# runs with the most to say.
#
# The archive goes in the state directory and never in the hook's cwd. The coder
# runs with isolation: worktree, so its cwd is a git worktree under
# .claude/worktrees/ that goes away with the session - an archive written there
# would vanish with the thing it exists to outlive.
#
# Layout, one file per cut comment:
#
#   archives/<session_id>/<UTC timestamp>-<agent, or the hook if there is none>.md
#
# Session first, because a session id is what a person has in hand when they come
# back to a run; agent and timestamp in the name, because that is what tells two
# cut comments in one session apart without opening either. Nothing prunes them.

board_archive_dir() {
  local sid
  sid="$(printf '%s' "${BOARD_RUN_SESSION:-}" | tr -c 'A-Za-z0-9._-' '_')"
  [ -n "$sid" ] || sid="unknown-session"
  printf '%s/archives/%s' "$CLAUDECODE_AGENTS_STATE_DIR" "$sid"
}

# board_archive_comment HOOK ITEM_REF TEXT
# Writes the full comment text with a header saying which run it came from, and
# echoes the path it wrote. Returns 1, having logged why, if anything failed:
# an archive that could not be written is not a reason to lose the card comment
# as well, so the caller carries on and posts the cut text.
board_archive_comment() {
  local hook="$1" page="$2" text="$3"
  local dir file stamp name n old_umask

  dir="$(board_archive_dir)"
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  name="$(printf '%s' "${BOARD_RUN_AGENT:-}" | tr -c 'A-Za-z0-9._-' '_')"
  [ -n "$name" ] || name="$hook"
  file="$dir/$stamp-$name.md"
  n=2
  while [ -e "$file" ] && [ "$n" -lt 100 ]; do
    file="$dir/$stamp-$name-$n.md"
    n=$((n + 1))
  done

  # The board is a directory of files, not a web service, so the id is the
  # whole address: `board task view BD-12` finds the item from any machine that
  # has the memory tree. No URL line, because there is no URL to print.

  # Same discipline as the session state files: 0700 on the directory, 0600 on
  # the file. Nothing in here is secret, and nothing in here is anyone else's
  # business either.
  old_umask="$(umask)"
  umask 077
  if ! mkdir -p "$dir" 2>/dev/null; then
    umask "$old_umask"
    board_log "$hook" "could not create the archive directory $dir; the full text of this comment is saved nowhere"
    return 1
  fi
  {
    printf '# Board comment archive\n\n'
    printf -- '- Written: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf -- '- Hook: %s\n' "$hook"
    printf -- '- Agent: %s%s\n' "${BOARD_RUN_AGENT:-not recorded}" "${BOARD_RUN_AGENT_ID:+ ($BOARD_RUN_AGENT_ID)}"
    printf -- '- Status: %s\n' "${BOARD_RUN_STATUS:-not recorded}"
    printf -- '- Session: %s\n' "${BOARD_RUN_SESSION:-not recorded}"
    printf -- '- Board item: %s\n' "${page:-not resolved}"
    printf '\n'
    printf 'The comment on the card was cut to fit the board. This is the whole of it.\n\n'
    printf '## Full comment text\n\n'
    printf '%s\n' "$text"
  } > "$file" 2>/dev/null || {
    umask "$old_umask"
    board_log "$hook" "could not write the archive $file; the full text of this comment is saved nowhere"
    return 1
  }
  umask "$old_umask"
  printf '%s\n' "$file"
  return 0
}

# ------------------------------------------------------------- item ref parsing

# A ref is a task id (BD-12, bd-12.3, any case), or a task file path under
# board/tasks/ as the CLI and the web UI hand it back. Nothing else is a ref.
normalise_page_id() {
  local raw ident
  raw="$(printf '%s' "$1" | tr -d '\r' | sed -e 's/[?#].*$//' -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//')"
  [ -n "$raw" ] || return 1
  case "$raw" in
    */tasks/*)
      ident="$(basename "$raw" | grep -Eio '^[A-Za-z]+-[0-9]+(\.[0-9]+)*' | head -1 || true)"
      ;;
    *)
      ident="$(printf '%s' "$raw" | grep -Eio '^[A-Za-z]+-[0-9]+(\.[0-9]+)*$' || true)"
      ;;
  esac
  [ -n "$ident" ] || return 1
  printf '%s\n' "$ident" | tr 'a-z' 'A-Z'
}

# The spawn-prompt convention. One line anywhere in the instructions:
#   Board-Item: BD-12
# or a sub-task id, or the task file's path. Leading "- " and any case are
# tolerated; nothing else is.
page_id_from_instructions() {
  local text="$1" line
  line="$(printf '%s' "$text" | tr -d '\r' \
    | grep -Ei -m1 '^[[:space:]]*(-[[:space:]]+)?board-item:[[:space:]]*[^[:space:]]+' || true)"
  [ -n "$line" ] || return 1
  line="$(printf '%s' "$line" | sed -E 's/^[[:space:]]*(-[[:space:]]+)?[Bb][Oo][Aa][Rr][Dd]-[Ii][Tt][Ee][Mm]:[[:space:]]*//' \
    | awk '{print $1}')"
  normalise_page_id "$line"
}

# The task-title convention, for TaskCompleted: a marker anywhere in the title.
#   Wire up refresh rotation [board:BD-12]
page_id_from_task_title() {
  local text="$1" id
  id="$(printf '%s' "$text" | grep -Eio '\[board:[^]]+\]' | head -1 || true)"
  [ -n "$id" ] || return 1
  id="$(printf '%s' "$id" | sed -E 's/^\[[Bb][Oo][Aa][Rr][Dd]:[[:space:]]*//; s/[[:space:]]*\]$//')"
  normalise_page_id "$id"
}

# ------------------------------------------------------------------ the binary
#
# The board is the plugin's own binary, reached through one shim, and the
# binary finds the board itself: the main checkout's .boards/ of the repository
# containing its working directory, never a linked worktree's copy (see
# docs/2026-09-18-project-boards.md section 3). So the one thing this library
# owes it is the right working directory - BOARD_CWD, the cwd each hook reads
# from its input - and an inherited CLAUDECODE_AGENTS_BOARD_ROOT is left alone
# for the contract suite and the rare deliberate override. There is no default
# root and no fallback board: outside a repository the binary says "no board
# here", the hook logs it, and nothing moves.

# The shim sits beside this library, two directories up. BASH_SOURCE is how a
# sourced file finds itself and the hooks are run by bash, so it is there; a
# shell without it falls back to the plugin root the runtime exports.
board_locate_shim() {
  local dir=""
  if [ -n "${BASH_SOURCE[0]:-}" ]; then
    dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../board" 2>/dev/null && pwd)" || dir=""
  fi
  if [ -z "$dir" ] && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    dir="$CLAUDE_PLUGIN_ROOT/board"
  fi
  printf '%s/board.sh\n' "$dir"
}

BOARD_SHIM="${BOARD_SHIM:-$(board_locate_shim)}"
BOARD_CLI_TIMEOUT="${BOARD_CLI_TIMEOUT:-10}"
BOARD_CWD="${BOARD_CWD:-}"

board_cli() {
  # $1 hook name, rest arguments. stdout is the command's; failures are logged.
  local hook="$1"; shift
  local err rc
  # What to call this call in the log. After the shift $1 is always "task", so
  # a failure line built from it said "board task failed" for every subcommand
  # alike; the first two words are what tells an edit from a view.
  local what="$1 ${2:-}"
  [ -x "$BOARD_SHIM" ] || { board_log "$hook" "board shim missing at $BOARD_SHIM"; return 1; }
  err="$(mktemp "${TMPDIR:-/tmp}/board-err.XXXXXX")" || return 1
  # timeout(1) is GNU. Homebrew's coreutils installs it as gtimeout, and a
  # machine with neither still runs the command - unbounded, but running.
  # `cmd; rc=$?` is not errexit-safe: the hooks run under `set -e`, so a
  # non-zero exit kills the shell before the assignment ever happens and the
  # logging below is never reached. `|| rc=$?` puts the call in a condition
  # context, which is the one place errexit stands down.
  rc=0
  (
    if [ -n "$BOARD_CWD" ]; then cd "$BOARD_CWD" 2>/dev/null || exit 96; fi
    if command -v timeout >/dev/null 2>&1; then
      exec timeout "$BOARD_CLI_TIMEOUT" "$BOARD_SHIM" "$@"
    elif command -v gtimeout >/dev/null 2>&1; then
      exec gtimeout "$BOARD_CLI_TIMEOUT" "$BOARD_SHIM" "$@"
    else
      exec "$BOARD_SHIM" "$@"
    fi
  ) 2>"$err" || rc=$?
  if [ "$rc" -eq 96 ]; then
    board_log "$hook" "board $what: cwd $BOARD_CWD does not exist"
  elif [ "$rc" -ne 0 ]; then
    if grep -q 'no board here' "$err"; then
      board_log "$hook" "no board here: $(head -c 200 "$err" | tr '\n' ' ')"
    else
      board_log "$hook" "board $what failed (exit $rc): $(head -c 300 "$err" | tr '\n' ' ')"
    fi
  fi
  rm -f "$err"
  return "$rc"
}

# board_resolve HOOK ID -> prints the canonical id, or nothing
#
# Three outcomes, not two. The call failing is board_cli's to log; a call that
# succeeded and still yielded no id is a response this library could not read,
# and saying so is the difference between "that item does not exist" and "the
# CLI answered in a shape we do not understand". The caller turns an empty
# return into "not found", so without this line a renamed JSON field would be
# reported forever as a missing card.
board_resolve() {
  local hook="$1" id="$2" out ident rc=0
  out="$(board_cli "$hook" task view "$id" --json)" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  ident="$(printf '%s' "$out" | jq -r '.task.id // empty' 2>/dev/null)"
  if [ -z "$ident" ]; then
    board_log "$hook" "board item $id: unparseable response"
    return 1
  fi
  printf '%s\n' "$ident"
}

# board_focus_id HOOK -> prints the focused item id, or nothing
# The focus file is the binding now: written by task_focus or `board focus`,
# per checkout, read here ahead of the session state and the environment.
# Gated on board_disabled, not board_would_send: `focus --show` is a read, not
# a write, so a dry run still needs it to report what it would have moved
# rather than falling through and logging "nothing is focused".
board_focus_id() {
  local hook="$1" out
  board_disabled && return 1
  out="$(board_cli "$hook" focus --show)" || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

# board_set_status HOOK ID COLUMN
board_set_status() {
  local hook="$1" id="$2" col="$3"
  board_cli "$hook" task edit "$id" -s "$col" --by "$hook" >/dev/null || return 1
  board_log "$hook" "$id -> $col"
}

# board_comment_raw HOOK ID TEXT
# board_comment guards this already, but this is the other public entry point
# and a caller reaching it directly must not be able to post a card comment
# that says nothing. Both doors, one rule.
board_comment_raw() {
  local hook="$1" id="$2" text="$3"
  if [ -z "$(printf '%s' "$text" | tr -d '[:space:]')" ]; then
    board_log "$hook" "no comment text; nothing posted on $id"
    return 1
  fi
  board_cli "$hook" task edit "$id" --comment "$text" --comment-author "@$hook" --by "$hook" >/dev/null || return 1
  board_log "$hook" "commented on $id"
}

# ------------------------------------------------------------- the comment cap
#
# The cap is for the reader, not the backend: a card comment is a summary, and
# a comment that has to be cut is archived whole first, by board_archive_comment
# above, so the trailer on the cut text names the file with the rest. Cutting
# happens inside jq, which counts Unicode codepoints, so a multi-byte character
# is never split.
BOARD_COMMENT_HARD_MAX=180000

# board_cap_comment HOOK ITEM_REF TEXT
# Prints the text that should actually go on the card: the text itself when it
# is under the cap, and the cut text plus its trailer when it is not.
board_cap_comment() {
  local hook="$1" page="$2" text="$3"
  local len max out over note archive

  max="${BOARD_COMMENT_MAX_CHARS:-8000}"
  case "$max" in
    ''|*[!0-9]*|0) board_log "$hook" "BOARD_COMMENT_MAX_CHARS is not a positive integer; using 8000"; max=8000 ;;
  esac
  if [ "$max" -gt "$BOARD_COMMENT_HARD_MAX" ]; then
    board_log "$hook" "BOARD_COMMENT_MAX_CHARS is $max, above the hard ceiling; using $BOARD_COMMENT_HARD_MAX"
    max="$BOARD_COMMENT_HARD_MAX"
  fi

  len="$(printf '%s' "$text" | jq -Rs 'length' 2>/dev/null || printf '')"
  case "$len" in ''|*[!0-9]*) len=0 ;; esac

  out="$text"
  if [ "$len" -gt "$max" ]; then
    over=$((len - max))
    if archive="$(board_archive_comment "$hook" "$page" "$text")"; then
      note="[Cut to fit a board comment. The other $over characters, and this text in full, are in $archive]"
      board_log "$hook" "comment for $page is $len characters; cutting to $max and archiving the full text at $archive"
    else
      note="[Cut to fit a board comment. $over more characters were dropped and could not be archived; see the hook log.]"
      board_log "$hook" "comment for $page is $len characters; cutting to $max with no archive, so $over characters are lost"
    fi
    out="$(printf '%s' "$text" | jq -Rs --argjson max "$max" --arg note "$note" -r \
      '.[0:$max] + "\n\n" + $note' 2>/dev/null)"
    # A cut that failed is not a reason to post nothing: the caller has no way
    # to tell an empty return from a comment that was meant to be empty.
    if [ -z "$out" ]; then
      board_log "$hook" "could not cut the comment for $page; posting it uncut"
      out="$text"
    fi
  fi

  printf '%s\n' "$out"
}

# Whether the binary is about to be called at all. Disabled and dry runs never
# resolve, so they never spawn the CLI and never touch the memory tree - which
# is also what keeps the eval suites offline.
board_would_send() {
  board_disabled && return 1
  [ -n "${BOARD_DRY_RUN:-}" ] && return 1
  return 0
}

# board_write HOOK ITEM_REF COLUMN [COMMENT]
# The one entry point the hooks use. Always returns 0: a board write must not
# decide whether a session continues.
board_write() {
  local hook="$1" page="$2" col="$3" comment="${4:-}"
  if [ -z "$page" ]; then
    board_log "$hook" "no board item resolved, nothing to move to \"$col\" (see README, Which board item)"
    return 0
  fi
  require_tools "$hook" || return 0
  if board_would_send; then
    local resolved
    resolved="$(board_resolve "$hook" "$page")" || resolved=""
    if [ -z "$resolved" ]; then board_log "$hook" "board item $page not found; nothing moved"; return 0; fi
    board_set_status "$hook" "$resolved" "$col" || true
    if [ -n "$comment" ]; then board_comment_raw "$hook" "$resolved" "$(board_cap_comment "$hook" "$page" "$comment")" || true; fi
  else
    board_log "$hook" "dry run: would move $page to $col${comment:+ with a comment}"
  fi
  return 0
}

# board_comment HOOK ITEM_REF TEXT
# Say something on a row without moving it. Same envelope and same promise as
# board_write: every failure is logged and swallowed, and it always returns 0,
# because nothing about the board decides whether a session continues. Used
# where a transition has something worth reading but no column of its own - a
# clean subagent finish, where TaskCompleted still owns the move to Done.
board_comment() {
  local hook="$1" page="$2" text="$3"
  if [ -z "$page" ]; then
    board_log "$hook" "no board item resolved, nothing to comment on (see README, Which board item)"
    return 0
  fi
  if [ -z "$(printf '%s' "$text" | tr -d '[:space:]')" ]; then
    board_log "$hook" "no comment text; nothing posted on $page"
    return 0
  fi
  require_tools "$hook" || return 0
  if board_would_send; then
    local resolved
    resolved="$(board_resolve "$hook" "$page")" || resolved=""
    if [ -z "$resolved" ]; then board_log "$hook" "board item $page not found; nothing posted"; return 0; fi
    board_comment_raw "$hook" "$resolved" "$(board_cap_comment "$hook" "$page" "$text")" || true
  else
    board_log "$hook" "dry run: would comment on $page"
  fi
  return 0
}
