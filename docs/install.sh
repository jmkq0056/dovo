#!/usr/bin/env bash
# Maut code installer for macOS (Apple Silicon).
#
#   curl -fsSL https://jmkq0056.github.io/maut-code/install.sh | bash
#
# Downloads the latest release, replaces any installed copy (the old one goes to the Trash),
# clears the quarantine flag so it opens without the "damaged" / right-click-to-open dance,
# offers to install Claude Code if it's missing, and opens Maut code. Running it again updates.
set -euo pipefail

REPO="jmkq0056/maut-code"
ASSET="Maut-code-arm64.dmg"
NAME="Maut code"
DEST="${MAUT_INSTALL_DIR:-/Applications}/$NAME.app"

step() { printf '  > %s\n' "$*"; }
fail() { printf '  ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this installer is for macOS; on Windows run: irm https://jmkq0056.github.io/maut-code/install.ps1 | iex"
[ "$(uname -m)" = arm64 ] || fail "Maut code is built for Apple Silicon; Intel builds aren't published yet"

printf '\n  Maut code\n\n'

step "Finding the latest release"
RELEASE=$(curl -fsSL -H 'User-Agent: maut-installer' "https://api.github.com/repos/$REPO/releases/latest")
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

if ps -axo command= | grep -q "^$DEST/Contents/MacOS/"; then
	step "Quitting the running $NAME"
	osascript -e "quit app \"$NAME\"" >/dev/null 2>&1 || true
	sleep 2
fi
if [ -d "$DEST" ]; then
	osascript -e "tell application \"Finder\" to delete POSIX file \"$DEST\"" >/dev/null 2>&1 \
		|| rm -rf "$DEST"
fi
ditto "$MOUNT/$NAME.app" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true

# Maut opens Claude Code in its terminal on launch, so make sure it's there.
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
	printf '  Claude Code is not installed. Install it now? [Y/n] '
	read -r answer < /dev/tty || answer=y
	case "$answer" in
		[nN]*) ;;
		*) step "Installing Claude Code"; curl -fsSL https://claude.ai/install.sh | bash ;;
	esac
fi

if [ -z "${MAUT_NO_OPEN:-}" ]; then
	step "Opening $NAME"
	open "$DEST"
fi

printf '\n  %s %s is installed in %s.\n\n' "$NAME" "$TAG" "$(dirname "$DEST")"
