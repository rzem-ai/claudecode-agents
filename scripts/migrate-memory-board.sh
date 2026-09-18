#!/usr/bin/env bash
# migrate-memory-board.sh PROJECT REPO
#
# One-shot: move the items filed under PROJECT in the memory tree's board into
# REPO's .boards/tasks/, renumbered from the next free id there in creation
# order, with the old id kept as a reference, and commit once. The memory
# tree is read, never written; delete its board/ by hand when satisfied. A
# rerun skips items already present in REPO (matched by their memory-tree
# reference), so it is safe to run twice.
set -euo pipefail

project="${1:?usage: migrate-memory-board.sh PROJECT REPO}"
repo="${2:?usage: migrate-memory-board.sh PROJECT REPO}"
old="${CLAUDECODE_AGENTS_OLD_BOARD:-$HOME/.memory/board}"

[ -d "$old/tasks" ] || { echo "no old board at $old/tasks" >&2; exit 1; }
[ -d "$repo/.boards/tasks" ] || { echo "$repo has no .boards/tasks; run /init there first" >&2; exit 1; }
git -C "$repo" rev-parse --is-inside-work-tree >/dev/null

prefix="$(sed -n 's/^task_prefix: *"\{0,1\}\([A-Za-z]*\)"\{0,1\}.*/\1/p' "$repo/.boards/config.yml")"
prefix="${prefix:-BD}"

# Highest id already in the target, across the working tree and every ref.
highest=0
while IFS= read -r n; do
    [ "$n" -gt "$highest" ] && highest="$n"
done < <(
    { ls "$repo/.boards/tasks" 2>/dev/null
      git -C "$repo" for-each-ref --format='%(refname)' refs/heads refs/remotes \
        | while IFS= read -r ref; do git -C "$repo" ls-tree -r --name-only "$ref" -- .boards/tasks 2>/dev/null; done
    } | grep -oiE "(^|/)${prefix}-[0-9]+" | grep -oE '[0-9]+$' || true
)

moved=0
filed=0
# Creation order: the old id's number, ascending.
while IFS= read -r file; do
    grep -qiE "^project: *[\"']?${project}[\"']?\s*$" "$file" || continue
    filed=$((filed + 1))
    oldid="$(sed -n 's/^id: *//p' "$file" | head -1)"
    if grep -rqF -- "  - memory-tree ${oldid}" "$repo/.boards/tasks"; then
        printf 'skip %s: already migrated\n' "$oldid"
        continue
    fi
    # title may be a plain scalar or a YAML block scalar (>- or |-) spanning
    # several indented lines; join those into one string for the slug.
    title="$(awk '
        BEGIN { fmcount = 0; intitle = 0; buf = "" }
        {
            line = $0
            if (line == "---") { fmcount++; if (fmcount == 2) exit; next }
            if (fmcount != 1) next
            if (intitle) {
                if (line ~ /^[ \t]/) {
                    gsub(/^[ \t]+/, "", line)
                    buf = buf (buf == "" ? "" : " ") line
                    next
                }
                intitle = 0
            }
            if (line ~ /^title:/) {
                rest = line
                sub(/^title: */, "", rest)
                if (rest ~ /^[|>]/) { intitle = 1 } else { buf = rest }
            }
        }
        END { print buf }
    ' "$file" | sed -e 's/^"//' -e 's/"$//')"
    highest=$((highest + 1))
    newid="${prefix}-${highest}"
    slug="$(printf '%s' "$title" | tr -cs 'A-Za-z0-9' '-' | sed -e 's/^-//' -e 's/-$//')"
    target="$repo/.boards/tasks/$(printf '%s' "$newid" | tr 'A-Z' 'a-z') - ${slug}.md"
    # id line rewritten; the old id kept in references (added if absent).
    # The title may be a multi-line YAML block scalar, so the new
    # "references:" block (when none exists yet) is inserted only once the
    # whole title value - not just its first line - has gone by.
    if grep -q '^references:' "$file"; then
        addref=0
    else
        addref=1
    fi
    awk -v newid="$newid" -v oldid="$oldid" -v addref="$addref" '
        BEGIN { fmcount = 0; intitle = 0; done = 0 }
        {
            line = $0
            if (line == "---") { fmcount++ }
            if (fmcount == 1 && intitle) {
                if (line ~ /^[ \t]/) { print line; next }
                intitle = 0
                if (addref && !done) { print "references:"; print "  - memory-tree " oldid; done = 1 }
            }
            if (fmcount == 1 && line ~ /^id: /) { print "id: " newid; next }
            if (fmcount == 1 && line ~ /^title:/) {
                print line
                rest = line
                sub(/^title: */, "", rest)
                if (rest ~ /^[|>]/) {
                    intitle = 1
                } else if (addref && !done) {
                    print "references:"; print "  - memory-tree " oldid; done = 1
                }
                next
            }
            if (fmcount == 1 && !addref && line ~ /^references:/) {
                print line
                print "  - memory-tree " oldid
                next
            }
            print line
        }
    ' "$file" > "$target"
    printf 'moved %s -> %s\n' "$oldid" "$newid"
    moved=$((moved + 1))
done < <(ls "$old/tasks"/*.md | sort -t- -k2,2n)

if [ "$moved" -eq 0 ]; then
    if [ "$filed" -eq 0 ]; then
        echo "nothing filed under project '$project' in $old/tasks"
    else
        echo "all $filed items of project '$project' already migrated into $repo"
    fi
    exit 0
fi
git -C "$repo" add -- .boards
git -C "$repo" commit -q -m "board: ${moved} items migrated from the memory tree's board (project ${project})" -- .boards
printf 'committed %s items into %s\n' "$moved" "$repo"
