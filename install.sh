#!/usr/bin/env bash
set -euo pipefail

show_help() {
    cat <<'HELP'
Usage: ./install.sh [--interactive | --non-interactive] [--mcp] [--skills-dir DIR] [--force] [--annotations]

Install the portable wow-addon skill to ~/.agents/skills/wow-addon.
With no arguments in a terminal, choose the skill and MCP setup interactively.
Example: ./install.sh --mcp > wow-addon-mcp.json
  --interactive     Ask setup questions, including when input is piped
  --non-interactive Use flags without asking questions
  --mcp             Prepare only the MCP server and print its finished JSON
  --skills-dir DIR  Absolute path to the parent skills directory
  --force           Replace the existing wow-addon directory
  --annotations     Clone or update optional local annotation repositories
  --help, -h        Show this help

MCP setup installs missing locked Bun dependencies and builds the local server.
Copy the printed JSON into your MCP client settings. Client settings are never edited.
HELP
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

FORCE=false
ANNOTATIONS=false
MCP=false
INSTALL_SKILL=true
INTERACTIVE=auto
ARGUMENT_COUNT="$#"
SKILLS_DIR="${HOME:?HOME must be set}/.agents/skills"
ANNOTATIONS_ROOT="${WOW_ANNOTATIONS_ROOT:-${HOME}/.local/share/wow-annotations}"
FRAMEXML_ROOT="${WOW_FRAMEXML_ROOT:-${HOME}/.local/share/wow-framexml}"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h) show_help; exit 0 ;;
        --force) FORCE=true; shift ;;
        --annotations) ANNOTATIONS=true; shift ;;
        --mcp) MCP=true; INSTALL_SKILL=false; shift ;;
        --interactive)
            [ "$INTERACTIVE" != false ] || fail 'Choose either --interactive or --non-interactive.'
            INTERACTIVE=true; shift ;;
        --non-interactive)
            [ "$INTERACTIVE" != true ] || fail 'Choose either --interactive or --non-interactive.'
            INTERACTIVE=false; shift ;;
        --skills-dir)
            [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--skills-dir requires an absolute directory path.'
            SKILLS_DIR="$2"; shift 2 ;;
        *) fail "Unknown option: $1. Run ./install.sh --help." ;;
    esac
done

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
if [ "$INTERACTIVE" = auto ]; then
    INTERACTIVE=false
    if [ "$ARGUMENT_COUNT" -eq 0 ] && [ -t 0 ]; then INTERACTIVE=true; fi
fi

ask_yes_no() {
    local question="$1" default="$2" suffix='[y/N]'
    if [ "$default" = true ]; then suffix='[Y/n]'; fi
    while :; do
        printf '%s %s: ' "$question" "$suffix" >&2
        IFS= read -r ANSWER || fail 'Input ended before setup was confirmed. Run again and answer every prompt.'
        case "$ANSWER" in
            '') ANSWER="$default"; return ;;
            y|Y|yes|YES|Yes) ANSWER=true; return ;;
            n|N|no|NO|No) ANSWER=false; return ;;
            *) printf 'Enter yes or no.\n' >&2 ;;
        esac
    done
}

ask_path() {
    printf '%s [%s]: ' "$1" "$2" >&2
    IFS= read -r ANSWER || fail 'Input ended before setup was confirmed. Run again and answer every prompt.'
    ANSWER="${ANSWER:-$2}"
}

# Refuse aliases before any writes. Deletion is limited to the named skill.
validate_skill_destination() {
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
    [ ! -L "$TARGET" ] || fail "Refusing to replace a symbolic link: ${TARGET}. Remove the link yourself first."
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
        fail 'The install destination overlaps the source skill or repository. Choose a different skills directory.'
    fi
    if [ -e "$TARGET" ]; then
        [ -d "$TARGET" ] || fail "The skill destination is not a directory: ${TARGET}. Move it yourself first."
    fi
}

if [ "$INTERACTIVE" = true ]; then
    ask_yes_no 'Install the wow-addon skill?' true
    INSTALL_SKILL="$ANSWER"
    if [ "$INSTALL_SKILL" = true ]; then
        ask_path 'Parent skills directory (absolute path)' "$SKILLS_DIR"
        SKILLS_DIR="$ANSWER"
        validate_skill_destination
        if [ -e "$TARGET" ]; then
            ask_yes_no "Replace the existing skill at ${TARGET}?" false
            if [ "$ANSWER" = true ]; then FORCE=true; else INSTALL_SKILL=false; fi
        fi
    fi
    ask_yes_no 'Prepare the MCP server? This installs missing locked Bun dependencies, builds the server, and prints JSON.' true
    MCP="$ANSWER"
    if [ "$MCP" = true ]; then
        ask_path 'Annotation root' "$ANNOTATIONS_ROOT"
        ANNOTATIONS_ROOT="$ANSWER"
        ask_path 'FrameXML root' "$FRAMEXML_ROOT"
        FRAMEXML_ROOT="$ANSWER"
    fi
    ask_yes_no 'Clone or update the optional local annotation repositories?' "$ANNOTATIONS"
    ANNOTATIONS="$ANSWER"
fi

# Keep the original stdout for JSON; build and maintenance tools use stderr.
exec 3>&1
if [ "$MCP" = true ]; then exec 1>&2; fi

if [ "$INSTALL_SKILL" = true ]; then
    SOURCE="${SCRIPT_DIR}/skills/wow-addon"
    [ -f "${SOURCE}/SKILL.md" ] || fail "Missing source skill: ${SOURCE}/SKILL.md. Use a complete repository checkout."
    [ -z "$(find "$SOURCE" -type l -print -quit)" ] || fail "Source skill contains symbolic links: ${SOURCE}. Use regular files."
    validate_skill_destination
fi

if [ "$MCP" = true ]; then
    BUN_COMMAND="$(command -v bun)" || fail 'Bun is missing. Install Bun 1.3.12 or newer, then run the installer again.'
    [ -f "${SCRIPT_DIR}/scripts/mcp-config.mjs" ] || fail 'Missing scripts/mcp-config.mjs. Use a complete repository checkout.'
    "$BUN_COMMAND" "${SCRIPT_DIR}/scripts/mcp-config.mjs" --check-runtime || fail 'Bun 1.3.12 or newer is required. Select a supported Bun on PATH and run again.'
    ANNOTATIONS_ROOT="$(WOW_ANNOTATIONS_ROOT="$ANNOTATIONS_ROOT" "$BUN_COMMAND" "${SCRIPT_DIR}/scripts/mcp-config.mjs" --annotations-root)" || fail 'The annotation root is invalid. Choose a valid directory path and run again.'
    FRAMEXML_ROOT="$(WOW_FRAMEXML_ROOT="$FRAMEXML_ROOT" "$BUN_COMMAND" "${SCRIPT_DIR}/scripts/mcp-config.mjs" --framexml-root)" || fail 'The FrameXML root is invalid. Choose a valid directory path and run again.'
    WOW_ANNOTATIONS_ROOT="$ANNOTATIONS_ROOT" WOW_FRAMEXML_ROOT="$FRAMEXML_ROOT" "$BUN_COMMAND" "${SCRIPT_DIR}/scripts/mcp-config.mjs" --check-prerequisites || fail 'MCP prerequisites are missing. Resolve the error above, then run the installer again.'
fi

if [ "$ANNOTATIONS" = true ]; then
    WOW_ANNOTATIONS_ROOT="$ANNOTATIONS_ROOT" WOW_FRAMEXML_ROOT="$FRAMEXML_ROOT" bash "${SCRIPT_DIR}/maintain-annotations.sh" --check || fail 'Annotation destination check failed. Resolve the error above, then run the installer again.'
fi

if [ "$MCP" = true ]; then
    if [ ! -f "${SCRIPT_DIR}/node_modules/@modelcontextprotocol/server/package.json" ] ||
        { [ ! -f "${SCRIPT_DIR}/node_modules/.bin/tsc" ] && [ ! -f "${SCRIPT_DIR}/node_modules/.bin/tsc.cmd" ]; }; then
        printf 'Installing locked Bun dependencies in %s\n' "$SCRIPT_DIR"
        (cd "$SCRIPT_DIR" && "$BUN_COMMAND" ci) || fail 'Dependency installation failed. Resolve the bun ci error above, then run the installer again.'
    fi
    printf 'Building the MCP server in %s\n' "$SCRIPT_DIR"
    (cd "$SCRIPT_DIR" && "$BUN_COMMAND" run build) || fail 'MCP build failed. Resolve the build error above, then run the installer again.'
fi

if [ "$INSTALL_SKILL" = true ]; then
    if [ -e "$TARGET" ] && [ "$FORCE" = false ]; then
        printf 'Skipped %s (already exists; use --force to replace).\n' "$TARGET"
    else
        mkdir -p "$SKILLS_DIR"
        STAGING="$(mktemp -d "${SKILLS_DIR}/.wow-addon-install.XXXXXX")"
        cleanup() {
            if [ -d "${STAGING}/previous" ] && [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
                mv "${STAGING}/previous" "$TARGET" || return
            fi
            rm -rf "$STAGING"
        }
        trap cleanup EXIT
        cp -R "$SOURCE" "${STAGING}/new"
        if [ -d "$TARGET" ]; then
            mv "$TARGET" "${STAGING}/previous"
        fi
        mv "${STAGING}/new" "$TARGET"
        printf 'Installed %s\n' "$TARGET"
    fi
fi

if [ "$ANNOTATIONS" = true ]; then
    WOW_ANNOTATIONS_ROOT="$ANNOTATIONS_ROOT" WOW_FRAMEXML_ROOT="$FRAMEXML_ROOT" bash "${SCRIPT_DIR}/maintain-annotations.sh" || fail 'Annotation maintenance failed. Resolve the error above, then run the installer again.'
fi
if [ "$MCP" = true ]; then
    MCP_JSON="$(WOW_ANNOTATIONS_ROOT="$ANNOTATIONS_ROOT" WOW_FRAMEXML_ROOT="$FRAMEXML_ROOT" "$BUN_COMMAND" "${SCRIPT_DIR}/scripts/mcp-config.mjs")" || fail 'MCP JSON could not be created. Resolve the error above, then run the installer again.'
    printf 'Copy the JSON from stdout into your MCP client settings.\n' >&2
    printf '%s\n' "$MCP_JSON" >&3
elif [ "$INSTALL_SKILL" = true ]; then
    printf 'Next: configure the local MCP server using README.md.\n'
else
    printf 'Setup finished. No MCP configuration was requested.\n'
fi
