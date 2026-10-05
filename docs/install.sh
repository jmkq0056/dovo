#!/usr/bin/env bash
# Dovo installer for macOS (Apple Silicon).
#
#   curl -fsSL https://jmkq0056.github.io/dovo/install.sh | bash
#
# Downloads the latest release, replaces any installed copy (the old one goes to the Trash),
# clears the quarantine flag so it opens without the "damaged" / right-click-to-open dance,
# offers to install Claude Code if it's missing, and opens Dovo. Running it again updates.
# Coming from Maut code (Dovo's old name): your settings and extensions move over and the old
# app goes to the Trash.
set -euo pipefail

REPO="jmkq0056/dovo"
ASSET="Dovo-arm64.dmg"
NAME="Dovo"
DEST="${DOVO_INSTALL_DIR:-/Applications}/$NAME.app"

step() { printf '  > %s\n' "$*"; }
fail() { printf '  ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this installer is for macOS; on Windows run: irm https://jmkq0056.github.io/dovo/install.ps1 | iex"
[ "$(uname -m)" = arm64 ] || fail "Dovo is built for Apple Silicon; Intel builds aren't published yet"

printf '\n  Dovo\n\n'

step "Finding the latest release"
RELEASE=$(curl -fsSL -H 'User-Agent: dovo-installer' "https://api.github.com/repos/$REPO/releases/latest")
TAG=$(printf '%s' "$RELEASE" | /usr/bin/python3 -c 'import json, sys; print(json.load(sys.stdin)["tag_name"])')
URL=$(printf '%s' "$RELEASE" | /usr/bin/python3 -c "import json, sys; print(next((a['browser_download_url'] for a in json.load(sys.stdin)['assets'] if a['name'] == '$ASSET'), ''))")
[ -n "$URL" ] || fail "release $TAG has no $ASSET; see https://github.com/$REPO/releases"

WORK=$(mktemp -d)
MOUNT="$WORK/mount"
cleanup() {
	hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup EXIT

step "Downloading $TAG"
curl -fL --progress-bar -o "$WORK/$ASSET" "$URL"

step "Installing to $(dirname "$DEST")"
mkdir -p "$MOUNT"
hdiutil attach "$WORK/$ASSET" -nobrowse -readonly -mountpoint "$MOUNT" -quiet
[ -d "$MOUNT/$NAME.app" ] || fail "the download doesn't contain $NAME.app"

to_trash() {
	osascript -e "tell application \"Finder\" to delete POSIX file \"$1\"" >/dev/null 2>&1 || rm -rf "$1"
}
quit_app() {
	if ps -axo command= | grep -q "^$1/Contents/MacOS/"; then
		step "Quitting the running $2"
		osascript -e "quit app \"$2\"" >/dev/null 2>&1 || true
		sleep 2
	fi
}

quit_app "$DEST" "$NAME"
[ -d "$DEST" ] && to_trash "$DEST"
ditto "$MOUNT/$NAME.app" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true

# Coming from Maut code: bring your settings, state and extensions along, then retire it.
OLD_APP="/Applications/Maut code.app"
OLD_DATA="$HOME/Library/Application Support/Maut code"
NEW_DATA="$HOME/Library/Application Support/Dovo"
if [ -d "$OLD_DATA" ] && [ ! -d "$NEW_DATA" ]; then
	step "Moving your Maut code settings to Dovo"
	ditto "$OLD_DATA" "$NEW_DATA"
fi
if [ -d "$HOME/.maut-code" ] && [ ! -d "$HOME/.dovo" ]; then
	ditto "$HOME/.maut-code" "$HOME/.dovo"
	[ -f "$HOME/.dovo/extensions/extensions.json" ] && sed -i '' 's#/\.maut-code/#/.dovo/#g' "$HOME/.dovo/extensions/extensions.json"
fi
if [ -d "$OLD_APP" ]; then
	quit_app "$OLD_APP" "Maut code"
	step "Moving Maut code (Dovo's old name) to the Trash"
	to_trash "$OLD_APP"
fi

# Dovo opens Claude Code in its terminal on launch, so make sure it's there.
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
	printf '  Claude Code is not installed. Install it now? [Y/n] '
	read -r answer < /dev/tty || answer=y
	case "$answer" in
		[nN]*) ;;
		*) step "Installing Claude Code"; curl -fsSL https://claude.ai/install.sh | bash ;;
	esac
fi

if [ -z "${DOVO_NO_OPEN:-}" ]; then
	step "Opening $NAME"
	open "$DEST"
fi

printf '\n  %s %s is installed in %s.\n\n' "$NAME" "$TAG" "$(dirname "$DEST")"
