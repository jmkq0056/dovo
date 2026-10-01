#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Release Maut code to THIS Mac: build, quit every running copy, move the
# installed app to the Trash (recoverable, never rm), install the fresh build
# into /Applications, and open it. Modelled on closer/scripts/release-macos.sh.
#
#   ./scripts/release-macos.sh             # build, swap, launch
#   ./scripts/release-macos.sh --no-build  # swap in the existing build
#   ./scripts/release-macos.sh --detach    # build here, then hand the swap to
#                                          # launchd (use this from a Maut
#                                          # terminal: quitting Maut kills it)
#
# Fails loudly at the first step that fails; never installs a build that did
# not finish. Only one Maut code stays registered with macOS: the build output
# is deregistered from Launch Services, and stale copies go to the Trash.
# -----------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

BUILD=1; DETACH=0
for arg in "$@"; do
	case "$arg" in
		--no-build) BUILD=0 ;;
		--detach)   DETACH=1 ;;
		*) echo "unknown arg: $arg (use: [--no-build] [--detach])"; exit 1 ;;
	esac
done

# pgrep can miss app processes on macOS; match the executable path through ps instead.
app_pids() { ps -axo pid=,command= | awk -v exe="$1" 'index($0, exe) && $2 != "awk" { print $1 }'; }

log()  { echo "[maut $(date +%H:%M:%S)] $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

NAME="Maut code"
APP="$(cd .. && pwd)/VSCode-darwin-arm64/$NAME.app"
DEST="/Applications/$NAME.app"
STALE=("$HOME/Applications/$NAME.app" "$HOME/Developer/VSCode-darwin-arm64/$NAME.app")
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
LOG=/tmp/maut-release-build.log

# -- build --------------------------------------------------------------------
if [ "$BUILD" = 1 ]; then
	export NVM_DIR="$HOME/.nvm"
	NODE_VERSION=$(cat .nvmrc)
	[ -x "$NVM_DIR/versions/node/v$NODE_VERSION/bin/node" ] || fail "node $NODE_VERSION missing (nvm install $NODE_VERSION)"
	export PATH="$NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH"
	[ -d node_modules ] || fail "no node_modules (run: VSCODE_INSTALL_CONCURRENCY=1 npm ci)"
	pgrep -f "gulp vscode-darwin" >/dev/null && fail "another Maut build is running"

	log "building $NAME (node $NODE_VERSION)..."
	npm run gulp vscode-darwin-arm64 > "$LOG" 2>&1 \
		|| { grep -E "error|Error|ERR!" "$LOG" | head -20; fail "build failed - nothing installed (full log: $LOG)"; }
fi
[ -d "$APP" ] || fail "no build at $APP"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || fail "ad-hoc signing failed"
# The build output is a second copy of the app; keep it out of Spotlight/Launchpad.
"$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
BUILT=$(plutil -extract commit raw "$APP/Contents/Resources/app/product.json" 2>/dev/null || echo unknown)
log "built commit ${BUILT:0:10}"

# -- swap ---------------------------------------------------------------------
swap() {
	log "quitting ${NAME}..."
	osascript -e "quit app \"$NAME\"" >/dev/null 2>&1 || true
	for _ in $(seq 1 20); do
		[ -n "$(app_pids "$NAME.app/Contents/MacOS/")" ] || break
		sleep 0.5
	done
	app_pids "$NAME.app/Contents/MacOS/" | xargs kill -9 2>/dev/null || true
	sleep 1
	[ -n "$(app_pids "$NAME.app/Contents/MacOS/")" ] && fail "$NAME is still running"

	for old in "$DEST" "${STALE[@]}"; do
		[ -d "$old" ] || continue
		if osascript -e "tell application \"Finder\" to delete POSIX file \"$old\"" >/dev/null 2>&1; then
			log "moved $old to the Trash"
		else
			rm -rf "$old"; log "removed $old (Trash refused it)"
		fi
		"$LSREGISTER" -u "$old" >/dev/null 2>&1 || true
	done

	ditto "$APP" "$DEST"
	xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
	codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || fail "signing the installed copy failed"
	"$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true
	"$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
	INSTALLED=$(plutil -extract commit raw "$DEST/Contents/Resources/app/product.json" 2>/dev/null || echo unknown)
	[ "$INSTALLED" = "$BUILT" ] || fail "installed copy is not the build just made"

	# -- launch ---------------------------------------------------------------
	# Launch with a clean environment, as if from the Dock. Otherwise Maut inherits whatever ran
	# this script (e.g. a Claude session's CLAUDE_CODE_CHILD_SESSION marker, which turns off
	# transcript saving for every Claude started in Maut's terminals).
	/usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL="${SHELL:-/bin/zsh}" \
		PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 TMPDIR="${TMPDIR:-/tmp}" \
		/usr/bin/open -a "$DEST"
	sleep 3
	[ -n "$(app_pids "$DEST/Contents/MacOS/")" ] || fail "installed but did not launch"

	echo
	echo "-------------------------------------------------------------"
	echo "  $NAME (${BUILT:0:10}) is installed in /Applications and running"
	echo "  previous copy: in the Trash"
	echo "-------------------------------------------------------------"
}

if [ "$DETACH" = 1 ]; then
	# Run the swap in its own session, outside this terminal's process tree, so quitting
	# Maut (which hangs up its terminals) can't kill it halfway.
	SWAP_LOG=/tmp/maut-release-swap.log
	nohup python3 -c 'import os, sys
if os.fork():
	sys.exit(0)
os.setsid()
os.execv("/bin/bash", ["bash", sys.argv[1], "--no-build"])' "$ROOT/scripts/release-macos.sh" > "$SWAP_LOG" 2>&1 < /dev/null &
	log "swap started in the background; Maut will quit and relaunch (log: $SWAP_LOG)"
	exit 0
fi

swap
