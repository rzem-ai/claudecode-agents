#!/usr/bin/env python3
"""Decide whether an agent's Write may land where it is pointed.

The bash hook checks a write destination with a glob on a lexically normalised
path. That misses three things, and each of them was reachable:

  * `*/docs/specs/*` matches any project's specs directory, so spec-writer
    could write into a different repository entirely.
  * lexical normalisation collapses `..` without ever asking the filesystem,
    so a symlinked `docs/specs` pointing at `src` resolved to itself.
  * ui-designer's branch returned immediately for non-Bash tools and
    tech-writer had no branch at all - both hold Write, and Write replaces a
    source file just as thoroughly as Edit does.

Roles and their destinations:

  spec-writer    <project>/docs/specs/**            one spec, nowhere else
  fleet-steward  <repo>/**                          its own working copy
  tech-writer    documentation: docs/**, and *.md at the project root
  ui-designer    prototypes/**, plus docs/runs/** for a commissioned article
  refuter        anywhere EXCEPT <project>/**       it mutates copies

The refuter is the only inverted one, so it is the only one that needs
CLAUDE_PROJECT_DIR to be set: an allowlist survives a wrong project by being
narrower than intended, a denial does not. Unset, refuter denies.

CLAUDECODE_AGENTS_OUTPUT_FILES may narrow tech-writer and ui-designer to an exact
list of commissioned files, as JSON mapping role to paths:

  {"tech-writer": ["README.md", "docs/adr/001-session-refresh.md"]}

It narrows and never widens: a path outside the role's default scope is not
granted by listing it. Set it in the launching environment, never in
agent-authored content - a role that can write its own allowlist has none.
Unset, the defaults above apply, because a checker that denies everything when
unconfigured is a checker nobody will leave switched on.

Resolution is physical (symlinks followed, via os.path.realpath) on the deepest
existing ancestor, because the file being written usually does not exist yet.
Exit 0 allows, 1 denies. Any error denies: a scope that cannot be established
is not a scope that has been satisfied.

Not covered here: writes made by a program the agent runs through Bash, and a
symlink swapped between this check and the write itself. Both need filesystem
containment, which no shell-level check provides; see docs/limits.md.
"""

import json
import os
import sys
from pathlib import Path

ROLES = {'spec-writer', 'ui-designer', 'tech-writer', 'fleet-steward', 'refuter'}


def resolve(path):
    """Absolute, with symlinks followed as far as the path actually exists."""
    path = Path(os.path.abspath(os.path.expanduser(str(path))))
    existing = path
    tail = []
    while not existing.exists() and existing != existing.parent:
        tail.append(existing.name)
        existing = existing.parent
    real = Path(os.path.realpath(str(existing)))
    for name in reversed(tail):
        real = real / name
    return real


def inside(path, root):
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return path != root


def default_scope(role, project):
    if role == 'tech-writer':
        return [project / 'docs'], ['.md', '.mdx', '.txt']
    if role == 'ui-designer':
        return [project / 'prototypes', project / 'docs' / 'runs'], None
    return [], None


def configured(role, project):
    raw = os.environ.get('CLAUDECODE_AGENTS_OUTPUT_FILES', '')
    if not raw.strip():
        return None
    entries = json.loads(raw).get(role)
    if not entries:
        return None
    allowed = set()
    for item in entries:
        path = Path(os.path.expanduser(str(item)))
        if not path.is_absolute():
            path = project / path
        allowed.add(resolve(path))
    return allowed


def main():
    event = json.load(sys.stdin)
    role = event.get('agent_type', '').split(':')[-1]
    if role not in ROLES:
        return 0

    data = event.get('tool_input') or {}
    raw = data.get('file_path') or data.get('notebook_path') or data.get('path')
    cwd = event.get('cwd')
    if not raw or not cwd:
        return 1

    target = Path(os.path.expanduser(str(raw)))
    if not target.is_absolute():
        target = Path(cwd) / target
    target = resolve(target)

    if role == 'fleet-steward':
        root = os.environ.get('CLAUDECODE_AGENTS_REPO')
        if not root:
            return 1
        return 0 if inside(target, resolve(root)) else 1

    project = resolve(os.environ.get('CLAUDE_PROJECT_DIR') or cwd)

    if role == 'refuter':
        # The inverse of every scope below: the refuter may write anywhere
        # EXCEPT the project. It mutates copies, and a mutation written back
        # into the tree it is testing is not a mutation, it is a change.
        # Physically resolved, so a symlink pointing back in resolves back in.
        #
        # inside() excludes the root itself (path == root), which is the
        # right call for every allowlist role below - "write under this
        # root" should not license overwriting the root directory entry -
        # but it is the wrong call for a role whose rule is a denial: the
        # project root is squarely inside the tree under test, not outside
        # it, so it has to be checked for on its own.
        #
        # And unlike every role below, this one cannot fall back to cwd. The
        # allowlist roles survive an unset CLAUDE_PROJECT_DIR because their
        # rule is "inside this root", so a wrong root only widens an allowance
        # that still has to be inside something. A denial has no such floor:
        # with the variable unset and the event's cwd pointing anywhere else,
        # "outside the project" resolves to a project that is not the one
        # under test, and a write into the tree under test is allowed. That is
        # the one role designed to fail closed failing open. Same stance as
        # fleet-steward above, which returns 1 when its root is unset.
        if not os.environ.get('CLAUDE_PROJECT_DIR'):
            return 1
        return 1 if target == project or inside(target, project) else 0

    if role == 'spec-writer':
        # Anchor to the physical specs directory of *this* project. If it
        # resolves somewhere else, it has been redirected, and a redirected
        # specs root is exactly the case this is here to catch.
        root = project / 'docs' / 'specs'
        if root.exists() and resolve(root) != root:
            return 1
        return 0 if inside(target, root) else 1

    roots, suffixes = default_scope(role, project)
    in_default = any(inside(target, r) for r in roots)
    if role == 'tech-writer' and not in_default:
        # A top-level README or CHANGELOG is documentation too.
        in_default = target.parent == project and target.suffix.lower() in ('.md', '.mdx')
    if not in_default:
        return 1
    if suffixes and target.suffix.lower() not in suffixes:
        return 1

    exact = configured(role, project)
    if exact is not None and target not in exact:
        return 1
    return 0


try:
    sys.exit(main())
except Exception:
    sys.exit(1)
