---
name: migration-checklist
description: The twenty checks run over every agent body and every skill's frontmatter when a new model ships, when a frontmatter field changes upstream, or before any change to agent definitions merges. Each check says what to look for and what its failure looks like, and most failures here are silent - the agent loses a tool or a skill and never says so.
when_to_use: Run when a new model or alias target appears in the models list, when Anthropic adds or renames a frontmatter field, before opening a PR that touches anything under claudecode-agents/agents/ or a skill's frontmatter, and when an agent is behaving as though it is missing something it was configured with.
effort: high
---

# Migration checklist

Run this over every file in `claudecode-agents/agents/` and every `SKILL.md` in `claudecode-agents/skills/`. It is a superset of the pre-commit list in `docs/agent-contract.md`, which stays the authority on what a body must contain - check against that file, not against memory of it, because the steward updates it first when a field changes upstream.

The output is a pull request against `claudecode-agents` with the diffs and a table of findings. Never a merge, and never a silent fix - a check that fails is reported even when the fix is obvious. Run the smoke evals on the PR before asking for a review, and bump `plugin.json` in it, because clients keep the cached copy until that number changes.

Three commands do most of the mechanical work.

```bash
python3 - claudecode-agents/agents/*.md claudecode-agents/skills/*/SKILL.md <<'PY'
import sys, yaml
for p in sys.argv[1:]:
    fm = yaml.safe_load(open(p).read().split('---')[1])
    print(p, sorted(fm), sep='\n  keys: ')
    assert isinstance(fm.get('tools', ''), str), p + ': tools is not a string'
    assert isinstance(fm.get('skills', []), list), p + ': skills is not a list'
PY

python3 -c "import glob;[print(p,i+1,l.rstrip()) for p in glob.glob('claudecode-agents/**/*.md',recursive=True)+glob.glob('docs/**/*.md',recursive=True) for i,l in enumerate(open(p)) if '\u2013' in l or '\u2014' in l]"
```

```bash
python3 - <<'WRAP'
import glob, re, sys
skip = re.compile(r'\s*([#|>`~]|[-*+]\s|\d+[.)]\s|\[[^\]]+\]:\s)')
hits = 0
for p in sorted(glob.glob('claudecode-agents/**/*.md', recursive=True) + glob.glob('docs/**/*.md', recursive=True)):
    lines = open(p).read().split('\n')
    start, fenced = 0, False
    if lines and lines[0].strip() == '---':                       # frontmatter is not prose
        start = next((i for i, l in enumerate(lines[1:], 1) if l.strip() == '---'), 0) + 1
    for i in range(start, len(lines) - 1):
        l = lines[i]
        if l.lstrip().startswith(('```', '~~~')): fenced = not fenced; continue
        if fenced or len(l) < 60 or skip.match(l): continue
        if l.rstrip()[-1] in '.!?:;': continue                    # one sentence per line, not a filled paragraph
        if lines[i + 1].strip() and not skip.match(lines[i + 1]):
            print(f'{p}:{i+1}: prose is hard-wrapped'); hits += 1; break
sys.exit(1 if hits else 0)
WRAP
```

## Frontmatter that parses

1. **The block parses as YAML at all.** Run the parser above. A file that raises is obvious; the dangerous case is one that parses into the wrong shape, so read the printed key list for every file and confirm it contains only fields the contract names.

2. **No bare colon-space inside an unquoted string.** Grep every value for `: ` and quote the whole string or reword it. This is the check that nearly shipped a broken agent: YAML reads `description: Reviews a diff: correctness and design` as a nested mapping, the frontmatter still parses, the agent silently loses its description or fails to load, and nothing anywhere says why. The printed key list is how you catch it - an unexpected key means a value split.

3. **`tools` is a comma-separated string on one line and `skills` is a YAML list.** The `tools` shape is fleet convention - the sub-agents reference accepts a YAML list too, so a list there is a style finding, not a lost allowlist. The `skills` shape is the one that bites: a `skills` written as a comma-separated string preloads nothing and the agent works on without `glossary`, `handoff` or `board` and never mentions it.

4. **Every `mcp__<server>__<tool>` entry names a server that is actually registered.** Diff the server segment of every MCP entry against the servers in `~/.claude/settings.json`, the project `.mcp.json` and the enabled connectors; `claude mcp list` shows all three at once. A claude.ai connector registers as `claude_ai_<Name>` and a plugin-shipped server as `plugin_<plugin>_<server>`, so a bare display name such as `Memory` is never the identifier. `claude mcp list` does not show a plugin's own server at all, so the plugin-shipped ones are confirmed against a live tool listing instead, as `docs/agent-contract.md` records. A wrong or renamed server name is a silent no-op - the agent simply has no such tool, does not error, and works around the absence without telling anyone. This is the single most expensive silent failure in the fleet.

5. **`memory` and `isolation` carry only real values.** `memory` accepts `user`, `project` or `local`; `isolation` accepts only `worktree`. "None" for either means omit the field, never write the word none. Only `coder` sets `isolation`, and no fleet agent sets `memory` at all, because per-agent memory lives on the memory server. A `memory: none` line is a failure even though it looks tidy.

6. **Every skill named in a `skills:` list exists as a directory containing `SKILL.md` under `claudecode-agents/skills/`.** A missing skill is a silent no-op, not an error, and the effect is an agent that behaves as though a procedure it depends on was never written. Check the reverse too - a skill nothing preloads and nothing discovers is dead weight in the plugin.

7. **`name` equals the filename without `.md` and equals the roster row.** A mismatch makes the agent undelegatable by the name the lead was told to use.

8. **`tools` is present and is an allowlist.** No fleet subagent inherits every tool. Any "MCP read" intent is expanded into individually named read tools, because `mcp__claude_ai_Memory__*` grants the write tools too, and any invariant worth stating is repeated in `disallowedTools` as a second lock.

## The model migration itself

9. **Strip double-check scaffolding.** Delete lines of the shape "double-check your work", "verify before answering", "re-read the file to be sure" and "spawn a subagent to confirm". On 5-family models this scaffolding causes over-verification and over-delegation - the agent burns turns re-reading what it already read and spawning confirmatory subagents nobody asked for. The failure is a run that costs three times what it should and reaches the same answer. The same goes for thinking prompts - "think carefully", "think step by step", "think hard": from Opus 5.5 the model thinks before every reply and picks its own depth, so the line does nothing but spend tokens. Never ask an agent to reproduce its internal reasoning in its reply either; on Opus 5.5 that can trip the preserved-thinking safeguard, and the handoff's four headings are the only account of the work an agent owes.

10. **Add explicit length constraints.** Wherever output length matters, say the number - "under 60 lines", "three to five sentences", "one paragraph", "six steps or fewer". Without it, 5-family models drift long. A body with no stated length anywhere is a finding.

11. **Rerun the effort sweep.** Effort was recalibrated with Opus 5 and 4.x settings do not carry over, and again with Opus 5.5, whose `medium` lands roughly where Opus 5's `high` did - so expect the sweep to move settings down, not just confirm them. For each agent, run its smoke eval one step below and one step above its current effort and keep the cheapest setting that holds the baseline score. Assuming the existing value still holds is the failure, and it shows up as either a quality regression nobody attributes to the migration or a bill nobody explains.

12. **Remove any `temperature` or `top_p` from SDK code.** Grep `scripts/`, `evals/` and any workflow for both. They are not supported on 5-family models and leaving them in either errors on the call or is silently ignored, which is worse because the eval then measures something other than what ships.

13. **Expect 1 to 1.35x tokeniser inflation.** The same text counts as more tokens than it did on 4.x. Recheck every hard-coded token ceiling, context budget, truncation limit and cost assumption in scripts and evals. The failure is a prompt that used to fit and now truncates from the top, silently dropping the frontmatter of whatever was appended last.

14. **Every `model:` override still names a valid alias.** Check both agent bodies and skill frontmatter. Values are aliases only - `opus`, `sonnet`, `haiku`, `fable`, `inherit` - never a pinned ID, and the alias must still appear in the current models list. An alias that was retired or a pinned ID that was deprecated fails at run time, in the middle of somebody's session.

15. **`effort` is one of `low`, `medium`, `high`, `xhigh`, `max` and matches the roster row.** If the roster and the body disagree, the roster is the thing under review, not the body - fix whichever is actually wrong and say which in the PR.

## The body

16. **Under 60 lines total, frontmatter included.** `wc -l claudecode-agents/agents/*.md | sort -rn`. A body over the limit is carrying something that belongs in a skill; report what.

17. **Four H2 sections, in the contract's order, and no others.** Opening paragraph unheaded, then Scope, How you work, Invariants, Handoff. No H1. A missing Handoff section is a hard failure because the `SubagentStop` hook depends on the format it points at.

18. **No pasted skill text, no conditional model or effort logic, no persona, no board writes.** Text that explains what `handoff` or `board` says is a copy that will go stale. A line of the shape "if the diff touches auth, use xhigh" is wrong in a body because an agent cannot change its own model mid-run and the decision belongs to the lead. A line telling an agent to update a status is wrong because columns are written by hooks.

19. **Conventions hold.** Australian spelling, standard hyphens only, no em dashes or en dashes, no emojis, second person throughout, and prose that is not hard-wrapped. Run the second command above for the dashes and the third for the wrapping; each prints every offending line with its file and line number. The third skips frontmatter, fenced blocks, tables and lists, and treats a line ending in punctuation as deliberate, so `## Invariants` does not trip it.

20. **The contract file itself is current.** If this migration added or renamed a field, `docs/agent-contract.md` changes first and the ten bodies second, in the same PR. A checklist run against a stale contract passes everything and proves nothing.

## Reporting

File one PR carrying the diffs and a findings table of file, check number, what failed and the proposed fix. Anything you cannot decide - a roster row that contradicts a body, an alias that has no obvious replacement - is a `Blocker:` line in the handoff rather than a guess committed to a branch. New work the run surfaced but did not do is a `Propose item:` line.
