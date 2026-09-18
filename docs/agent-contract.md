# Agent contract

Every agent body in `claudecode-agents/agents/` conforms to this file. `claudecode-agents/agents/reviewer.md` is the worked exemplar - read it alongside this.

Design section 11 has the `fleet-steward` running the `migration-checklist` skill over every agent body each time a model ships, and a checklist needs something to check against. This is that thing. When a frontmatter field is added or renamed upstream, the steward's PR updates this file first and the ten bodies second.

Field names below are the ones the sub-agents reference at `https://code.claude.com/docs/en/sub-agents` uses, not the design's table headings.

## 1. Frontmatter

The file is a markdown file with a YAML frontmatter block delimited by `---`. Everything after the closing `---` is the agent's system prompt.

### Fields the fleet uses

| Field | Type | Allowed values | Required | Notes |
|---|---|---|---|---|
| `name` | string | lowercase letters and hyphens | yes | Must equal the filename without `.md` and the roster row's agent name |
| `description` | string | free text, one or two sentences | yes | This is routing copy. The lead reads it to pick an agent, so say what the agent does and when to use it |
| `model` | string | `opus`, `sonnet`, `haiku`, `fable`, `inherit` | no | Alias only. Never a pinned model ID (principle 3). Omitting it inherits the session model, which is not the same as `inherit` being wrong - be explicit |
| `effort` | string | `low`, `medium`, `high`, `xhigh`, `max` | no | Overrides session effort. Omit only where the roster says n/a |
| `tools` | comma-separated string on one line | tool names, `Agent(type)`, `mcp__<server>`, `mcp__<server>__*`, `mcp__<server>__<tool>` | no | An allowlist. Omitting it inherits every tool, which no fleet subagent should do. `lead` is the one omission: it is the session rather than a subagent, so an allowlist would strip tools from the session itself. Written as a single comma-separated line by fleet convention; the sub-agents reference accepts a YAML list as well, so a list here is a style finding rather than a broken agent |
| `disallowedTools` | comma-separated string on one line | same syntax as `tools` | no | Subtracts from the inherited or allowed set. Use it only as a second lock on a stated invariant |
| `skills` | YAML list | skill names | no | Preloads the full skill body at startup. Every fleet agent lists at least `glossary` and `handoff` |
| `color` | string | `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan` | no | Cosmetic; makes an agent findable in the task list. Pick one per agent |
| `isolation` | string | `worktree` | no | Only `coder` sets it |
| `memory` | string | `user`, `project`, `local` | no | **No fleet agent sets this.** See 1.3 |

### Fields that exist but the fleet does not use

`permissionMode`, `mcpServers` and `hooks` are ignored when an agent is loaded from a plugin, so they never appear in a shared body. An agent that genuinely needs one exists as a local copy under `home/agents/` instead (design section 4). `maxTurns`, `background`, `initialPrompt` and `experimental` are unused; do not add them without a reason recorded in the commit.

### 1.3 Where the roster columns do not map cleanly

Four of the design's section 4 columns do not survive contact with the real frontmatter. All ten bodies handle them the same way.

**Memory `none` is not a value.** `memory` accepts `user`, `project` or `local` and nothing else. "Memory: none" in the roster means *omit the field entirely* - the agent then launches with no memory directory and no memory instructions, which is exactly what section 6 wants, because per-agent memory lives on the rzem-memory server instead. Leave a comment line in the frontmatter saying the omission is deliberate, so the steward does not read it as an oversight and a future reviewer does not add `memory: local` to be helpful.

**Isolation `none` is not a value either.** `isolation` accepts only `worktree`. Omit the field for the nine agents that are not `coder`.

**Bash cannot be scoped to git.** The `tools` field has no command-level specifier - there is no `Bash(git:*)`. `Bash` is all of Bash or none of it. So "Bash (git only)" and "Bash (read-only)" in the roster become two things working together: `Bash` in `tools`, plus an explicit invariant line in the body naming the git verbs that are forbidden. Real enforcement is the `PreToolUse` hook `claudecode-agents/hooks/enforce-agent-scope.sh`, which switches on `agent_type` and can therefore bind one agent; host-level `permissions.deny` (design section 12) is session-scoped, so it applies to every agent in the session or to none. Say this in the body rather than pretending the frontmatter did it.

**Write cannot be scoped to a path.** Same shape of problem: "Write (docs/specs only)" is `Write` in `tools` plus a body invariant naming the directory. The same applies to `Edit` scoped to one repo.

One more that is not a column but bites everywhere: **"MCP (read)" needs explicit tool names.** `mcp__claude_ai_Memory__*` grants the write tools too. A read-only memory agent lists the read tools individually - `memory_search`, `memory_read_document`, `memory_tree`, `memory_kv_get`, `memory_kv_list` - and may repeat the write tools under `disallowedTools` as a second lock. Only `researcher` and the lead get `memory_capture`.

### 1.4 Which preloaded skills resolve

`skills:` resolves a name from the plugin, the project and user scope alike, and a name that resolves nowhere is a silent no-op (check 6 of `migration-checklist`). The plugin ships `board`, `compound`, `glossary`, `handoff`, `humanize`, `looping`, `migration-checklist` and `run-article`, and `brainstorming` resolves from the superpowers plugin. A body names only what resolves: a body naming a skill that does not exist tells the agent a procedure is loaded when it is not, which is worse than the body carrying the procedure inline. When a new skill ships, add it to the bodies that need it and update this paragraph.

## 2. Body structure

Four H2 sections, in this order, after an unheaded opening. No H1. No other headings.

**Opening**, unheaded, one paragraph. Who the agent is and what it returns, in the second person. If the agent sits in a pipeline, say what runs before and after it, so it does not redo work another stage already did. Three to five sentences.

**`## Scope`.** What is in, then what is out. The out-of-scope paragraph is the load-bearing one - it is where you stop an agent drifting into another agent's job. Two short paragraphs.

**`## How you work`.** The procedure, as a numbered list. Six steps or fewer, one line each where possible. Steps name the tools and skills to use at each point. This is the only section where a numbered list is right; do not bullet the others.

**`## Invariants`.** The never-lines, one per line, no bullets. This is the section 8 exception: a three-line invariant is cheaper in the body than as a preloaded skill. Keep it to four or five lines, all absolute, none conditional. If an invariant needs a paragraph to explain, it is a skill, not an invariant.

**`## Handoff`.** One paragraph. State that the handoff is required and that all four headings must be present, then map this agent's output onto the headings and say which findings become `Blocker:` and which become `Propose item:`. Do not restate the format - `handoff` is preloaded and the format lives there.

## 3. Hard rules

Under 60 lines total, frontmatter included. The exemplar is 44. If you cannot fit, the body is carrying something that belongs in a skill.

Never paste skill text into a body (principle 2). Reference a preloaded skill by name in backticks and trust that it is in context. If you find yourself explaining what `handoff` or `looping` says, delete the explanation.

No conditional model or effort logic. Nothing of the shape "if the diff touches auth, use xhigh" or "escalate to Fable for architecture work". All escalation lives in the lead's delegation policy, because that is where the decision is actually made, and an agent cannot change its own model mid-run anyway. The frontmatter values are static.

No personas. These are role names doing a job, not characters. No name, no backstory, no personality. Personas are Sprites and Sprites are out of scope.

The handoff section is mandatory in every body.

Invariants are terse body lines, never a preloaded skill and never a paragraph.

Every agent preloads `glossary` and `handoff` at minimum, and uses the glossary's words with the glossary's meanings.

No agent writes to the board. Board columns are written by hooks (design section 7). A body that tells an agent to update a status is wrong.

## 4. Writing conventions

Australian English: organise, behaviour, colour, recognise, analyse.

Standard hyphens for asides. Never an em dash, never an en dash. This is a hard rule and the most common thing to get wrong.

No emojis, anywhere, ever.

Never hard-wrap prose. One line per paragraph, and let the editor wrap it. Markdown renderers collapse a single newline, so filling to a column changes nothing a reader sees while making every later edit rewrap its whole paragraph: a one word change inside a three line paragraph costs seven diff lines wrapped against two unwrapped. Code fences, table rows and the ASCII trees in this file are structure rather than prose and stay exactly as they are. `## Invariants` also stays one sentence per line, because that is a list of prohibitions rather than a filled paragraph.

Bullets only when the content is genuinely list-shaped. `## How you work` is a numbered list because steps are ordered. `## Scope` and `## Handoff` are prose. `## Invariants` is one sentence per line without bullet markers, because it reads as a list of prohibitions rather than a list of items.

Second person throughout the body. "You review a diff", not "The reviewer reviews a diff" and not "I will review".

Say the thing once. If the opening already said the agent never edits, the invariant says it in different words or not at all.

## 5. Checklist before you commit a body

The `migration-checklist` skill runs a superset of this. Minimum, every time:

1. `name` matches the filename and the roster row.
2. `model` is an alias, not an ID.
3. `effort` matches the roster row.
4. `tools` is a comma-separated line, is an allowlist, and expands any "MCP (read)" into named read tools. `lead` alone omits it.
5. `memory` and `isolation` are absent unless the roster row genuinely asks for `worktree`.
6. `skills` includes `glossary` and `handoff`, and every other name it lists resolves.
7. Four H2 sections, in order, and no others.
8. Under 60 lines.
9. No pasted skill text, no conditional model or effort logic, no persona.
10. No em dashes, no en dashes, no emojis, Australian spelling, and no hard-wrapped prose.

## 6. MCP server names

A `tools` line grants an MCP server by the name Claude Code registered it under - `mcp__<server>` for the whole server, `mcp__<server>__<tool>` for one tool. The name is case-sensitive and nothing normalises it. A body naming a server that does not exist grants nothing, raises no error and prints no warning: the agent just runs without those tools, and the first sign of trouble is a `researcher` that cannot reach Hugging Face or a `spec-writer` that cannot read the board. A wrong server name is a silent no-op, which is why it belongs in this file rather than in someone's memory.

The fleet uses three servers: two reached as claude.ai connectors and one shipped by this plugin. A connector is registered as `claude_ai_<Name>`, with the spaces in its display name turned into underscores. A plugin server is keyed `plugin:<plugin>:<server>`, and every character outside `[a-zA-Z0-9_-]` becomes an underscore, so the colons turn into underscores and a hyphen inside the plugin name survives. `claude mcp list` shows the connectors but not a plugin's own server, and a plugin loaded with `--plugin-dir` brings its skills, commands and agents but never registers its `.mcp.json`, so the identifiers below are what a session's tool list shows rather than what either of those two routes reports:

| Server | Granted as | Carried by | How to confirm the name |
|---|---|---|---|
| rzem-memory, the "Memory" connector at memory-mcp.rzem.ai | `mcp__claude_ai_Memory__<tool>` | all ten agents | `claude mcp list` on a machine logged in to the human's claude.ai account |
| board, this plugin's own server | `mcp__plugin_claudecode-agents_board__<tool>`, granted per tool and denied per tool | `spec-writer`, `fleet-steward`, the lead | the tool list of a live session with the plugin installed, under the server key `plugin:claudecode-agents:board` |
| Hugging Face | `mcp__claude_ai_Hugging_Face` | `researcher` | `claude mcp list` on a machine logged in to the human's claude.ai account |

A server is named in a body only once its identifier is confirmed one of those two ways and recorded in this table first. Context7 is not installed, so `coder` does not carry it; when it is, it arrives either as a connector (`mcp__claude_ai_Context7`) or, from the official plugin, as `mcp__plugin_context7_<server>`, and the same rule applies.

A connector follows the human's claude.ai login rather than a machine, so the lab boxes and Claude Code on the web see the same identifiers as the laptop, but that is an expectation until `claude mcp list` has been run there too. One consequence worth knowing: a connector is one login shared by every agent, so the ten per-agent memory credentials in design section 6 do not separate agent namespaces today.

Two scoping notes that go with the names. rzem-memory reaches all ten agents deliberately (design section 6); every other server stays scoped, because an MCP server's tool list is paid for on every turn of every agent that carries it. And an agent body cannot set `mcpServers` of its own (design section 9), so a server reaches an agent one of two ways: the plugin ships it in its own `.mcp.json`, which is how the board's server arrives and where a new fleet-owned server belongs, or it is a claude.ai connector the human has enabled. Either way the body only names it, under the identifier the table above records.
