#!/usr/bin/env bash
#
# install-home.sh - put the fleet's user-scope files on this machine.
#
# Three jobs, design sections 10 and 12:
#
#   1. Copy `home/` into `~/.claude` - settings.json, CLAUDE.md, rules/ and any
#      local agent copies. Copies, never symlinks: Cowork skips a symlinked
#      ~/.claude/CLAUDE.md (section 8).
#   2. Render the ten per-agent rzem-memory credentials out of 1Password with
#      `op read` into ~/.config/claudecode-agents/ at mode 600 (section 6).
#   3. Build the board binary into ~/.local/bin/board. The board itself lives
#      in each repository at .boards/ (created by /init) and is nothing the
#      installer touches.
#
# What it never touches: ~/.claude/projects/, sessions, history, todos, debug,
# logs, shell snapshots and plugins/cache. Those are per-machine state and this
# script has no business in them. The guard is enforced, not just documented -
# see is_protected() below.
#
# The plugin itself is not installed here. That is
#   claude plugin marketplace update rzem
# plus a trusted repo carrying claudecode-agents/templates/project-settings.json.
#
# Usage:
#   scripts/install-home.sh                 install everything
#   scripts/install-home.sh --dry-run       show what would change, change nothing
#   scripts/install-home.sh --home-only     skip the secrets, do not require op
#   scripts/install-home.sh --secrets-only  skip the file copy
#   scripts/install-home.sh --help
#
# Safe to re-run. Identical files are left alone, and anything about to be
# overwritten is backed up first (secrets excepted - see render_secret()).

set -euo pipefail

# ---------------------------------------------------------------------------
# 1Password references - PLACEHOLDERS. Fill these in.
# ---------------------------------------------------------------------------
#
# The fleet vault does not exist yet. Every op:// reference below is a guess at
# the shape, not a real item, and each one is wrong until the human points it at the
# real vault, item and field. This is the only block in the script that should
# ever need editing.
#
# Shape:  op://<vault>/<item>/<field>
# Check one with:  op read 'op://Fleet/rzem-memory-lead/credential'
#
# The vault holds fleet secrets only (section 12), so a service account scoped
# to it cannot reach anything personal.

OP_VAULT="Fleet"   # PLACEHOLDER: the dedicated fleet vault's name

# Ten per-agent rzem-memory credentials. One identity per agent, because the
# credential is what fixes the memory namespace (section 6).
OP_REF_MEMORY_LEAD="op://Fleet/rzem-memory-lead/credential"                     # PLACEHOLDER
OP_REF_MEMORY_SCOUT="op://Fleet/rzem-memory-scout/credential"                   # PLACEHOLDER
OP_REF_MEMORY_SPEC_WRITER="op://Fleet/rzem-memory-spec-writer/credential"       # PLACEHOLDER
OP_REF_MEMORY_CODER="op://Fleet/rzem-memory-coder/credential"                   # PLACEHOLDER
OP_REF_MEMORY_REVIEWER="op://Fleet/rzem-memory-reviewer/credential"             # PLACEHOLDER
OP_REF_MEMORY_REFUTER="op://Fleet/rzem-memory-refuter/credential"               # PLACEHOLDER
OP_REF_MEMORY_UI_DESIGNER="op://Fleet/rzem-memory-ui-designer/credential"       # PLACEHOLDER
OP_REF_MEMORY_TECH_WRITER="op://Fleet/rzem-memory-tech-writer/credential"       # PLACEHOLDER
OP_REF_MEMORY_RESEARCHER="op://Fleet/rzem-memory-researcher/credential"         # PLACEHOLDER
OP_REF_MEMORY_FLEET_STEWARD="op://Fleet/rzem-memory-fleet-steward/credential"   # PLACEHOLDER

# destination filename | op:// reference. The destination names are the contract
# with the hooks and the MCP config, so change them together or not at all.
secret_specs() {
    printf '%s\n' \
        "rzem-memory-lead|$OP_REF_MEMORY_LEAD" \
        "rzem-memory-scout|$OP_REF_MEMORY_SCOUT" \
        "rzem-memory-spec-writer|$OP_REF_MEMORY_SPEC_WRITER" \
        "rzem-memory-coder|$OP_REF_MEMORY_CODER" \
        "rzem-memory-reviewer|$OP_REF_MEMORY_REVIEWER" \
        "rzem-memory-refuter|$OP_REF_MEMORY_REFUTER" \
        "rzem-memory-ui-designer|$OP_REF_MEMORY_UI_DESIGNER" \
        "rzem-memory-tech-writer|$OP_REF_MEMORY_TECH_WRITER" \
        "rzem-memory-researcher|$OP_REF_MEMORY_RESEARCHER" \
        "rzem-memory-fleet-steward|$OP_REF_MEMORY_FLEET_STEWARD"
}

# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------

SCRIPT_NAME=$(basename "$0")
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

HOME_SRC="$REPO_ROOT/home"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SECRETS_DIR="$HOME/.config/claudecode-agents"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="${CLAUDECODE_AGENTS_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/claudecode-agents/backups/$STAMP}"

DRY_RUN=0
DO_HOME=1
DO_SECRETS=1

# Counters, reported at the end.
N_CREATED=0
N_UPDATED=0
N_UNCHANGED=0
N_SECRETS_WRITTEN=0
N_SECRETS_UNCHANGED=0
N_SECRETS_FAILED=0
N_BOARD_FAILED=0
N_SKIPPED=0
BACKUP_USED=0

# ---------------------------------------------------------------------------
# Output helpers. Nothing here ever prints a secret value; op:// references are
# not secret and are printed freely so a failure is diagnosable.
# ---------------------------------------------------------------------------

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '%s: warning: %s\n' "$SCRIPT_NAME" "$*" >&2; }
die()  { printf '%s: error: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

usage() {
    sed -n '3,34p' "$0" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
    case "$1" in
        -n|--dry-run)  DRY_RUN=1 ;;
        --home-only)   DO_SECRETS=0 ;;
        --secrets-only) DO_HOME=0 ;;
        -h|--help)     usage; exit 0 ;;
        *)             die "unknown argument: $1 (try --help)" ;;
    esac
    shift
done

# Tracing would print every secret this script handles. Refuse rather than leak.
case "$-" in
    *x*) die "refusing to run under 'set -x' - tracing would print secret values" ;;
esac

# ---------------------------------------------------------------------------
# Host profile. The one `case` where per-box differences live.
# ---------------------------------------------------------------------------
#
# HOST_PROFILE     lab | workstation. Lab boxes run unattended.
# OP_AUTH_EXPECTED service-account | interactive.
# HOST_OVERLAY     optional home/hosts/<name>/ tree, copied over the base tree
#                  after it, for the one or two files that genuinely differ.

HOSTNAME_SHORT=$(hostname -s 2>/dev/null || uname -n 2>/dev/null || echo unknown)
HOSTNAME_SHORT=${HOSTNAME_SHORT%%.*}

case "$HOSTNAME_SHORT" in
    slarti)
        HOST_PROFILE="lab"
        OP_AUTH_EXPECTED="service-account"
        HOST_OVERLAY="$HOME_SRC/hosts/slarti"
        ;;
    eddie)
        HOST_PROFILE="lab"
        OP_AUTH_EXPECTED="service-account"
        HOST_OVERLAY="$HOME_SRC/hosts/eddie"
        ;;
    marvin)
        # PLACEHOLDER: the laptop's short hostname. Correct this arm if it is
        # not `marvin`; an unrecognised host still installs, it just warns.
        HOST_PROFILE="workstation"
        OP_AUTH_EXPECTED="interactive"
        HOST_OVERLAY="$HOME_SRC/hosts/marvin"
        ;;
    *)
        HOST_PROFILE="workstation"
        OP_AUTH_EXPECTED="interactive"
        HOST_OVERLAY="$HOME_SRC/hosts/$HOSTNAME_SHORT"
        warn "host '$HOSTNAME_SHORT' is not one of the known boxes (slarti, eddie, the laptop)."
        warn "treating it as a workstation with interactive 1Password auth."
        ;;
esac

# ---------------------------------------------------------------------------
# 1Password preflight. Runs before anything is written.
# ---------------------------------------------------------------------------

OP_READY=0

check_op() {
    if ! command -v op >/dev/null 2>&1; then
        say "1Password CLI (op) not found on PATH."
        say ""
        say "  macOS:  brew install 1password-cli"
        say "  Linux:  https://developer.1password.com/docs/cli/get-started/"
        say ""
        say "Then re-run. To install the files and skip the secrets for now:"
        say "  scripts/$SCRIPT_NAME --home-only"
        return 1
    fi

    if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
        # Lab-box path. No one is there to touch a fingerprint reader, so op
        # authenticates with a service account token (section 12).
        if op whoami >/dev/null 2>&1; then
            info "1Password: authenticated with a service account token (OP_SERVICE_ACCOUNT_TOKEN)."
            return 0
        fi
        say "OP_SERVICE_ACCOUNT_TOKEN is set but 'op whoami' failed."
        say ""
        say "The token is most likely expired, revoked, or not scoped to the"
        say "'$OP_VAULT' vault. It is the one secret provisioned by hand per lab"
        say "machine, so fix it there:"
        say ""
        say "  1. Check the service account in 1Password and its vault access."
        say "  2. Re-export the token in this box's environment file."
        say "  3. op whoami   (should print the service account, not an error)"
        say ""
        return 1
    fi

    # No service account token. Interactive session expected.
    if op whoami >/dev/null 2>&1; then
        info "1Password: signed in interactively as this desktop user."
        return 0
    fi

    say "1Password CLI is installed but not signed in."
    say ""
    if [ "$OP_AUTH_EXPECTED" = "service-account" ]; then
        say "This box ($HOSTNAME_SHORT) is a lab box, and lab boxes have nobody"
        say "to approve a biometric prompt. It should be using a 1Password"
        say "service account, and OP_SERVICE_ACCOUNT_TOKEN is not set here."
        say ""
        say "  1. Create a service account scoped to the '$OP_VAULT' vault only."
        say "  2. Put its token in this machine's environment, not in the repo:"
        say "       export OP_SERVICE_ACCOUNT_TOKEN='ops_...'"
        say "  3. Re-run this script."
        say ""
        say "That token is the single hand-provisioned secret per lab machine."
    else
        say "Sign in and re-run:"
        say ""
        say "  eval \"\$(op signin)\""
        say "  scripts/$SCRIPT_NAME"
        say ""
        say "If this is actually an unattended box, set OP_SERVICE_ACCOUNT_TOKEN"
        say "instead and this script will use it without prompting."
    fi
    say ""
    return 1
}

# ---------------------------------------------------------------------------
# The protected-path guard
# ---------------------------------------------------------------------------
#
# Nothing this script writes may land in per-machine state. The list is checked
# against the relative path under ~/.claude, so a stray file committed into
# home/ cannot smuggle itself into sessions or the plugin cache.

is_protected() {
    case "$1" in
        projects|projects/*) return 0 ;;
        sessions|sessions/*) return 0 ;;
        history|history/*|history.jsonl) return 0 ;;
        todos|todos/*) return 0 ;;
        debug|debug/*) return 0 ;;
        logs|logs/*) return 0 ;;
        statsig|statsig/*) return 0 ;;
        shell-snapshots|shell-snapshots/*) return 0 ;;
        file-history|file-history/*) return 0 ;;
        ide|ide/*) return 0 ;;
        worktrees|worktrees/*) return 0 ;;
        plugins/cache|plugins/cache/*) return 0 ;;
        .credentials.json) return 0 ;;
        *) return 1 ;;
    esac
}

# ---------------------------------------------------------------------------
# File installation
# ---------------------------------------------------------------------------

backup_file() {
    # $1 destination path, $2 relative path under ~/.claude
    local dest="$1" rel="$2" target
    target="$BACKUP_DIR/$rel"
    if [ "$DRY_RUN" -eq 1 ]; then
        info "would back up  $rel -> $target"
        return 0
    fi
    mkdir -p "$(dirname "$target")"
    cp -p "$dest" "$target"
    BACKUP_USED=1
}

install_settings() {
    # settings.json is merged, never copied. The live file carries machine state
    # the repository has never heard of - model, enabled plugins, statusLine, a
    # deny rule added by hand - and a copy deletes all of it. See
    # scripts/merge-settings.py for the merge policy and what it deliberately
    # will not do (it never removes a managed entry that the repo has dropped).
    local src="$1" rel="$2" dest="$CLAUDE_DIR/$2" tmp staged
    command -v python3 >/dev/null 2>&1 || die 'python3 is required to merge settings.json'
    if [ -L "$dest" ]; then
        die "'$rel' is a symlink; refusing to merge into it. Replace it with a real file first."
    fi

    tmp=$(mktemp "${TMPDIR:-/tmp}/fleet-settings.XXXXXX") || die 'cannot create a temporary file for the settings merge'
    chmod 0600 "$tmp"
    if ! python3 "$REPO_ROOT/scripts/merge-settings.py" "$dest" "$src" "$tmp"; then
        rm -f "$tmp"
        die "merging '$rel' failed; the existing file has not been touched"
    fi

    if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
        rm -f "$tmp"
        N_UNCHANGED=$((N_UNCHANGED + 1))
        return 0
    fi

    if [ -e "$dest" ]; then
        backup_file "$dest" "$rel"
        N_UPDATED=$((N_UPDATED + 1))
    else
        N_CREATED=$((N_CREATED + 1))
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
        info "would merge    $rel (unrelated settings preserved)"
        rm -f "$tmp"
        return 0
    fi

    mkdir -p "$(dirname "$dest")"
    # Stage beside the destination so the final rename stays on one filesystem.
    staged=$(mktemp "$(dirname "$dest")/.fleet-settings.XXXXXX") || {
        rm -f "$tmp"; die 'cannot stage the merged settings'; }
    if ! cp "$tmp" "$staged" || ! chmod 0644 "$staged" || ! mv "$staged" "$dest"; then
        rm -f "$tmp" "$staged"
        die 'cannot install the merged settings'
    fi
    rm -f "$tmp"
    info "merged         $rel"
}

install_one() {
    # $1 source path, $2 relative path under ~/.claude
    local src="$1" rel="$2" dest mode
    dest="$CLAUDE_DIR/$rel"

    if is_protected "$rel"; then
        warn "refusing to install '$rel': that path is per-machine state and is never touched."
        N_SKIPPED=$((N_SKIPPED + 1))
        return 0
    fi

    if [ "$rel" = 'settings.json' ]; then
        install_settings "$src" "$rel"
        return
    fi

    if [ -x "$src" ]; then mode=0755; else mode=0644; fi

    if [ -L "$dest" ]; then
        # Cowork skips a symlinked ~/.claude/CLAUDE.md, so a symlink here is a
        # bug even when it points at the right content. Replace it with a copy.
        warn "'$rel' is a symlink; replacing it with a real file (Cowork ignores symlinked config)."
        if [ "$DRY_RUN" -eq 0 ]; then rm -f "$dest"; fi
    fi

    if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
        N_UNCHANGED=$((N_UNCHANGED + 1))
        return 0
    fi

    if [ -e "$dest" ]; then
        backup_file "$dest" "$rel"
        if [ "$DRY_RUN" -eq 1 ]; then
            info "would update   $rel"
        else
            mkdir -p "$(dirname "$dest")"
            cp "$src" "$dest"
            chmod "$mode" "$dest"
            info "updated        $rel"
        fi
        N_UPDATED=$((N_UPDATED + 1))
    else
        if [ "$DRY_RUN" -eq 1 ]; then
            info "would create   $rel"
        else
            mkdir -p "$(dirname "$dest")"
            cp "$src" "$dest"
            chmod "$mode" "$dest"
            info "created        $rel"
        fi
        N_CREATED=$((N_CREATED + 1))
    fi
}

install_tree() {
    # $1 source directory, $2 label for the log, then any number of relative
    # prefixes to skip. The base tree passes "hosts/" so per-box overlays are not
    # installed wholesale - the overlay for this box is applied afterwards, on
    # its own.
    local src="$1" label="$2" file rel skip
    shift 2
    [ -d "$src" ] || return 0
    say ""
    say "$label ($src -> $CLAUDE_DIR)"

    while IFS= read -r -d '' file; do
        rel=${file#"$src"/}
        case "$(basename "$rel")" in
            .gitkeep|.DS_Store) continue ;;
        esac
        for skip in "$@"; do
            case "$rel" in
                "$skip"*) continue 2 ;;
            esac
        done
        install_one "$file" "$rel"
    done < <(find "$src" -type f -print0)
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

render_secret() {
    # $1 destination filename, $2 op:// reference.
    #
    # Secret files are deliberately never backed up. A backup would be a second
    # plaintext copy of a live credential sitting outside the deny list, and the
    # value is re-renderable from 1Password anyway.
    local name="$1" ref="$2" dest tmp
    dest="$SECRETS_DIR/$name"

    if [ "$DRY_RUN" -eq 1 ]; then
        if [ -f "$dest" ]; then
            info "would refresh  $name  <- $ref"
        else
            info "would render   $name  <- $ref"
        fi
        return 0
    fi

    tmp=$(mktemp "$SECRETS_DIR/.tmp.XXXXXX")
    chmod 0600 "$tmp"

    # The value never reaches stdout, a log line, or the shell's history. If op
    # fails, the reference is reported and the value is not.
    if ! op read --no-newline "$ref" > "$tmp" 2>/dev/null; then
        rm -f "$tmp"
        warn "could not read $ref - leaving $name as it is."
        warn "check the vault, item and field names at the top of this script."
        N_SECRETS_FAILED=$((N_SECRETS_FAILED + 1))
        return 0
    fi

    if [ ! -s "$tmp" ]; then
        rm -f "$tmp"
        warn "$ref resolved to an empty value - leaving $name as it is."
        N_SECRETS_FAILED=$((N_SECRETS_FAILED + 1))
        return 0
    fi

    if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
        rm -f "$tmp"
        chmod 0600 "$dest"
        N_SECRETS_UNCHANGED=$((N_SECRETS_UNCHANGED + 1))
        return 0
    fi

    mv "$tmp" "$dest"
    chmod 0600 "$dest"
    info "rendered       $name  <- $ref"
    N_SECRETS_WRITTEN=$((N_SECRETS_WRITTEN + 1))
}

install_secrets() {
    local line name ref
    say ""
    say "Secrets ($SECRETS_DIR, mode 600)"

    if [ "$DRY_RUN" -eq 0 ]; then
        mkdir -p "$SECRETS_DIR"
        chmod 0700 "$SECRETS_DIR"
    else
        if [ ! -d "$SECRETS_DIR" ]; then
            info "would create   $SECRETS_DIR (mode 700)"
        fi
    fi

    while IFS='|' read -r name ref; do
        [ -n "$name" ] || continue
        render_secret "$name" "$ref"
    done <<EOF
$(secret_specs)
EOF
}

# ---------------------------------------------------------------------------
# The board
# ---------------------------------------------------------------------------
#
# The board lives in each repository at .boards/, created by /init and
# committed like any other project file. This installer's only job here is
# the binary.

install_board() {
    local pkg="$REPO_ROOT/claudecode-agents/board"
    local log
    say ""
    say "Board binary"

    if ! command -v bun >/dev/null 2>&1; then
        warn "bun is not installed; the board binary cannot be built."
        warn "  curl -fsSL https://bun.sh/install | bash   then re-run."
    elif [ "$DRY_RUN" -eq 1 ]; then
        info "would build    ~/.local/bin/board"
    else
        # The build is quiet while it succeeds and loud when it does not: its
        # output is the only diagnosis there is, and a silent failure here leaves
        # board.sh falling back to bun or exiting 127 with nobody the wiser.
        mkdir -p "$HOME/.local/bin"
        log=$(mktemp "${TMPDIR:-/tmp}/fleet-board-build.XXXXXX") || die 'cannot create a temporary file for the board build log'
        if "$pkg/build.sh" "$HOME/.local/bin/board" >"$log" 2>&1; then
            info "built          ~/.local/bin/board"
        else
            sed 's/^/    /' "$log" >&2
            warn "the board binary could not be built; see the build output above"
            N_BOARD_FAILED=$((N_BOARD_FAILED + 1))
        fi
        rm -f "$log"
    fi
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

say "$SCRIPT_NAME"
say "  repo        $REPO_ROOT"
say "  host        $HOSTNAME_SHORT (profile: $HOST_PROFILE, 1Password: $OP_AUTH_EXPECTED)"
say "  ~/.claude   $CLAUDE_DIR"
say "  secrets     $SECRETS_DIR"
if [ "$DRY_RUN" -eq 1 ]; then
    say "  mode        DRY RUN - nothing is written"
else
    say "  backups     $BACKUP_DIR"
fi

[ -d "$HOME_SRC" ] || die "no home/ directory in $REPO_ROOT - is this the claudecode-agents repo?"

if [ "$DO_SECRETS" -eq 1 ]; then
    say ""
    say "Checking 1Password"
    if check_op; then
        OP_READY=1
    else
        if [ "$DRY_RUN" -eq 1 ]; then
            warn "1Password is not usable; the dry run will still show the file changes."
            OP_READY=0
        else
            die "1Password is not usable - nothing has been changed. See above, or use --home-only."
        fi
    fi
fi

if [ "$DO_HOME" -eq 1 ]; then
    if [ ! -f "$HOME_SRC/CLAUDE.md" ]; then
        warn "home/CLAUDE.md does not exist yet, so ~/.claude/CLAUDE.md will not be installed."
    fi
    if [ "$DRY_RUN" -eq 0 ]; then
        mkdir -p "$CLAUDE_DIR"
    fi
    install_tree "$HOME_SRC" "Base tree" "hosts/"
    if [ -d "$HOST_OVERLAY" ]; then
        install_tree "$HOST_OVERLAY" "Host overlay for $HOSTNAME_SHORT"
    fi
fi

if [ "$DO_SECRETS" -eq 1 ] && { [ "$OP_READY" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; }; then
    install_secrets
fi

install_board

say ""
say "Summary"
if [ "$DO_HOME" -eq 1 ]; then
    say "  files     created $N_CREATED, updated $N_UPDATED, unchanged $N_UNCHANGED, skipped $N_SKIPPED"
fi
if [ "$DO_SECRETS" -eq 1 ]; then
    say "  secrets   written $N_SECRETS_WRITTEN, unchanged $N_SECRETS_UNCHANGED, failed $N_SECRETS_FAILED"
fi
if [ "$N_BOARD_FAILED" -gt 0 ]; then
    say "  board     the binary could not be built"
fi
if [ "$BACKUP_USED" -eq 1 ]; then
    say "  backups   $BACKUP_DIR"
fi
if [ "$DRY_RUN" -eq 1 ]; then
    say ""
    say "Dry run. Re-run without --dry-run to apply."
fi
if [ "$N_SECRETS_FAILED" -gt 0 ] || [ "$N_BOARD_FAILED" -gt 0 ]; then
    say ""
    if [ "$N_SECRETS_FAILED" -gt 0 ]; then
        say "$N_SECRETS_FAILED secret(s) could not be read. The op:// references at the top of"
        say "this script are placeholders until the fleet vault exists - fill them in."
    fi
    if [ "$N_BOARD_FAILED" -gt 0 ]; then
        say "The board binary was not built, so board.sh falls back to bun or exits 127."
        say "The build output is above; fix it and re-run."
    fi
    exit 1
fi
