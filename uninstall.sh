#!/usr/bin/env bash
set -euo pipefail

show_help() {
    cat <<'HELP'
Usage: ./uninstall.sh [--skills-dir DIR] [--yes]

Remove only ~/.agents/skills/wow-addon. Local annotations and client
configuration are preserved.
  --skills-dir DIR  Absolute path to the parent skills directory
  --yes             Skip the confirmation prompt
  --help, -h        Show this help
HELP
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

AUTO_YES=false
SKILLS_DIR="${HOME:?HOME must be set}/.agents/skills"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h) show_help; exit 0 ;;
        --yes) AUTO_YES=true; shift ;;
        --skills-dir)
            [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--skills-dir requires an absolute directory path.'
            SKILLS_DIR="$2"; shift 2 ;;
        *) fail "Unknown option: $1. Run ./uninstall.sh --help." ;;
    esac
done

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
case "$SKILLS_DIR" in /*) ;; *) fail '--skills-dir must be an absolute directory path.' ;; esac
case "$SKILLS_DIR" in *$'\n'*) fail 'The skills directory path must not contain a newline.' ;; esac
NORMALIZED=""
IFS='/' read -r -a PARTS <<< "$SKILLS_DIR"
for PART in "${PARTS[@]}"; do
    [ -n "$PART" ] || continue
    case "$PART" in .|..) fail 'Use an absolute skills directory without . or .. path components.' ;; esac
    NORMALIZED="${NORMALIZED}/${PART}"
    [ ! -L "$NORMALIZED" ] || fail "Symbolic links are not supported in the skills path: ${NORMALIZED}. Use the physical directory path."
done
SKILLS_DIR="${NORMALIZED:-/}"
HOME_DIR="$(cd -P "$HOME" && pwd -P)"
[ "$SKILLS_DIR" != / ] && [ "$SKILLS_DIR" != "$HOME_DIR" ] || fail 'Choose a dedicated skills directory, not a filesystem root or home directory.'
TARGET="${SKILLS_DIR}/wow-addon"
[ ! -L "$TARGET" ] || fail "Refusing to remove a symbolic link: ${TARGET}. Remove the link yourself first."
# Compare directory identities because path casing can vary on the same volume.
within_directory() {
    local candidate="$1" ancestor="$2"
    while :; do
        if [ "$candidate" -ef "$ancestor" ]; then return 0; fi
        [ "$candidate" != / ] || return 1
        candidate="${candidate%/*}"
        candidate="${candidate:-/}"
    done
}
if within_directory "$TARGET" "$SCRIPT_DIR" || within_directory "$SCRIPT_DIR" "$TARGET"; then
    fail 'The uninstall destination overlaps the source skill or repository. Choose the installed skills directory.'
fi
if [ ! -e "$TARGET" ]; then
    printf 'Already absent: %s\n' "$TARGET"
    exit 0
fi
[ -d "$TARGET" ] || fail "The skill destination is not a directory: ${TARGET}. Move it yourself first."

if [ "$AUTO_YES" = false ]; then
    printf 'Remove %s? [y/N] ' "$TARGET"
    ANSWER=""
    read -r ANSWER || true
    case "$ANSWER" in
        y|Y|yes|YES|Yes) ;;
        *) printf 'Aborted.\n'; exit 0 ;;
    esac
fi
rm -rf "$TARGET"
printf 'Removed %s\n' "$TARGET"
