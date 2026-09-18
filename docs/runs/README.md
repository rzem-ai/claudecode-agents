# Run articles

A run article is the readable account of one piece of work: what was tried and abandoned, what the constraint turned out to be, what surprised whoever did it, and what to do differently. It is written by the agent that did the work, when the lead asked for one in the spawn prompt, and it exists because the handoff cannot carry any of that. The format, the length and the writing rules are in `claudecode-agents/skills/run-article/SKILL.md`; this file is the convention for the directory.

## The filename

```
docs/runs/YYYY-MM-DD-<agent>-<issue-or-slug>.md
```

Date first, ISO, so `ls` is chronological and a run is findable by roughly when it happened. Agent second, so a reader knows what kind of account it is before opening it. Issue third, using the same identifier as `docs/specs/<issue>.md` and `docs/plans/<issue>.md` so one grep finds the spec, the plan and the article for a piece of work. Where there is no issue, a two to four word kebab slug that names the problem rather than the fix, because the next person searches for the problem they have. A second article on the same date, from the same agent, on the same issue appends `-2`.

## What belongs here

One article per run, written because the run was substantial or hard, because someone will have to understand it later, or because a decision in it took real reasoning.

## Who writes them

`coder`, `reviewer`, `researcher` and `ui-designer`. Those four spend a run's effort on reasoning that leaves no trace: the approaches a coder abandoned, the defect a reviewer suspected and cleared, the sources a researcher rejected, the two directions a designer dropped. `coder` and `ui-designer` write the file themselves. `reviewer` and `researcher` never create a file - both by their own invariants and their frontmatter, and `reviewer` by hook enforcement as well - so they return the article above the handoff and the lead saves it here.

`scout` does not: it returns paths, lines and quotes, and an essay from it would be the opposite of its job. `spec-writer` does not: it is confined to `docs/specs/` by `hooks/enforce-agent-scope.sh`, and a spec's non-goals and open questions already hold the reasoning an article would repeat. `tech-writer` does not: its output is the writing, so a narrative account of a run is a commission for it rather than a by-product. `fleet-steward` does not: its sweep is scheduled and unattended, its findings already land on a pull request and on board items, and it holds no `Write` tool.

## What does not

- A pasted handoff. That is the receipt, and it is already on the card and in the transcript.
- A status report, a session diary or a list of completed steps.
- A state-directory archive, moved or copied in. Those are verbatim hook output under `~/.local/state/claudecode-agents/archives/`. Promote what one taught into a rule, a skill or a memory, per the `compound` skill; never file the file itself.
- A spec, a plan, an ADR, a README or a runbook. Those describe the system and belong where they already live. An article describes a run. If a reader needs it to use the thing, it is documentation, not an article.
- Anything written in the human's voice or published as them. These are internal technical records by agents.
- Anything about routine work. An article nobody needed is the main way this directory turns into a landfill.

## The index

There is no index file, because an index nobody updates is worse than none. Every article carries a title and a one-line summary under it, so the directory indexes itself:

```sh
head -n 5 docs/runs/*.md
```

## Pruning

Articles are read at the quarterly pass the lead runs over `.claude/rules/` when the human asks for it; the `compound` skill describes it. An article whose subject no longer exists in the code is deleted; anything in it worth keeping was promoted into a rule, a skill or a memory long before, and git holds the text either way.

If this directory ever passes about fifty files between passes, the problem is upstream: articles are being asked for on routine work, and the fix is in the lead's delegation policy rather than here.
