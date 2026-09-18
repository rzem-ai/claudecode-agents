#!/usr/bin/env bash
# SubagentStop: two jobs.
#
#   1. The board write. status failure or cancelled moves the item to Blocked.
#      status success with one or more "Blocker:" lines under Decisions needed
#      moves it to Blocked by human. A clean success changes no column -
#      TaskCompleted owns Done.
#
#      Every one of those three outcomes also puts a comment on the card, so a
#      row says what happened instead of only which column it is in. The text is
#      lifted from the handoff the agent already emits and from the status the
#      harness already sends: "## Done" on a clean finish, "## Not done" plus the
#      status on a failure or cancellation, the Blocker lines on the human queue.
#      Nothing new is asked of the handoff format - no fifth heading, no fourth
#      prefix - because a field agents have to remember is a field that decays,
#      and only the mandatory sections are worth building on.
#
#      The "## Done" comment is posted here rather than from TaskCompleted for
#      the plain reason that TaskCompleted never sees a handoff. It owns the move
#      to Done; this hook owns the only moment the text exists.
#
#      A handoff long enough that its comment will not fit on a card is archived
#      whole under the state directory before the cut text is posted, and the cut
#      note names the file. This hook holds the whole handoff in $message and is
#      the last thing that ever will, so anything it drops is gone. See
#      hooks/README.md, "Comment length".
#   2. The handoff-format check. On a successful run the final message must be
#      a valid handoff per skills/handoff/SKILL.md. If it is not, exit 2, which
#      stops the subagent stopping and hands the reason back to it. The rules
#      are strict on purpose and are the same rules evals/lib/handoff-check.sh
#      applies in CI: see hooks/README.md, "The handoff-format check".
#
# Every board failure is soft. The only thing that exits 2 here is a malformed
# handoff, and it exits 2 for that reason alone - never because the board could
# not be written.
set -euo pipefail

HOOK=SubagentStop
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/board.sh
. "$HOOK_DIR/lib/board.sh"

trap 'board_log "$HOOK" "unexpected error on line $LINENO; session continues"; exit 0' ERR

# --------------------------------------------------------------- the validator
#
# Anchors quoted from skills/handoff/SKILL.md:
#   headings   ^## (Done|Not done|Unverified|Decisions needed)$
#   typed line ^- (Blocker|Propose item|Propose memory):
# Items are "one markdown list item starting `- ` at column 0", an empty
# section is "exactly one line: `- None`", and the handoff is the last thing in
# the message.
#
# Every line is right-trimmed before any anchor sees it. Trailing whitespace
# is invisible in rendered markdown and models emit it habitually - two
# spaces after a heading is the markdown hard-line-break idiom - so it can
# never change what a line means. The \r of a CRLF is the same normalisation,
# and the None filter already tolerated a trailing tab; this makes the rule
# uniform. Leading whitespace still matters everywhere ("-  None", two spaces
# after the dash, is a real item, and an indented dash is not an item).
RE_HANDOFF_HEADING='^## (Done|Not done|Unverified|Decisions needed)$'
RE_ANY_H2='^## '
RE_ITEM='^- '
RE_TYPED='^- (Blocker|Propose item|Propose memory): '
RE_NONE='^- None$'

HANDOFF_ERRORS=""

handoff_error() {
  HANDOFF_ERRORS="$HANDOFF_ERRORS
  - $1"
}

# validate_handoff MESSAGE -> 0 valid, 1 malformed (reasons in HANDOFF_ERRORS)
validate_handoff() {
  local msg="$1"
  local line sec="" order="" trunc blank=0
  local n_done=0 n_notdone=0 n_unver=0 n_dec=0
  local none_done=0 none_notdone=0 none_unver=0 none_dec=0
  HANDOFF_ERRORS=""

  if [ -z "$(printf '%s' "$msg" | tr -d '[:space:]')" ]; then
    handoff_error "the final message is empty, so it carries no handoff"
    return 1
  fi

  while IFS= read -r line; do
    line="${line%"${line##*[![:space:]]}"}"
    if [[ $line =~ $RE_ANY_H2 ]]; then
      blank=0
      if [[ $line =~ $RE_HANDOFF_HEADING ]]; then
        sec="${line#\#\# }"
        order="$order|$sec"
      else
        trunc="$(printf '%s' "$line" | cut -c1-60)"
        handoff_error "unexpected level-2 heading \"$trunc\". The handoff allows no other H2."
        sec=""
      fi
      continue
    fi
    [ -n "$sec" ] || continue
    if [ -z "$(printf '%s' "$line" | tr -d '[:space:]')" ]; then blank=1; continue; fi

    # A blank line with another item after it is a blank line between items,
    # which the skill forbids. A blank line before the next heading never gets
    # here, because the heading clears the flag first.
    if [ "$blank" -eq 1 ]; then
      handoff_error "blank line inside \"## $sec\". A section is a solid block of \"- \" lines; the only blank line allowed is the one before the next heading."
      blank=0
    fi

    if ! [[ $line =~ $RE_ITEM ]]; then
      trunc="$(printf '%s' "$line" | cut -c1-60)"
      handoff_error "line under \"## $sec\" does not start with \"- \" at column 0: \"$trunc\""
      continue
    fi

    # A typed line is legal under Decisions needed and nowhere else. Rejecting
    # it is what lets the extractor stay scoped to that one section: a Blocker
    # that drifted into Done is an agent getting the format wrong, and rescuing
    # it silently would hide the bug and file a false alarm in the human queue.
    if [ "$sec" != "Decisions needed" ] && [[ $line =~ $RE_TYPED ]]; then
      trunc="$(printf '%s' "$line" | cut -c1-60)"
      handoff_error "typed line under \"## $sec\": \"$trunc\". \"- Blocker: \", \"- Propose item: \" and \"- Propose memory: \" lines belong under \"## Decisions needed\" and nowhere else."
    fi

    case "$sec" in
      "Done")
        n_done=$((n_done + 1))
        if [[ $line =~ $RE_NONE ]]; then none_done=1; fi ;;
      "Not done")
        n_notdone=$((n_notdone + 1))
        if [[ $line =~ $RE_NONE ]]; then none_notdone=1; fi ;;
      "Unverified")
        n_unver=$((n_unver + 1))
        if [[ $line =~ $RE_NONE ]]; then none_unver=1; fi ;;
      "Decisions needed")
        n_dec=$((n_dec + 1))
        if [[ $line =~ $RE_NONE ]]; then
          none_dec=1
        elif ! [[ $line =~ $RE_TYPED ]]; then
          trunc="$(printf '%s' "$line" | cut -c1-60)"
          handoff_error "untyped line under \"## Decisions needed\": \"$trunc\". Every line there is \"- Blocker: \", \"- Propose item: \", \"- Propose memory: \" or the single line \"- None\"."
        fi
        ;;
    esac
  done <<< "$msg"

  if [ "$order" != "|Done|Not done|Unverified|Decisions needed" ]; then
    if [ -z "$order" ]; then
      handoff_error "no handoff headings found. The message must end with \"## Done\", \"## Not done\", \"## Unverified\" and \"## Decisions needed\", in that order."
    else
      handoff_error "headings are wrong. Found \"${order#|}\" (pipe separated); expected exactly \"Done|Not done|Unverified|Decisions needed\", each once, in that order."
    fi
  fi

  if [ "$n_done" -eq 0 ];    then handoff_error "\"## Done\" is empty. An empty section is exactly one line: \"- None\"."; fi
  if [ "$n_notdone" -eq 0 ]; then handoff_error "\"## Not done\" is empty. An empty section is exactly one line: \"- None\"."; fi
  if [ "$n_unver" -eq 0 ];   then handoff_error "\"## Unverified\" is empty. An empty section is exactly one line: \"- None\"."; fi
  if [ "$n_dec" -eq 0 ];     then handoff_error "\"## Decisions needed\" is empty. An empty section is exactly one line: \"- None\"."; fi

  if [ "$none_done" -eq 1 ]    && [ "$n_done" -gt 1 ];    then handoff_error "\"## Done\" mixes \"- None\" with real items. \"- None\" is only ever the whole section."; fi
  if [ "$none_notdone" -eq 1 ] && [ "$n_notdone" -gt 1 ]; then handoff_error "\"## Not done\" mixes \"- None\" with real items. \"- None\" is only ever the whole section."; fi
  if [ "$none_unver" -eq 1 ]   && [ "$n_unver" -gt 1 ];   then handoff_error "\"## Unverified\" mixes \"- None\" with real items. \"- None\" is only ever the whole section."; fi
  if [ "$none_dec" -eq 1 ]     && [ "$n_dec" -gt 1 ];     then handoff_error "\"## Decisions needed\" mixes \"- None\" with real items. \"- None\" is only ever the whole section."; fi

  [ -z "$HANDOFF_ERRORS" ]
}

# extract_blockers MESSAGE -> the text of each "- Blocker: " line, one per line.
# Scoped to the Decisions needed section rather than the whole message. It can
# be, because validate_handoff rejects a typed line under any other heading:
# a Blocker that drifted into Done is caught and sent back to be re-emitted,
# instead of quietly parking a false alarm in the human queue.
extract_blockers() {
  printf '%s\n' "$1" \
    | tr -d '\r' \
    | awk '/^## Decisions needed$/ {inside=1; next} /^## / {inside=0} inside' \
    | grep -E '^- Blocker: ' \
    | sed -E 's/^- Blocker:[[:space:]]*//' \
    || true
}

# extract_section SECTION MESSAGE -> the "- " lines under "## <SECTION>", verbatim.
# Deliberately tolerant, because it also runs on the failure and cancellation
# path where the handoff was never validated and is allowed to be malformed: it
# reads what is there and returns nothing if there is nothing to read. A section
# whose whole content is "- None" comes back empty, so a caller never posts a
# comment that says nothing.
extract_section() {
  printf '%s\n' "$2" \
    | tr -d '\r' \
    | awk -v want="## $1" '{ sub(/[[:space:]]+$/, "") } $0 == want {inside=1; next} /^## / {inside=0} inside' \
    | grep -E '^- ' \
    | grep -vE '^- None$' \
    || true
}

# The last assistant content block in a subagent's transcript, as one compact
# JSON object: {"t":"structured"} for a StructuredOutput tool call, or
# {"t":"text","v":...} for prose. Returns 1 and prints nothing when the file is
# missing, unreadable, oversized, unparseable, or holds no assistant content -
# "cannot tell" is a third answer and never a guess at either of the other two.
#
# Both shapes were read off real transcripts rather than assumed; see
# hooks/README.md item 16. Read agent_transcript_path and never transcript_path:
# the event sends both, and only the first is scoped to this subagent.
TRANSCRIPT_MAX_BYTES="${CLAUDECODE_AGENTS_TRANSCRIPT_MAX_BYTES:-20000000}"

transcript_final_block() {
  local path="$1" size out
  # The readability test is belt and braces: an unreadable file makes jq fail
  # into the same `return 1` below, so nothing behaves differently without it.
  [ -n "$path" ] && [ -f "$path" ] && [ -r "$path" ] || return 1
  size="$(wc -c < "$path" 2>/dev/null | tr -d ' ')" || return 1
  case "$size" in ''|*[!0-9]*) return 1 ;; esac
  [ "$size" -le "$TRANSCRIPT_MAX_BYTES" ] || return 1
  # Take the LAST assistant content block and THEN classify it. Filtering first
  # and taking `last` of what survived meant a final block that was neither -
  # an ordinary tool call with no closing prose - was invisible, and the reader
  # reached back to an earlier text block and reported it as the final message.
  # That produced exit 2 quoting text that was never a handoff, which is the
  # failure this whole branch exists to stop.
  out="$(jq -s -c '
    [ .[] | select(.type == "assistant") | .message.content[]? ]
    | last
    | if . == null then empty
      elif (.type == "tool_use" and .name == "StructuredOutput") then {t: "structured"}
      elif .type == "text" then {t: "text", v: .text}
      else empty end' "$path" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}

# board_comment_text HEADLINE BODY -> the one shape every card comment takes:
# a headline naming the transition and where the detail came from, a blank line,
# then the handoff lines themselves. An empty body leaves the headline alone,
# which is what a failed run with no usable handoff gets.
board_comment_text() {
  if [ -z "$2" ]; then printf '%s\n' "$1"; return 0; fi
  printf '%s\n\n%s\n' "$1" "$2"
}

# ------------------------------------------------------------------- the hook

input="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  board_log "$HOOK" "jq is not installed, so neither the board write nor the handoff check can run. Install jq (macOS: brew install jq)."
  exit 0
fi

session_id="$(printf '%s' "$input" | jq -r '.session_id // ""')"
agent_id="$(printf '%s' "$input" | jq -r '.agent_id // ""')"
agent_type="$(printf '%s' "$input" | jq -r '.agent_type // ""')"
cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
export BOARD_CWD="$cwd"
message="$(printf '%s' "$input" | jq -r '.last_assistant_message // ""')"
# Absent is not empty. A subagent spawned with a schema is forced through
# StructuredOutput and the runtime omits last_assistant_message entirely - the
# key is not there, rather than holding "" or the JSON. Measured against Claude
# Code 2.1.236 with a live probe; see hooks/README.md item 16. `// ""` erases
# that distinction, so the two cases are separated here and nowhere else.
# A JSON null counts as absent for the same reason: it is no message, not an
# empty one.
has_message="$(printf '%s' "$input" | jq -r 'if has("last_assistant_message") and .last_assistant_message != null then "yes" else "no" end')"
agent_transcript="$(printf '%s' "$input" | jq -r '.agent_transcript_path // ""')"
# Neither of these fields exists. The SubagentStop schema in the shipped CLI is
# stop_hook_active, agent_id, agent_transcript_path, agent_type,
# last_assistant_message and background_tasks; `status` is not in it and
# `completion_reason` appears nowhere in the binary at all. So the branch below
# has only ever taken its empty case, and no failed or cancelled subagent has
# ever moved an item to Blocked.
#
# They are still read, because the read is free and the day the runtime does
# emit a status this hook starts working. What has changed is the claim: the
# Blocked-on-failure path is aspirational, not live, and the working route to
# Blocked is a `Blocker:` line in the handoff, which is handled further down.
# Do not describe failure transitions as verified until a real event shows one.
status_raw="$(printf '%s' "$input" | jq -r '.status // .completion_reason // ""')"

case "$(printf '%s' "$status_raw" | tr 'A-Z' 'a-z')" in
  success|succeeded|ok|completed) status=success ;;
  failure|failed|error)            status=failure ;;
  cancelled|canceled|user_interrupt|interrupted) status=cancelled ;;
  "") status=success
      board_log "$HOOK" "the runtime sends no status field on SubagentStop, so failure and cancellation cannot be detected here; treating the run as a success and relying on the handoff's Blocker: lines" ;;
  *)  status=success
      board_log "$HOOK" "unrecognised status \"$status_raw\"; treating the run as a success" ;;
esac

# Who this run was, for the archive a cut comment points at. Set before any
# board call, because board_write and board_comment are the things that read it.
BOARD_RUN_SESSION="$session_id"
BOARD_RUN_AGENT="$agent_type"
BOARD_RUN_AGENT_ID="$agent_id"
BOARD_RUN_STATUS="$status"

page_id=""
if page_id="$(state_agent_page_id "$session_id" "$agent_id")"; then
  :
elif [ -n "${CLAUDECODE_AGENTS_BOARD_PAGE_ID:-}" ] && page_id="$(normalise_page_id "$CLAUDECODE_AGENTS_BOARD_PAGE_ID")"; then
  board_log "$HOOK" "no state file for ${agent_id:-no id}; falling back to CLAUDECODE_AGENTS_BOARD_PAGE_ID"
else
  page_id=""
  board_log "$HOOK" "no board item bound to ${agent_type:-agent} ${agent_id:-no id}; the column will not change"
fi

# 1. A failed or cancelled run goes to Blocked, and that is the end of it. The
#    handoff check deliberately does not run here: exit 2 would refuse to let a
#    cancelled subagent stop, which is the opposite of what a cancellation means.
if [ "$status" = "failure" ] || [ "$status" = "cancelled" ]; then
  board_log "$HOOK" "${agent_type:-agent} finished with status $status"
  # The handoff is not validated on this path and may be absent or malformed,
  # which is allowed. Take what parses; fall back to the two things always known.
  notdone="$(extract_section 'Not done' "$message")"
  if [ -n "$notdone" ]; then
    comment="$(board_comment_text \
      "Blocked. ${agent_type:-A subagent} finished with status $status. From \"## Not done\" in its handoff:" \
      "$notdone")"
  else
    comment="Blocked. ${agent_type:-A subagent} finished with status $status. Its handoff carried no readable \"## Not done\" detail, so the status is all this card can say."
    board_log "$HOOK" "no readable \"## Not done\" in the handoff; commenting the agent type and status only"
  fi
  board_write "$HOOK" "$page_id" "$BOARD_COL_BLOCKED" "$comment"
  exit 0
fi

# 2. Successful run: the handoff must parse before anything is trusted from it.
#
# Unless no handoff was ever asked for. Every workflow spawns fleet agents with
# schemas - scout and reviewer in review-round, researcher in deep-research,
# scout and spec-writer in spec-to-plan - and the matcher covers all ten fleet
# names, so this gate had been exiting 2 on those runs and telling them to
# re-emit a handoff they were never asked to write. Scoping the matcher (item
# 12) fixed the built-in Plan and general-purpose lanes; it cannot help when the
# schema-carrying agent is itself a fleet agent.
#
# A run with no message field is not a malformed handoff, so it passes. A
# message that is present and empty is an agent that was asked and said nothing,
# and that still fails - the distinction is the whole fix, and softening it any
# further would retire the gate.
#
# Note what is and is not known here. The probe proved that a schema-carrying
# spawn produces an absent field; it did not prove the converse. Any other cause
# of an absent final message lands in this branch too and exits 0 silently, and
# this hook cannot tell the cases apart from the event alone. That is an
# accepted gap, not a diagnosis - see hooks/README.md item 16 for the evidence
# that would close it.
#
# The column is left alone either way: TaskCompleted owns Done, there are no
# Blocker: lines to read, and a card that invents a comment out of structured
# output nobody parsed is worse than a card that says nothing.
# `!= yes` rather than `= no`, so a jq that printed nothing at all - empty
# stdin, a payload that is not an object - lands here rather than falling
# through to be validated as an empty handoff.
if [ "$has_message" != yes ]; then
  transcript_block="$(transcript_final_block "$agent_transcript")" || transcript_block=""
  case "$(printf '%s' "$transcript_block" | jq -r '.t // ""' 2>/dev/null)" in
    structured)
      board_log "$HOOK" "${agent_type:-agent} finished on a StructuredOutput call, so it was never asked for a handoff and there is nothing to validate; leaving the column alone"
      exit 0
      ;;
    text)
      # The runtime dropped a message the transcript still holds. Recover it and
      # hold it to the same rules as any other - this is the empty-handoff case,
      # and it is the one the gate exists for.
      message="$(printf '%s' "$transcript_block" | jq -r '.v // ""')"
      board_log "$HOOK" "${agent_type:-agent} sent no final message in the event, but its transcript ends in text; validating that as the handoff"
      ;;
    *)
      board_log "$HOOK" "${agent_type:-agent} sent no final message and its transcript could not be read, so why is unknown; letting the run stop rather than demanding a handoff that may never have been owed"
      exit 0
      ;;
  esac
fi

if ! validate_handoff "$message"; then
  trap - ERR
  {
    printf 'Your final message is not a valid handoff, so the board could not be updated from it.\n'
    printf 'The handoff is a machine contract - see the `handoff` skill. Problems found:\n'
    printf '%s\n\n' "$HANDOFF_ERRORS"
    printf 'Reply with the same content, ending in exactly these four headings in this order,\n'
    printf 'each with at least one "- " item at column 0, and "- None" alone where a section is empty:\n\n'
    printf '## Done\n## Not done\n## Unverified\n## Decisions needed\n'
  } >&2
  board_log "$HOOK" "handoff from ${agent_type:-agent} is malformed; exit 2 to make it re-emit"
  exit 2
fi

blockers="$(extract_blockers "$message")"

if [ -n "$blockers" ]; then
  count="$(printf '%s\n' "$blockers" | grep -c . || true)"
  comment="$(board_comment_text \
    "Blocked by human. ${agent_type:-A subagent} raised ${count} blocker(s). From \"## Decisions needed\" in its handoff:" \
    "$(printf '%s\n' "$blockers" | sed 's/^/- /')")"
  board_log "$HOOK" "${count} blocker(s) from ${agent_type:-agent}; moving to \"$BOARD_COL_BLOCKED_HUMAN\""
  board_write "$HOOK" "$page_id" "$BOARD_COL_BLOCKED_HUMAN" "$comment"
else
  # No column moves here; TaskCompleted owns Done. The comment still goes on,
  # because this is the only place the finished agent's own account of the work
  # exists. A "## Done" of nothing but "- None" earns no comment at all.
  done_items="$(extract_section 'Done' "$message")"
  if [ -n "$done_items" ]; then
    count="$(printf '%s\n' "$done_items" | grep -c . || true)"
    comment="$(board_comment_text \
      "Done. ${agent_type:-A subagent} finished with no blockers. From \"## Done\" in its handoff:" \
      "$done_items")"
    board_log "$HOOK" "${agent_type:-agent} succeeded with no blockers; commenting ${count} \"## Done\" item(s), leaving the column alone for TaskCompleted"
    board_comment "$HOOK" "$page_id" "$comment"
  else
    board_log "$HOOK" "${agent_type:-agent} succeeded with no blockers and an empty \"## Done\"; nothing worth commenting, leaving the column alone for TaskCompleted"
  fi
fi

exit 0
