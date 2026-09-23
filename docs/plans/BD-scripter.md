# BD-scripter: wire the scripter agent alongside coder

Status: awaiting approval. Repo: claudecode-agents plugin source at /Users/alex/Dev/Work/extensions/claudecode-agents. Not tracked on MyAssist's board - this repo has its own board (prefix BD) but no plan directory convention existed before this file.

## Goal

`scripter` (sonnet, effort medium) exists today only as a byte-for-byte duplicate of `coder.md` with three frontmatter lines changed. Its prose body still calls itself "coder" throughout, and every place that recognises `coder` by literal string match - two hooks and one workflow constant - does not know `scripter` exists. Wire it in as a genuine sibling: same job, same discipline, cheaper by default, for small well-scoped scripting tasks. Reserve `coder` for production app code, auth or credential paths, and multi-phase plans.

## What scout established (2026-09-23)

- `scripter.md` today: `name: scripter`, `model: sonnet`, `effort: medium`, everything else identical to `coder.md` including prose that says "coder".
- Two functional (not cosmetic) match points recognise `coder` by literal string, not frontmatter:
  - `hooks/hooks.json:18` - the `SubagentStop` matcher regex, a hardcoded alternation of the ten agent names. A `scripter` stop event does not match it today, so the board hook and handoff gate silently do not fire for it.
  - `hooks/enforce-agent-scope.sh:1266-1274` - the final `case "$agent" in ... esac` dispatch. `coder) enforce_coder ;;` is the worktree-write guard. `scripter` falls through to the no-op `*)` branch, meaning it would write with no isolation enforcement even though its frontmatter sets `isolation: worktree`.
- A third literal match, in a workflow rather than a hook: `workflows/review-round.js:90`, `const CODER = 'coder'`, used across roughly twenty lines to spawn and identify the builder role for a review round.
- Everywhere else `coder` appears is prose: `agents/lead.md`'s routing line and invariants, `agents/reviewer.md`, `agents/scout.md`, `agents/refuter.md`, `agents/ui-designer.md`, several skills (`looping`, `run-article`, `board`, `migration-checklist`), three command docs (`prune-worktrees.md`, `kickoff.md`, `init.md`), `workflows/spec-to-plan.js`, and the plugin's own docs (`README.md`, `docs/agent-contract.md`, `docs/fleet-design.md`).
- No agent registry file exists beyond the two hook match points above; agents are auto-discovered from `agents/*.md`. `.claude-plugin/plugin.json` (version 0.21.0) has a `"ten agents"` line in its description and is the version clients cache against - the migration-checklist convention is to bump it in any PR that changes agent definitions.
- No per-agent eval directory is mandated by the migration checklist; it says "run the smoke evals," not "one must exist per agent." Building `evals/scripter/` is out of scope here, proposed as a follow-up instead - the lesson from MYA-1 was to keep scope tight rather than build everything adjacent that seems worthwhile.

## Phases

### Phase 1: make scripter actually work

The functional wiring. Nothing here is optional - without it `scripter` either does not report to the board or writes without isolation enforcement.

1. `agents/scripter.md`: reword the prose body for its own name (every "coder" in running text, e.g. "the one observed way to be a coder outside a worktree" and its invariants). Keep the frontmatter as already set (`sonnet`, `medium`, `isolation: worktree`, same tools, skills, disallowedTools). Do not touch `coder.md`.
2. `hooks/hooks.json:18`: add `scripter` to the `SubagentStop` matcher alternation.
3. `hooks/enforce-agent-scope.sh`: add `scripter) enforce_coder ;;` to the case dispatch (reuse the existing function - the guard's logic does not depend on the agent's name, only on the worktree). Read the whole file first for any other agent-name list or table beyond the two lines scout flagged (it noted several comment-only mentions at lines 88, 158, 308, 596-704, 924-1210 that may or may not need a matching entry) and fix any that are functional, not just cosmetic.
4. `agents/lead.md`: add `scripter` to the routing line in "How you work" step 2, with the distinction stated above (small well-scoped scripting tasks vs. coder for production app code, auth/credential paths, multi-phase plans). Add it wherever the text says "a `coder`" in a way that should now read "a `coder` or `scripter`" (the plan-approval gate and the worktree-adoption/cleanup steps apply to both).
5. `.claude-plugin/plugin.json`: bump `version` (0.21.0 to 0.22.0) and change `"ten agents"` to `"eleven agents"` in the description. Sync `.claude-plugin/marketplace.json`'s mirrored version field.

Gate: a scripted smoke check - spawn nothing live, but grep-verify the regex now matches `scripter` and the case statement now has the entry, and `bash -n` the hook script.

### Phase 2: review-round and the docs pass

Lower urgency than phase 1 - scripter is usable without this, just not yet reviewable by the existing review workflow or fully documented.

1. `workflows/review-round.js`: generalise the hardcoded `CODER` role. Read the whole file before changing anything - `git blame` or context should say whether it is safe to make the builder role a parameter (accept either `coder` or `scripter` as who produced the diff being reviewed) versus needing a second constant and parallel branches. Do not weaken any of its existing gates in the process.
2. `workflows/spec-to-plan.js`: the "no coder runs against this plan until approved" comments and gate text extend to `scripter` too, since both are plan-phase builders.
3. Skills prose (`looping`, `run-article`, `board`, `migration-checklist` SKILL.md files): update mentions where they describe which agents something is "preloaded into" or which agent does what, so the docs match what phase 1 actually wired.
4. Command docs: `commands/kickoff.md`'s agent-type list, `commands/prune-worktrees.md`, `commands/init.md`.
5. `README.md` fleet table (ten rows to eleven) and `docs/agent-contract.md` / `docs/fleet-design.md` (the "only coder sets isolation," "nine agents that are not coder" and fleet-table entries).

Gate: no code path changes agent behaviour here except review-round.js, so the meaningful gate is running review-round.js's own smoke path against a trivial diff from each of `coder` and `scripter` and confirming both are recognised.

## Out of scope (proposed as follow-ups, not built here)

- `evals/scripter/` - a parallel eval directory mirroring `evals/coder/`. Genuinely useful for fleet-steward's sweep, not required for scripter to function.
- Any change to `coder.md` itself.
- Deciding whether `scripter` should ever get its own isolation function distinct from `enforce_coder` if their behaviour needs to diverge later - today reusing the coder guard is correct because the isolation need (a git worktree, writing safely) is identical.

## Review

`reviewer` on both phases. Phase 1 touches two hooks with fleet-wide blast radius - a bug there affects every future coder or scripter spawn silently - so brief reviewer to read `enforce-agent-scope.sh` and `hooks.json` in full, not just the diff, and confirm the guard function is genuinely name-independent before approving. No refuter pass needed; this is configuration and prose, not logic with edge cases worth mutation-testing.
