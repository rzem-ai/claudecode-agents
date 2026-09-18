---
id: BD-1
title: Qualify the agent type names in the review-round workflow script
references:
  - memory-tree BD-26
status: To Do
assignee: []
created_date: '2026-09-18 04:14'
updated_date: '2026-09-18 04:26'
labels: []
dependencies: []
priority: high
project: Claude Agents
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The review-round workflow fails on its first agent in any project where the fleet agents are namespaced, which is all of them.

skills/review-round ships a script whose agent type constants are bare names:

  const SCOUT = 'scout'
  const REVIEWER = 'reviewer'
  const CODER = 'coder'
  const REFUTER = 'refuter'

The runtime registers them as 'claudecode-agents:scout' and so on, so the first agent() call throws "agent type 'scout' not found" and the whole run dies about eighteen seconds in. Hit live on myassist-researcher RZE-289 phase 1, round 1. Patching the four constants in the generated script and resuming ran it fine, so the four constants are the whole defect.

The fix is not simply a find and replace, because the script's own header comment says the SubagentStop matcher lists the ten bare fleet names, and the bare names were presumably chosen for that. So whoever fixes this needs to establish which form the hook matcher actually receives and match on that, rather than swapping one broken assumption for another. If the hook wants the bare name and the runtime wants the qualified one, the script needs both and a comment saying why.

Worth checking every other shipped workflow script for the same constants before closing.
<!-- SECTION:DESCRIPTION:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @lead
created: 2026-09-18 04:26
---
A second defect in the same script, and the worse of the two: unknown arguments are silently ignored.

Invoked with { round, target, issue, phase }, the script reads only `range` (line 156: `input.range || (input.base && input.head ? ... : 'HEAD~1...HEAD')`). `target` is not a parameter, so it fell through to the HEAD~1...HEAD default and reviewed the previous commit on main - a docs commit - instead of the branch it was pointed at. The run completed, reported "request changes" with four blocking findings, and named a range in its result that nobody reads as carefully as they read the verdict.

Silently reviewing the wrong thing is worse than failing to start. The agent-name defect at least announced itself in eighteen seconds.

Two fixes worth considering together: reject unknown top-level keys in `input` rather than ignoring them, and accept a branch or worktree name as a target by resolving it to `<merge-base>...<branch>`, since pointing a review at a branch is the common case and `range` makes the caller construct it by hand.

Found the same way as the first defect, on myassist-researcher RZE-289 phase 1.
---
<!-- COMMENTS:END -->
