# Evals

One smoke eval per agent, eleven in total. The glossary defines an eval as three to five prompts, a rubric and a baseline score, run in CI on every definition change. Every eval here has that shape, and `evals/lib/roster-contract.sh` checks the prompt count rather than leaving this sentence to assert it. The CI half is not wired up yet; **In CI** below says what to wire.

An eval is not a quality measure. It is a smoke test for the failures that actually matter for one agent - the reviewer editing instead of reporting, the scout returning opinions, the steward merging its own proposal - plus one check every agent shares, because three hooks parse the handoff format and a body that drifts off it breaks the board rather than just reading badly.

## Layout

```
evals/
  run.sh                    the runner
  README.md                 this file
  lib/handoff-check.sh      the four-heading check, shared by all eleven
  lib/final-message.sh      pulls the final assistant message out of a run
  lib/handoff-parity.sh     proves this gate and the hook are one rule set
  lib/judge-prompt.md       instructions given to the grader
  fixtures/
    sample-app/             the workspace each prompt runs in, copied fresh
    inputs/                 diffs, handoffs, notes and model lists a prompt points at
    handoff-cases/          handoffs, valid and malformed, for the parity check
  <agent>/
    prompts/01-*.md         three to five prompts, one per file
    rubric.md               why this eval exists, then the criteria
    checks.sh               mechanical gates, where the agent has any
    baseline.json           the recorded score, unset until the first run
  results/<timestamp>/      one directory per run, not committed
```

A directory per agent rather than a file per agent, for three reasons. A prompt goes to `claude -p` verbatim, so it lives in its own file with nothing to strip. The mechanical gates are a script, not prose. And the baseline is written by the runner, so it has to be machine-readable and separate from the rubric a human edits.

## Running

```
evals/run.sh --list                 what exists, and each agent's baseline
evals/run.sh                        all eleven
evals/run.sh reviewer               one agent
evals/run.sh reviewer scout         several
evals/run.sh reviewer --prompt 02   one prompt
evals/run.sh --no-judge             gates only, no grader call
evals/run.sh --dry-run              print the commands, run nothing
```

Each prompt runs in a fresh copy of `fixtures/sample-app` with `fixtures/inputs` mounted at `.eval-inputs/`, so an agent can write freely and whether it did is part of what is measured. The workspace is deleted after scoring unless you pass `--keep-workspace`.

Environment, for the things that differ per box or per CLI version:

| Variable | Default | What it is for |
|---|---|---|
| `EVAL_CLAUDE_BIN` | `claude` | The binary to run |
| `EVAL_AGENT_FLAG` | `--agent` | The flag that selects the agent. If your CLI spells it differently, set this rather than editing the runner |
| `EVAL_CLAUDE_ARGS` | `--permission-mode acceptEdits` | Extra arguments on every run. Add `--max-turns` here to cap the lead eval |
| `EVAL_JUDGE_MODEL` | `sonnet` | The model that grades against the rubric |
| `EVAL_TIMEOUT` | `900` | Per-prompt timeout in seconds, when `timeout(1)` exists |
| `EVAL_OUTPUT_FORMAT` | `auto` | `json`, `text` or `auto`. `auto` is `json` when `jq` is installed, because `json` names the final assistant message in a field of its own. Ignored if `EVAL_CLAUDE_ARGS` already sets `--output-format` |

## How a run is scored

Three layers, and only two of them can fail a run.

**The handoff gate.** `lib/handoff-check.sh` parses the final message the way the `SubagentStop` hook does: the four headings exactly, in order, once each; no other level-2 heading; one top-level list item per line; no blank line between two items in a section; an empty section as exactly `- None`; every Decisions needed line typed `Blocker:`, `Propose item:` or `Propose memory:`; no typed line under any other heading; and nothing after the last item. Every eval runs it. It is the one check all eleven share, and a failure here is a failure whatever else the agent did.

"the way the hook does" is a claim, so it is tested. `lib/handoff-parity.sh` runs this gate and `claudecode-agents/hooks/board-subagent-stop.sh` over every case in `fixtures/handoff-cases/` - valid handoffs, a typed line in each of the three wrong sections, blank lines, missing and out-of-order headings, a stray H2, untyped lines, trailing prose - and fails if the two ever disagree. Run it after touching either side. It needs `jq` and no network.

Note what the gate does not do: it says nothing about prose above `## Done`. Neither does the hook, which parses nothing before the first heading. So an agent explaining what it did with another agent's `Blocker:` line is writing ordinary prose, not a malformed handoff. Only a line that *starts* with a typed prefix, under a heading other than `## Decisions needed`, is a failure.

### What the gate reads

The hook is handed exactly one string, `last_assistant_message`. The gate has to read the same string or CI and production disagree about the same run, so the runner isolates it rather than checking everything `claude -p` printed:

1. The run is made with `--output-format json` when `jq` is available. That form carries the final assistant message in its own `result` field.
2. `lib/final-message.sh` pulls that field out and writes it to `transcript.txt`. Everything the CLI printed stays beside it in `raw-output.txt`, and `final-message.method` records which route was taken.
3. `handoff-check.sh` and the grader both read `transcript.txt`.

Two residual differences remain, and neither is fixable from here:

- **Without `jq`**, the runner falls back to the text output format and `final-message.sh` passes the whole capture through, recording `text-passthrough`. In text mode the CLI prints the final message and nothing else, so this is almost certainly the same string, but the runner cannot prove it. Install `jq` on any box that runs the suite in CI.
- **`result` is the CLI's report of the final message**, not the harness's `last_assistant_message` field itself. They are the same text in every case observed; if a CLI version ever truncates or reformats one and not the other, this is the place it would show up.

**The agent gate.** `<agent>/checks.sh`, where the agent has one. These are the facts a script can settle rather than a judge: the reviewer's workspace is byte-identical to the fixture, the spec-writer wrote nothing outside `docs/specs/`, no value from `.env` reached the coder's answer, the tech-writer used no em dash. A gate is pass or fail.

**The rubric.** `<agent>/rubric.md`, graded by a second `claude -p` call against the transcript and the list of files the agent changed. Criteria are identified in brackets and grouped by prompt, with an "All prompts" section that applies to every one. The grader emits `RESULT <id> PASS|FAIL - <evidence>` lines and nothing else, so the runner counts them with `grep` and needs no JSON parser. The rubric produces a percentage, not a verdict.

Reading the summary:

```
AGENT            GATES    RUBRIC   BASELINE   DELTA      VERDICT
reviewer         ok       92%      88         +4         ok
scout            1 FAIL   75%      90         -15        FAIL (1 gate)
```

`GATES` is how many prompts failed a gate. `RUBRIC` is criteria passed over criteria graded, across every prompt in that eval. `VERDICT` is `FAIL` if any gate failed, `REGRESSED` if the rubric dropped more than five points below the baseline, and `ok` otherwise. The runner exits non-zero if any gate failed.

Per-prompt detail is under `results/<timestamp>/<agent>/<prompt>/`: `transcript.txt` is the agent's final message, which is all the board ever sees; `raw-output.txt` is everything the CLI printed and `final-message.method` says how one was got from the other; `handoff.txt` and `checks.txt` are the gates line by line; `judge.txt` is the grader's `RESULT` lines; and `changed-files.txt` is every file the agent added, modified or deleted.

## Baselines

Every `baseline.json` ships with `"score": null`, which the runner and `--list` both report as `unset`. That is deliberate: a baseline is the number a representative run produced, and inventing one would mean CI comparing against a figure nobody measured. A delta of `n/a` means no baseline yet, not a pass.

Set one after a run you have read and believe:

```
evals/run.sh reviewer --update-baseline
```

That writes the score, the date and the commit into `evals/reviewer/baseline.json`. Re-record it when an agent body changes on purpose, and never edit it by hand to make a run look green - which is the specific thing the `fleet-steward` eval tests the steward for.

## In CI

Section 11: the steward opens a pull request, the evals run on it, and the scores go on the request as a comment. The steward never merges, so the eval run is evidence for the human's decision rather than a gate that lets a change through by itself.

```
scripts/gen-glossary-rule.sh --check
evals/lib/handoff-parity.sh
evals/run.sh
```

The first two come first because they are free. The generator check catches a stale `claudecode-agents/templates/rules/glossary.md` before eleven agent runs pay for it, and the parity check catches the handoff gate and the production hook drifting apart, which is worse than either being wrong: it means CI fails handoffs the fleet accepts, or passes ones it does not. All three exit non-zero on failure.

Two things to know before wiring it up. The suite makes roughly forty agent calls plus a grader call each, so it is not a per-commit job - run it on changes under `claudecode-agents/agents/`, `claudecode-agents/skills/` and `evals/`. And the `lead` eval is the expensive one because the lead can spawn subagents; cap it with `EVAL_CLAUDE_ARGS="--max-turns 30"` or run the other nine on pull requests and the lead nightly.

## Adding or changing an eval

Keep it to three to five prompts. A prompt should provoke one specific failure and be answerable in one turn. Write the rubric criteria as things a grader can see in a transcript - "names the file and the line" rather than "understands the bug" - and put anything a script can settle into `checks.sh` instead, where it is a gate and not a judgement.

Prompts may carry directives on their first lines, stripped before the text reaches the model:

```
#!fixture: sample-app     the workspace to copy in. `none` for an empty one.
```

Rubric headings must match the prompt filename exactly - a prompt at `prompts/02-just-fix-it.md` is graded by the criteria under `## Prompt 02-just-fix-it` - because that is how the runner tells the grader which criteria apply.
