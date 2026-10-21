#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# maintain-annotations.sh - Manage multi-flavor WoW annotation repositories
#
# Maintains the Ketho shared API annotations and per-flavor FrameXML
# annotation worktrees. First run clones everything; subsequent runs update.
#
# Usage: ./maintain-annotations.sh [--flavor <name>] [--check] [--help]
#   --flavor <name>  Only update a specific flavor (can be repeated)
#   --check          Check destinations without downloading or changing files
#   --help           Show this help message
#
# Supported flavors: live, classic, classic_era, classic_anniversary
# ---------------------------------------------------------------------------

# -- Colors -----------------------------------------------------------------

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
DIM=$'\033[0;90m'
RESET=$'\033[0m'

# -- Constants --------------------------------------------------------------

KETHO_REPO="https://github.com/Ketho/vscode-wow-api"
FRAMEXML_REPO="https://github.com/NumyAddon/FramexmlAnnotations.git"
# Unix annotation storage deliberately stays at ~/.local/share (XDG-style),
# matching install.sh and the tools' defaultDataRoot(). The PowerShell
# scripts use %LOCALAPPDATA% on Windows.
ANNOTATIONS_DIR="${WOW_ANNOTATIONS_ROOT:-${HOME}/.local/share/wow-annotations}"
FRAMEXML_DIR="${WOW_FRAMEXML_ROOT:-${HOME}/.local/share/wow-framexml}"
BARE_DIR="${FRAMEXML_DIR}/.bare"
SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"

ALL_FLAVORS=(live classic classic_era classic_anniversary)

# -- State ------------------------------------------------------------------

REQUESTED_FLAVORS=()
UPDATED=0
CLONED=0
CHECK_ONLY=false

# -- Parse flags ------------------------------------------------------------

show_help() {
    printf '%s\n' "Usage: $0 [--flavor <name>] [--check] [--help]"
    printf '%s\n' ""
    printf '%s\n' "Options:"
    printf '%s\n' "  --flavor <name>  Only update a specific flavor (can be repeated)"
    printf '%s\n' "  --check           Check destinations without downloading or changing files"
    printf '%s\n' "  --help           Show this help message"
    printf '%s\n' ""
    printf '%s\n' "Supported flavors: ${ALL_FLAVORS[*]}"
    printf '%s\n' ""
    printf '%s\n' "Directories:"
    printf '%s\n' "  Ketho annotations: ${ANNOTATIONS_DIR}"
    printf '%s\n' "  FrameXML flavors:  ${FRAMEXML_DIR}/<flavor>"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help)
            show_help
            ;;
        --check|--check-only)
            CHECK_ONLY=true
            shift
            ;;
        --flavor)
            if [[ $# -lt 2 ]]; then
                printf '%s\n' "${RED}✗${RESET} --flavor requires a value" >&2
                exit 1
            fi
            REQUESTED_FLAVORS+=("$2")
            shift 2
            ;;
        *)
            printf '%s\n' "${RED}✗${RESET} Unknown option: ${1}" >&2
            printf '%s\n' "Usage: $0 [--flavor <name>] [--check] [--help]" >&2
            exit 1
            ;;
    esac
done

# -- Validate requested flavors (Parse Don't Validate) ----------------------

validate_flavors() {
    local flavors=("$@")

    for flavor in "${flavors[@]}"; do
        if ! branch_for_flavor "$flavor" >/dev/null; then
            printf '%s\n' "${RED}✗${RESET} Unknown flavor: ${flavor}" >&2
            printf '%s\n' "Supported flavors: ${ALL_FLAVORS[*]}" >&2
            exit 1
        fi
    done
}

branch_for_flavor() {
    case "$1" in
        live|classic|classic_era|classic_anniversary) printf '%s-mix-into-source\n' "$1" ;;
        *) return 1 ;;
    esac
}

if [[ ${#REQUESTED_FLAVORS[@]} -gt 0 ]]; then
    validate_flavors "${REQUESTED_FLAVORS[@]}"
    ACTIVE_FLAVORS=("${REQUESTED_FLAVORS[@]}")
else
    ACTIVE_FLAVORS=("${ALL_FLAVORS[@]}")
fi

# -- Guard: git must be available -------------------------------------------

if ! command -v git &>/dev/null; then
    printf '%s\n' "Error: Git is missing. Install Git or add it to PATH, then run annotation maintenance again." >&2
    exit 1
fi

# -- Functions --------------------------------------------------------------

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

normalize_destination() {
    local value="$1" normalized="" part
    local parts=()
    case "$value" in /*) ;; *) fail 'Annotation data roots must be absolute directory paths. Set WOW_ANNOTATIONS_ROOT and WOW_FRAMEXML_ROOT to dedicated absolute paths.' ;; esac
    case "$value" in *$'\n'*|*$'\r'*) fail 'Annotation data roots must not contain line breaks.' ;; esac
    IFS='/' read -r -a parts <<< "$value"
    for part in "${parts[@]}"; do
        [[ -n "$part" ]] || continue
        case "$part" in .|..) fail 'Use absolute annotation paths without . or .. components.' ;; esac
        normalized="${normalized}/${part}"
        [[ ! -L "$normalized" ]] || fail "Annotation paths must not contain symbolic links: ${normalized}. Use the physical directory path."
    done
    printf '%s\n' "${normalized:-/}"
}

within_directory() {
    local candidate="$1" ancestor="$2"
    while :; do
        [[ "$candidate" != "$ancestor" && ! "$candidate" -ef "$ancestor" ]] || return 0
        [[ "$candidate" != / ]] || return 1
        candidate="${candidate%/*}"
        candidate="${candidate:-/}"
    done
}

empty_directory() {
    [[ -d "$1" && -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" ]]
}

check_origin() {
    local directory="$1" expected="$2" origin normalized
    origin="$(git -C "$directory" config --local --get remote.origin.url)" || fail "No origin remote in ${directory}. Choose a dedicated annotation directory or restore its expected origin."
    normalized="$(printf '%s' "$origin" | tr '[:upper:]' '[:lower:]')"
    normalized="${normalized%/}"
    normalized="${normalized%.git}"
    case "$normalized" in
        "https://github.com/${expected}"|"git@github.com:${expected}"|"ssh://git@github.com/${expected}"|"ssh://git@github.com:22/${expected}") ;;
        *) fail "Unexpected origin in ${directory}. Expected GitHub repository ${expected}; choose a different data directory." ;;
    esac
}

check_checkout() {
    local directory="$1" expected="$2" top
    [[ -e "${directory}/.git" && ! -L "${directory}/.git" ]] || fail "Nonempty annotation directory is not an expected checkout: ${directory}. Choose a dedicated empty data directory."
    top="$(git -C "$directory" rev-parse --show-toplevel)" || fail "Cannot read Git checkout at ${directory}. Choose a valid annotation checkout or an empty data directory."
    [[ "$top" -ef "$directory" ]] || fail "Annotation directory is inside another checkout: ${directory}. Choose a dedicated data directory."
    check_origin "$directory" "$expected"
}

preflight() {
    local home_directory root entry worktree branch current_branch bare
    ANNOTATIONS_DIR="$(normalize_destination "$ANNOTATIONS_DIR")"
    FRAMEXML_DIR="$(normalize_destination "$FRAMEXML_DIR")"
    BARE_DIR="${FRAMEXML_DIR}/.bare"
    home_directory="$(cd -P "$HOME" && pwd -P)"
    for root in "$ANNOTATIONS_DIR" "$FRAMEXML_DIR"; do
        if within_directory "$home_directory" "$root"; then
            fail "Choose a dedicated annotation directory, not a filesystem root, home directory, or their ancestor: ${root}."
        fi
        if within_directory "$root" "$SCRIPT_DIR" || within_directory "$SCRIPT_DIR" "$root"; then
            fail "Annotation data root overlaps the source checkout: ${root}. Choose a dedicated directory outside this repository."
        fi
        [[ ! -e "$root" || -d "$root" ]] || fail "Annotation data root is not a directory: ${root}. Choose a dedicated directory."
    done
    if within_directory "$ANNOTATIONS_DIR" "$FRAMEXML_DIR" || within_directory "$FRAMEXML_DIR" "$ANNOTATIONS_DIR"; then
        fail 'The annotation and FrameXML data roots overlap. Choose separate directories.'
    fi
    if [[ -d "$ANNOTATIONS_DIR" ]] && ! empty_directory "$ANNOTATIONS_DIR"; then
        check_checkout "$ANNOTATIONS_DIR" 'ketho/vscode-wow-api'
    fi
    if [[ -d "$FRAMEXML_DIR" ]]; then
        for entry in "$FRAMEXML_DIR"/* "$FRAMEXML_DIR"/.[!.]* "$FRAMEXML_DIR"/..?*; do
            [[ -e "$entry" || -L "$entry" ]] || continue
            [[ ! -L "$entry" ]] || fail "FrameXML data contains a symbolic link: ${entry}. Use a dedicated annotation directory."
            case "${entry##*/}" in
                .bare|live|classic|classic_era|classic_anniversary|.DS_Store|Thumbs.db|desktop.ini) ;;
                *) fail "FrameXML data root contains unrelated files: ${entry}. Choose a dedicated empty directory or an existing FrameXML installation." ;;
            esac
        done
    fi
    if [[ -e "$BARE_DIR" ]] && ! empty_directory "$BARE_DIR"; then
        bare="$(git -C "$BARE_DIR" rev-parse --is-bare-repository)" || fail "Cannot read FrameXML bare repository at ${BARE_DIR}. Choose an empty FrameXML data directory."
        [[ "$bare" = true ]] || fail "FrameXML .bare path is not a bare Git repository: ${BARE_DIR}. Choose a dedicated FrameXML data directory."
        check_origin "$BARE_DIR" 'numyaddon/framexmlannotations'
    fi
    for flavor in "${ACTIVE_FLAVORS[@]}"; do
        worktree="${FRAMEXML_DIR}/${flavor}"
        [[ -e "$worktree" ]] || continue
        empty_directory "$worktree" && continue
        check_checkout "$worktree" 'numyaddon/framexmlannotations'
        branch="$(branch_for_flavor "$flavor")"
        current_branch="$(git -C "$worktree" branch --show-current)" || fail "Cannot read the branch at ${worktree}. Restore the expected annotation worktree."
        [[ "$current_branch" = "$branch" ]] || fail "Worktree ${worktree} is on '${current_branch}', expected '${branch}'. Select the expected branch before updating annotations."
    done
}

ensure_ketho_repo() {
    printf '%s\n' ""
    printf '%s\n' "${DIM}-- Ketho annotations (shared Core/) --${RESET}"

    if [[ -e "${ANNOTATIONS_DIR}/.git" ]]; then
        printf '%s\n' "${DIM}  Updating existing checkout...${RESET}"
        git -C "${ANNOTATIONS_DIR}" pull --ff-only origin
        git -C "${ANNOTATIONS_DIR}" submodule update --init --recursive
        printf '%s\n' "${GREEN}✓${RESET} Updated Ketho annotations"
        UPDATED=$((UPDATED + 1))
    else
        printf '%s\n' "${DIM}  Cloning fresh...${RESET}"
        git clone "${KETHO_REPO}" "${ANNOTATIONS_DIR}"
        git -C "${ANNOTATIONS_DIR}" submodule update --init --recursive
        printf '%s\n' "${GREEN}✓${RESET} Cloned Ketho annotations"
        CLONED=$((CLONED + 1))
    fi
}

ensure_bare_repo() {
    if [[ -d "${BARE_DIR}" ]] && ! empty_directory "$BARE_DIR"; then
        printf '%s\n' "${DIM}  Fetching FrameXML updates...${RESET}"
        git -C "${BARE_DIR}" fetch origin --prune
        printf '%s\n' "${GREEN}✓${RESET} Fetched FrameXML bare repo"
        UPDATED=$((UPDATED + 1))
    else
        printf '%s\n' "${DIM}  Cloning FrameXML bare repo...${RESET}"
        mkdir -p "${FRAMEXML_DIR}"
        git clone --bare "${FRAMEXML_REPO}" "${BARE_DIR}"
        printf '%s\n' "${GREEN}✓${RESET} Cloned FrameXML bare repo"
        CLONED=$((CLONED + 1))
    fi
}

ensure_worktree() {
    local flavor="$1"
    local branch
    branch="$(branch_for_flavor "$flavor")"
    local worktree_dir="${FRAMEXML_DIR}/${flavor}"

    printf '%s\n' "${DIM}-- FrameXML: ${flavor} --${RESET}"

    if [[ -e "${worktree_dir}/.git" ]]; then
        printf '%s\n' "${DIM}  Updating ${flavor} worktree...${RESET}"
        local current_branch
        current_branch="$(git -C "${worktree_dir}" branch --show-current)"
        if [[ "${current_branch}" != "${branch}" ]]; then
            printf '%s\n' "${RED}✗${RESET} Worktree ${flavor} is on '${current_branch}', expected '${branch}'" >&2
            exit 1
        fi
        git -C "${worktree_dir}" pull --ff-only origin "${branch}"
        printf '%s\n' "${GREEN}✓${RESET} Updated ${flavor} (${branch})"
        UPDATED=$((UPDATED + 1))
    else
        printf '%s\n' "${DIM}  Creating ${flavor} worktree...${RESET}"
        git -C "${BARE_DIR}" worktree add "${worktree_dir}" "${branch}"
        printf '%s\n' "${GREEN}✓${RESET} Created ${flavor} worktree (${branch})"
        CLONED=$((CLONED + 1))
    fi
}

# -- Main -------------------------------------------------------------------

preflight
if [[ "$CHECK_ONLY" = true ]]; then exit 0; fi

printf '%s\n' "Maintaining WoW annotation repositories..."

ensure_ketho_repo

# Bare repo - once
printf '%s\n' ""
ensure_bare_repo

# Worktrees - per flavor
for flavor in "${ACTIVE_FLAVORS[@]}"; do
    printf '%s\n' ""
    ensure_worktree "${flavor}"
done

# -- Summary ----------------------------------------------------------------

printf '%s\n' ""
printf '%s\n' "Done! ${CLONED} cloned, ${UPDATED} updated."
