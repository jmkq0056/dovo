/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dovo's Firefox tab: the workbench shows a "Firefox" editor tab and asks us to place the user's
// real Firefox window exactly over it. Gecko can't run inside Electron, so Dovo positions the real
// app's window through System Events (macOS only; needs Dovo in Accessibility).

import { execFile, spawn } from 'child_process';
import * as vscode from 'vscode';

/** A rectangle in screen points. */
interface IRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** One of the browser's windows, as System Events reports it (index = front-to-back order). */
interface IBrowserWindow {
	readonly index: number;
	readonly title: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly docked: boolean;
}

type Status = 'ok' | 'unsupported' | 'missing' | 'notRunning' | 'noWindow' | 'permission' | 'error';

interface IDockResult {
	readonly status: Status;
	readonly title?: string;
	readonly windows?: IBrowserWindow[];
}

// The browser's process is found by bundle id, so "Firefox", "Firefox Developer Edition",
// "LibreWolf" or "Zen" all work. Every script takes its values as arguments (never interpolated).
const processPrelude = `
	set bid to id of application (item 1 of argv)
	tell application "System Events"
		if not (exists (first application process whose bundle identifier is bid)) then return "notRunning"
		set p to first application process whose bundle identifier is bid
`;

const listScript = `on run argv
	${processPrelude}
		set out to ""
		set i to 0
		repeat with w in (every window of p)
			set i to i + 1
			try
				set {x, y} to position of w
				set {ww, hh} to size of w
				set out to out & i & tab & x & tab & y & tab & ww & tab & hh & tab & (name of w) & linefeed
			end try
		end repeat
		return out
	end tell
end run`;

const placeScript = `on run argv
	${processPrelude}
		set w to window (item 2 of argv as integer) of p
		set position of w to {item 3 of argv as integer, item 4 of argv as integer}
		set size of w to {item 5 of argv as integer, item 6 of argv as integer}
		perform action "AXRaise" of w
		return "ok" & tab & (name of w)
	end tell
end run`;

const raiseScript = `on run argv
	${processPrelude}
		perform action "AXRaise" of window (item 2 of argv as integer) of p
		if (item 3 of argv) is "focus" then set frontmost of p to true
		return "ok"
	end tell
end run`;

const newTabScript = `on run argv
	${processPrelude}
		set frontmost of p to true
		perform action "AXRaise" of window (item 2 of argv as integer) of p
		keystroke "t" using command down
		return "ok"
	end tell
end run`;

/** The rectangle Dovo last placed a window at: that window is the docked one. */
let lastPlaced: IRect | undefined;

function osascript(script: string, args: string[]): Promise<{ status: Status; out: string }> {
	return new Promise(resolve => {
		execFile('/usr/bin/osascript', ['-e', script, ...args], { timeout: 4000 }, (error, stdout, stderr) => {
			const out = String(stdout ?? '').trim();
			if (!error) {
				resolve({ status: out === 'notRunning' ? 'notRunning' : 'ok', out });
				return;
			}
			const text = `${stderr ?? ''} ${error.message}`;
			// -1719 / -25211: Dovo isn't allowed to control other apps' windows yet.
			if (/-1719|-25211|assistive|not allowed|Accessibility/i.test(text)) {
				resolve({ status: 'permission', out: '' });
			} else if (/-1728|Can.t get application|-10814/i.test(text)) {
				resolve({ status: 'missing', out: '' });
			} else {
				resolve({ status: 'error', out: text });
			}
		});
	});
}

function near(a: number, b: number): boolean {
	return Math.abs(a - b) <= 3;
}

async function listWindows(app: string): Promise<IDockResult> {
	if (process.platform !== 'darwin') {
		return { status: 'unsupported' };
	}
	// Check with open -R first: AppleScript asks "Where is <app>?" in a dialog for a missing app.
	if (!await installed(app)) {
		return { status: 'missing' };
	}
	const { status, out } = await osascript(listScript, [app]);
	if (status !== 'ok') {
		return { status };
	}
	const windows: IBrowserWindow[] = [];
	for (const line of out.split('\n')) {
		const [index, x, y, width, height, ...title] = line.split('\t');
		if (!index || !width) {
			continue;
		}
		const rect = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
		// Tiny windows are popups and menus, not browser windows.
		if (rect.width < 120 || rect.height < 80) {
			continue;
		}
		const docked = !!lastPlaced && near(rect.x, lastPlaced.x) && near(rect.y, lastPlaced.y) && near(rect.width, lastPlaced.width) && near(rect.height, lastPlaced.height);
		windows.push({ index: Number(index), title: title.join('\t'), ...rect, docked });
	}
	return { status: 'ok', windows };
}

function launch(app: string, url?: string): Promise<boolean> {
	return new Promise(resolve => {
		const child = spawn('/usr/bin/open', ['-a', app, ...(url ? [url] : [])], { stdio: 'ignore' });
		child.on('error', () => resolve(false));
		child.on('exit', code => resolve(code === 0));
	});
}

/** Which window to dock: the one picked, else the one docked before, else the front one. */
function chooseWindow(windows: IBrowserWindow[], pick: { title?: string; x?: number; y?: number } | undefined): IBrowserWindow | undefined {
	if (pick) {
		const { x, y } = pick;
		return windows.find(w => w.title === pick.title && (x === undefined || y === undefined || (near(w.x, x) && near(w.y, y))))
			?? windows.find(w => w.title === pick.title);
	}
	return windows.find(w => w.docked) ?? windows[0];
}

async function dock(app: string, rect: IRect, pick?: { title?: string; x?: number; y?: number }): Promise<IDockResult> {
	if (process.platform !== 'darwin') {
		return { status: 'unsupported' };
	}
	let listed = await listWindows(app);
	if (listed.status === 'notRunning' || (listed.status === 'ok' && !listed.windows?.length)) {
		if (!await launch(app)) {
			return { status: 'missing' };
		}
		for (let attempt = 0; attempt < 25; attempt++) {
			await new Promise(r => setTimeout(r, 200));
			listed = await listWindows(app);
			if (listed.status === 'ok' && listed.windows?.length) {
				break;
			}
		}
	}
	if (listed.status !== 'ok') {
		return { status: listed.status };
	}
	const target = chooseWindow(listed.windows ?? [], pick);
	if (!target) {
		return { status: 'noWindow', windows: listed.windows };
	}
	const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(200, Math.round(rect.width)), height: Math.max(120, Math.round(rect.height)) };
	const placed = await osascript(placeScript, [app, String(target.index), String(r.x), String(r.y), String(r.width), String(r.height)]);
	if (placed.status !== 'ok') {
		return { status: placed.status };
	}
	lastPlaced = r;
	return { status: 'ok', title: placed.out.split('\t').slice(1).join('\t'), windows: listed.windows };
}

async function raise(app: string, focus: boolean): Promise<IDockResult> {
	const listed = await listWindows(app);
	const target = listed.windows?.find(w => w.docked);
	if (listed.status !== 'ok' || !target) {
		return { status: listed.status === 'ok' ? 'noWindow' : listed.status };
	}
	const raised = await osascript(raiseScript, [app, String(target.index), focus ? 'focus' : 'raise']);
	return { status: raised.status, title: target.title };
}

async function newTab(app: string): Promise<IDockResult> {
	const listed = await listWindows(app);
	const target = listed.windows?.find(w => w.docked) ?? listed.windows?.[0];
	if (listed.status !== 'ok' || !target) {
		return { status: listed.status === 'ok' ? 'noWindow' : listed.status };
	}
	return { status: (await osascript(newTabScript, [app, String(target.index)])).status };
}

/** Apps known to be installed; a missing one is checked again next time (it may get installed). */
const knownInstalled = new Set<string>();

async function installed(app: string): Promise<boolean> {
	if (process.platform !== 'darwin') {
		return false;
	}
	if (knownInstalled.has(app)) {
		return true;
	}
	const found = await new Promise<boolean>(resolve => {
		execFile('/usr/bin/open', ['-Ra', app], { timeout: 4000 }, error => resolve(!error));
	});
	if (found) {
		knownInstalled.add(app);
	}
	return found;
}

/** Internal commands the workbench's Firefox tab calls. */
export function registerBrowserDock(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('_dovo.browser.installed', (app: string) => installed(app)),
		vscode.commands.registerCommand('_dovo.browser.windows', (app: string) => listWindows(app)),
		vscode.commands.registerCommand('_dovo.browser.dock', (app: string, rect: IRect, pick?: { title?: string; x?: number; y?: number }) => dock(app, rect, pick)),
		vscode.commands.registerCommand('_dovo.browser.raise', (app: string, focus?: boolean) => raise(app, !!focus)),
		vscode.commands.registerCommand('_dovo.browser.newTab', (app: string) => newTab(app)),
		vscode.commands.registerCommand('_dovo.browser.openUrl', async (app: string, url: string) => {
			if (!/^https?:\/\//i.test(url)) {
				return false;
			}
			return launch(app, url);
		}),
	);
}
