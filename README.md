# claudecode-agents

A personal Claude Code subagent fleet: ten role-shaped agents delegated to from a Claude Code session, the skills they share, the hooks that keep the board honest, the board itself, and the evals that catch a regression before a model release does. The claudecode-agents repo is a Claude Code plugin marketplace with one plugin, and it is the single source of truth - every machine and cloud session that runs the fleet gets it from here.

The agents are roles, not personas: disposable by design, with fresh context on every spawn and their memory on a server rather than in their heads. The fleet also maintains itself - a `fleet-steward` agent watches model releases and files PRs against the claudecode-agents repo, and most substantial changes here were produced by the fleet's own workflows, then reviewed the same way any other change would be.

## The fleet

| Agent | Job |
|---|---|
| `lead` | Plans, routes and gates. Runs as the main session (the `agent` key in project settings), never spawned |
| `scout` | Cheap read-only reconnaissance: where is X, how does Y work. Locations and excerpts, never opinions |
| `spec-writer` | Turns a brain dump or a board item into a spec, interviewing first |
| `coder` | Implements one approved plan phase, tests first, in its own git worktree |
| `reviewer` | Reviews a diff for correctness, design and security. Reports, never edits |
| `refuter` | Tries to break what was just built and reports what broke it. Never fixes |
| `ui-designer` | Screens, flows and HTML prototypes from a spec |
| `tech-writer` | READMEs, ADRs, runbooks and drafts from material that already exists |
| `researcher` | Fan-out reading and synthesis with citations |
| `fleet-steward` | Weekly model and tooling sweep. Files PRs, never merges |

Each body in [`claudecode-agents/agents/`](claudecode-agents/agents/) carries its model, effort, tool allowlist, preloaded skills and invariants; the reasoning behind every choice is in the plan, section 4.

## How it works

**Every agent ends with the same handoff.** Four headings - Done, Not done, Unverified, Decisions needed - with typed lines under the last (`Blocker:`, `Propose item:`, `Propose memory:`), so the lead can merge a stack of handoffs without re-reading a stack of transcripts. The format is the `handoff` skill, preloaded everywhere and enforced by a hook.

**Hooks write the board; agents never do.** `SubagentStart` moves a board item to Doing, `SubagentStop` writes Blocked or Blocked by human (a `Blocker:` line in the handoff is what lands in the human queue), and `TaskCompleted` gates on tests before writing Done. A fourth hook, `enforce-agent-scope.sh`, denies at `PreToolUse` the tool calls each agent's own invariants forbid - the per-agent boundary that session-scoped permissions cannot express.

**Workflows chain the roles.** `spec-to-plan`, `review-round` and `deep-research` in [`claudecode-agents/workflows/`](claudecode-agents/workflows/) run the multi-agent shapes deterministically instead of hoping the model sequences them.

**Everything is evalled.** Each agent has a smoke eval under [`evals/`](evals/) run with `claude -p`, and `evals/lib/check-all.sh` runs every deterministic check - hook contracts, roster consistency, workflow logic - with no model, no network and no board.

## Installing

The claudecode-agents repo is a Claude Code plugin marketplace named `rzem` with one plugin in it, `claudecode-agents`, plus the user-scope files and install script for a machine that runs the fleet. There are three layers. The first is all you need to use the agents; the other two are for a machine you run the fleet from.

### Prerequisites

- **Claude Code** with plugin support. `claude plugin --help` should list `marketplace` and `install`; if it does not, update Claude Code first.
- **git**. The claudecode-agents repo is public, so the clone, the marketplace add and background marketplace refreshes all work over plain HTTPS with no credentials. Only pushing changes back needs auth.
- **jq**. Every board hook and the eval runner use it.
- **python3**. The install script's settings merge and the scope hook's write-path check.
- **node**. Only for `evals/lib/check-all.sh`, which syntax-checks the workflows and runs their logic tests.
- **1Password CLI (`op`)**. Only for rendering the fleet secrets in step 3. Skip it with `--home-only` until you need it.
- **bash 3.2 or later**. Everything is written for the bash macOS ships, so no Homebrew bash is required.

### 1. Use the fleet in a project

This is the whole per-project story, and it is what makes Claude Code on the web work too. Two routes end in the same place.

**The template route.** From a clone of the claudecode-agents repo, copy the settings template into the project you want the fleet in:

```bash
git clone https://github.com/rzem-ai/claudecode-agents.git
mkdir -p /path/to/your-project/.claude
cp claudecode-agents/claudecode-agents/templates/project-settings.json /path/to/your-project/.claude/settings.json
```

The template carries three keys: `extraKnownMarketplaces` (the `rzem` marketplace, sourced from the claudecode-agents GitHub repo), `enabledPlugins` (`claudecode-agents@rzem`), and `agent` (`claudecode-agents:lead`, so the main session runs as the lead). If the project already has a `.claude/settings.json`, merge those three keys into it rather than overwriting the file. Then start Claude Code in the project and trust the folder when asked. On trust, Claude Code adds the marketplace, installs and enables the plugin, and the session runs as the lead - no further prompt. Commit `.claude/settings.json` so every clone, every teammate and every Claude Code on the web session gets the same fleet.

**The manual route.** If you would rather not touch project settings, or want the plugin at user scope on this machine:

```bash
claude plugin marketplace add rzem-ai/claudecode-agents
claude plugin install claudecode-agents@rzem
```

Append `@<branch-or-tag>` to the claudecode-agents repo reference (`rzem-ai/claudecode-agents@main`) to pin the marketplace to a ref. The plugin ships the agents, skills, hooks and workflows; it does not decide which agent the main session runs as, so add `"agent": "claudecode-agents:lead"` to the project's `.claude/settings.json` if you want the lead in charge. Inside a session, `/plugin` opens the same marketplace and install flow interactively.

**Verify.** `claude plugin list` shows `claudecode-agents@rzem` as enabled. Inside a session, `/agents` lists the ten fleet agents under the plugin. If the plugin installed but the agents are missing, the marketplace cache is stale - see *Staying current* below.

**The command route.** With the plugin installed (either route above), `/claudecode-agents:init` inside a session does the whole per-project setup in one pass: it merges the three settings keys, copies the CLAUDE.md skeleton and the glossary rule into the project, creates `docs/specs/` and `docs/plans/`, then reads the repo and interviews you to fill every `<FILL: ...>` marker. Re-running it is safe - it skips what already exists and only offers to fill markers still present.

Nothing init writes is live until the next session - settings, `CLAUDE.md` and the plugin itself all load at startup - so init ends by telling you to restart, trust the folder, and run `/claudecode-agents:kickoff`. Kickoff preflights the install (agents present, lead in charge, no markers left, skeleton and work directories in place), then checks the board when the binary answers - `board/config.yml` under the board root, its five statuses, a project for the repo in its `projects` list, the outcome labels - offers to add the repo's project to the config and commit the memory tree, asking before it changes a file four machines share, and ends by stating the conventions: root, the `BD` prefix, status names, project, labels, and the item-ref binding. It cannot tell whether the binary on this machine is current, and says so. On a green preflight it takes the idea you typed after it - or asks for one - and starts the spec pipeline on it. On a red preflight it lists the fixes and stops; declining the board is never red.

**Optional: the project skeleton by hand.** `claudecode-agents/templates/CLAUDE.md` is a project CLAUDE.md with `<FILL: ...>` markers for the things that differ per project, and `claudecode-agents/templates/rules/glossary.md` is the generated glossary rule it refers to. Copy both into the project (`CLAUDE.md` at the root, the rule under `.claude/rules/`) and fill the markers. Never edit the glossary rule by hand - it is generated from the `glossary` skill by `scripts/gen-glossary-rule.sh`.

### 2. Set up a machine

The user-scope half: the hardened `~/.claude/settings.json`, the user CLAUDE.md, rules and any local agent copies that live in `home/`. Run it on any machine that spawns fleet agents.

```bash
git clone https://github.com/rzem-ai/claudecode-agents.git ~/Dev/claudecode-agents
cd ~/Dev/claudecode-agents
scripts/install-home.sh --dry-run      # show what would change, change nothing
scripts/install-home.sh --home-only    # install the files, skip the secrets
```

What it does, and does not do:

- `home/settings.json` is **merged** into `~/.claude/settings.json`, never copied over it. Your model, enabled plugins, status line and hand-added deny rules survive; the fleet's deny list, sandbox and network allowlist are added. `scripts/merge-settings.py` is the policy.
- Everything else in `home/` is copied, not symlinked, because Cowork ignores a symlinked `~/.claude/CLAUDE.md`. An existing symlink is replaced with a real file.
- Anything it is about to overwrite is backed up first under `~/.local/state/claudecode-agents/backups/<timestamp>/` (override with `CLAUDECODE_AGENTS_BACKUP_DIR`).
- It never touches `~/.claude/projects/`, sessions, history, todos, logs or `plugins/cache`. The guard is enforced in the script, not just documented.
- Per-box differences go in `home/hosts/<short-hostname>/`, copied over the base tree after it. Known hosts are `slarti` and `eddie` (lab boxes, service-account 1Password auth) and `marvin` (the laptop); an unrecognised host installs as a workstation with a warning.
- `CLAUDE_CONFIG_DIR` is respected if you keep Claude Code's config somewhere other than `~/.claude`.

It is safe to re-run. Unchanged files are left alone and the summary at the end says what was created, updated and skipped.

### 3. Secrets and the board

The board needs no secret at all. It is a directory of markdown files under the memory tree at `board/`, written by the plugin's own `board` binary, which the installer builds into `~/.local/bin/board`. The hooks make no network call and read no token; without the binary they log a `board shim missing` or a `board <cmd> failed` line and leave the board alone, and the agents themselves work fine, so a machine that has never built it is a working install.

To render the ten per-agent memory credentials from 1Password:

```bash
eval "$(op signin)"                       # interactive; lab boxes export OP_SERVICE_ACCOUNT_TOKEN instead
scripts/install-home.sh --secrets-only    # or drop the flag to do files and secrets together
```

The `op://` references at the top of `scripts/install-home.sh` are placeholders until the fleet vault exists. Edit that one block to point at the real vault, item and field; nothing else in the script should ever need changing. A secret that cannot be read is reported by reference, never by value, and the script exits non-zero so a missing one is not missed.

Knobs, all optional:

- `CLAUDECODE_AGENTS_BOARD_ROOT` points the hooks and the binary at a tree other than `$HOME/.memory`.
- `~/.config/claudecode-agents/board.env` overrides the column names (`BOARD_COL_TODO`, `BOARD_COL_DOING`, `BOARD_COL_BLOCKED`, `BOARD_COL_BLOCKED_HUMAN`, `BOARD_COL_DONE`) if a tree's `board/config.yml` spells a status differently from the fleet's.
- `CLAUDECODE_AGENTS_BOARD=off`, or an empty file at `~/.local/state/claudecode-agents/disabled`, switches board writes off without uninstalling anything. `BOARD_DRY_RUN=1` logs what would be written instead of writing it.
- The three board hooks log to `~/.local/state/claudecode-agents/log/hooks.log` (and to stderr, so it shows in the transcript). Read that first when the board does not move. The scope hook logs to stderr only.

### Staying current

The plugin is semver'd and the version in `claudecode-agents/.claude-plugin/plugin.json` (mirrored in `.claude-plugin/marketplace.json`) is load-bearing: clients keep the cached copy until the number changes, so a release without a version bump is invisible. To pick up a new release:

```bash
claude plugin marketplace update rzem
```

The project template sets `autoUpdate: false` deliberately, so a project moves to a new fleet version when you run that and not when a background refresh decides to. `claudecode-agents/CHANGELOG.md` says what changed in each release. For the machine half, `git pull` in the clone and re-run `scripts/install-home.sh`.

### Checking the install, and working on the claudecode-agents repo

```bash
bash evals/lib/check-all.sh    # every deterministic check: hook contracts, roster, workflow logic. No model, no network, no board
evals/run.sh --list            # the ten smoke evals and each agent's baseline
evals/run.sh scout             # one agent's eval, model in the loop, via claude -p
```

Run `check-all.sh` before anything else after a change; `evals/README.md` covers the runner's flags and environment. To test a local checkout as a plugin rather than the GitHub release, register the clone as a marketplace and install from it - it has the same marketplace name, so remove the GitHub one on that machine first:

```bash
claude plugin marketplace remove rzem
claude plugin marketplace add ./path/to/claudecode-agents
claude plugin install claudecode-agents@rzem
```

Put the GitHub marketplace back with `claude plugin marketplace add rzem-ai/claudecode-agents` when you are done.

## Repo map

```
.claude-plugin/marketplace.json   the marketplace (name: rzem), one plugin in it
claudecode-agents/                    the plugin: agents/, skills/, hooks/, workflows/, commands/, templates/, CHANGELOG.md
evals/                            one smoke eval per agent, plus lib/ with the deterministic suite
docs/fleet-plan.md                the plan: what the fleet is and why, in fifteen sections
docs/agent-contract.md            the shape every agent body conforms to
docs/runs/                        run articles, one per substantial run
docs/plans/                       per-issue implementation plans (the glossary kind, not the fleet plan)
docs/TODO.md                      open items each round has deliberately left, with the reason
home/                             user-scope files the install script places
scripts/                          install-home.sh, gen-glossary-rule.sh, merge-settings.py
```

## Where things are decided

The plan, [`docs/fleet-plan.md`](docs/fleet-plan.md), is the canonical document - "plan section N" anywhere in the claudecode-agents repo means that file. [`docs/agent-contract.md`](docs/agent-contract.md) is what the migration checklist checks agent bodies against, and it records which preloaded skill names are still forward references. [`claudecode-agents/CHANGELOG.md`](claudecode-agents/CHANGELOG.md) records every release, corrections included. And [`docs/TODO.md`](docs/TODO.md) is the open-items list: what each round has looked at and deliberately chosen to leave, with the reason.
