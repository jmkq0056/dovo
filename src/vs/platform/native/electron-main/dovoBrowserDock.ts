/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { BrowserWindow, systemPreferences } from 'electron';
import { Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';
import { IRectangle } from '../../window/common/window.js';
import { DovoBrowserDockStatus, IDovoBrowserDockRequest, IDovoBrowserDockResult, IDovoBrowserWindow } from '../common/native.js';

// Dovo's browser tab: Gecko can't run inside Electron, so the user's real browser window is placed
// exactly over the tab. The renderer reports where the tab is inside the window; this side knows
// where the window is and follows it the moment it moves, resizes, minimizes or comes to the front.
// Windows are moved through System Events, which needs Dovo in Accessibility (macOS asks once).

// The app's process is found by bundle id, so "Firefox", "Firefox Developer Edition", "LibreWolf"
// or "Zen" all work. Values only ever arrive as arguments, never interpolated into the script.
const prelude = `
	set bid to id of application (item 1 of argv)
	tell application "System Events"
		if not (exists (first application process whose bundle identifier is bid)) then return "notRunning"
		set p to first application process whose bundle identifier is bid
`;

const listScript = `on run argv
	${prelude}
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

// Finds the window to act on (the one placed last, else the one picked, else the frontmost real
// window) and places, raises, focuses, minimizes or restores it, all in one call so it's quick.
// argv: app, action, x, y, w, h (where to place), mode ("docked" | "pick" | "front"), and the
// rectangle (docked) or title + position (pick) to find the window by.
const actScript = `on run argv
	${prelude}
		set action to item 2 of argv
		set mode to item 7 of argv
		set ws to every window of p
		set target to missing value
		repeat with w in ws
			try
				set {wx, wy} to position of w
				set {ww, wh} to size of w
				if mode is "docked" then
					if my near(wx, item 8 of argv) and my near(wy, item 9 of argv) and my near(ww, item 10 of argv) and my near(wh, item 11 of argv) then set target to w
				else if mode is "pick" then
					if (name of w) is (item 12 of argv) and my near(wx, item 8 of argv) and my near(wy, item 9 of argv) then set target to w
				end if
			end try
			if target is not missing value then exit repeat
		end repeat
		if target is missing value and mode is "pick" then
			repeat with w in ws
				if (name of w) is (item 12 of argv) then
					set target to w
					exit repeat
				end if
			end repeat
		end if
		if target is missing value then
			if action is not "place" and action is not "newTab" then return "noWindow"
			repeat with w in ws
				try
					set {ww, wh} to size of w
					if ww > 120 and wh > 80 then
						set target to w
						exit repeat
					end if
				end try
			end repeat
		end if
		if target is missing value then return "noWindow"
		if action is "minimize" then
			set value of attribute "AXMinimized" of target to true
			return "ok" & tab & (name of target)
		end if
		try
			if value of attribute "AXMinimized" of target then set value of attribute "AXMinimized" of target to false
		end try
		if action is "place" then
			set position of target to {item 3 of argv as integer, item 4 of argv as integer}
			set size of target to {item 5 of argv as integer, item 6 of argv as integer}
		end if
		perform action "AXRaise" of target
		if action is "focus" or action is "newTab" then set frontmost of p to true
		if action is "newTab" then keystroke "t" using command down
		set {x, y} to position of target
		set {ww, wh} to size of target
		return "ok" & tab & x & tab & y & tab & ww & tab & wh & tab & (name of target)
	end tell
end run
on near(a, b)
	set d to (a as integer) - (b as integer)
	return d < 4 and d > -4
end near`;

type Action = 'place' | 'raise' | 'focus' | 'newTab' | 'minimize';

interface IWindowState {
	app: string;
	visible: boolean;
	/** The tab's body, relative to the window's content. */
	rect: IRectangle | undefined;
	pick: { title: string; x: number; y: number } | undefined;
	/** Where the docked browser window was put last (screen points): how it's found again. */
	placed: IRectangle | undefined;
	status: DovoBrowserDockStatus | undefined;
	title: string | undefined;
}

function near(a: number, b: number): boolean {
	return Math.abs(a - b) <= 3;
}

function sameRect(a: IRectangle | undefined, b: IRectangle | undefined): boolean {
	return !!a && !!b && near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}

export class DovoBrowserDock extends Disposable {

	private readonly states = new Map<number, IWindowState>();
	private readonly windowListeners = this._register(new DisposableMap<number, DisposableStore>());
	/** One System Events call at a time; window events that arrive meanwhile coalesce into one more. */
	private running: Promise<void> | undefined;
	private readonly dirty = new Set<number>();
	private readonly installed = new Set<string>();
	private askedForPermission = false;

	constructor(@ILogService private readonly logService: ILogService) {
		super();
	}

	async dock(window: BrowserWindow, request: IDovoBrowserDockRequest): Promise<IDovoBrowserDockResult> {
		if (!isMacintosh) {
			return { status: 'unsupported' };
		}
		const state = this.stateOf(window, request.app);
		const appChanged = state.app !== request.app;
		state.app = request.app;
		state.visible = request.visible;
		state.rect = request.rect ?? state.rect;
		if (request.pick) {
			state.pick = request.pick;
		}
		if (appChanged) {
			state.placed = undefined;
		}
		if (!request.visible) {
			return { status: state.status ?? 'ok', title: state.title };
		}
		const blocked = await this.check(window, state);
		if (blocked) {
			return { status: blocked };
		}
		this.dirty.add(window.id);
		await this.drain();
		return { status: state.status ?? 'error', title: state.title };
	}

	async windows(app: string): Promise<IDovoBrowserDockResult> {
		if (!isMacintosh) {
			return { status: 'unsupported' };
		}
		if (!await this.isInstalled(app)) {
			return { status: 'missing' };
		}
		if (!this.trusted(false)) {
			return { status: 'permission' };
		}
		const { status, out } = await this.osascript(listScript, [app]);
		if (status !== 'ok') {
			return { status };
		}
		const placed = [...this.states.values()].filter(state => state.app === app).map(state => state.placed);
		const windows: IDovoBrowserWindow[] = [];
		for (const line of out.split('\n')) {
			const [index, x, y, width, height, ...title] = line.split('\t');
			const rect = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
			// Tiny windows are popups and menus, not browser windows.
			if (!index || rect.width < 120 || rect.height < 80) {
				continue;
			}
			windows.push({ index: Number(index), title: title.join('\t'), ...rect, docked: placed.some(p => sameRect(p, rect)) });
		}
		return { status: 'ok', windows };
	}

	async action(window: BrowserWindow, app: string, action: 'raise' | 'focus' | 'newTab'): Promise<IDovoBrowserDockResult> {
		if (!isMacintosh) {
			return { status: 'unsupported' };
		}
		const state = this.stateOf(window, app);
		const blocked = await this.check(window, state);
		if (blocked) {
			return { status: blocked };
		}
		return this.act(state, action);
	}

	async openUrl(app: string, url: string): Promise<boolean> {
		if (!/^https?:\/\//i.test(url)) {
			return false;
		}
		return this.launch(app, url);
	}

	async isInstalled(app: string): Promise<boolean> {
		if (!isMacintosh) {
			return false;
		}
		if (this.installed.has(app)) {
			return true;
		}
		// Look for the app quietly: the usual folders first, then Spotlight. (open -R would reveal it
		// in a Finder window, and AppleScript would ask "Where is ...?" when it's missing.)
		const name = app.endsWith('.app') ? app : `${app}.app`;
		const folders = ['/Applications', join(homedir(), 'Applications'), '/Applications/Setapp'];
		let found = folders.some(folder => existsSync(join(folder, name)));
		if (!found) {
			found = await new Promise<boolean>(resolve => execFile('/usr/bin/mdfind', [`kMDItemContentType == "com.apple.application-bundle" && kMDItemFSName == "${name.replace(/["\\]/g, '')}"`], { timeout: 4000 }, (error, stdout) => resolve(!error && stdout.trim().length > 0)));
		}
		if (found) {
			this.installed.add(app);
		}
		return found;
	}

	/** Native full screen puts Dovo in a Space of its own that no other app's window can enter. */
	async useSimpleFullScreen(window: BrowserWindow, toggleFullScreen: () => void): Promise<void> {
		if (!isMacintosh) {
			return;
		}
		if (window.isFullScreen()) {
			const left = Event.toPromise(Event.once(Event.fromNodeEventEmitter(window, 'leave-full-screen')));
			window.setFullScreen(false);
			await Promise.race([left, new Promise(resolve => setTimeout(resolve, 3000))]);
		}
		if (!window.isSimpleFullScreen()) {
			toggleFullScreen();
		}
		const state = this.states.get(window.id);
		if (state) {
			state.status = undefined;
			this.dirty.add(window.id);
			void this.drain();
		}
	}

	private stateOf(window: BrowserWindow, app: string): IWindowState {
		let state = this.states.get(window.id);
		if (!state) {
			state = { app, visible: false, rect: undefined, pick: undefined, placed: undefined, status: undefined, title: undefined };
			this.states.set(window.id, state);
			this.listen(window);
		}
		return state;
	}

	/** What stops docking right now, if anything: no browser, no permission, native full screen. */
	private async check(window: BrowserWindow, state: IWindowState): Promise<DovoBrowserDockStatus | undefined> {
		let blocked: DovoBrowserDockStatus | undefined;
		if (!await this.isInstalled(state.app)) {
			blocked = 'missing';
		} else if (!this.trusted(!this.askedForPermission)) {
			this.askedForPermission = true;
			blocked = 'permission';
		} else if (window.isFullScreen()) {
			blocked = 'nativeFullScreen';
		}
		if (blocked) {
			state.status = blocked;
		}
		return blocked;
	}

	/** Whether Dovo may move other apps' windows; `prompt` lets macOS ask (it shows its own dialog). */
	private trusted(prompt: boolean): boolean {
		return systemPreferences.isTrustedAccessibilityClient(prompt);
	}

	private listen(window: BrowserWindow): void {
		const store = new DisposableStore();
		const id = window.id;
		const follow = () => {
			const state = this.states.get(id);
			if (state?.visible && state.status === 'ok') {
				this.dirty.add(id);
				void this.drain();
			}
		};
		const on = (event: string, handler: () => void) => {
			window.on(event as 'move', handler);
			store.add(toDisposable(() => window.removeListener(event as 'move', handler)));
		};
		on('move', follow);
		on('resize', follow);
		on('restore', () => {
			const state = this.states.get(id);
			if (state?.visible) {
				state.status = undefined;
				this.dirty.add(id);
				void this.drain();
			}
		});
		on('minimize', () => {
			const state = this.states.get(id);
			if (state?.visible && state.placed) {
				void this.act(state, 'minimize');
			}
		});
		on('enter-full-screen', () => {
			const state = this.states.get(id);
			if (state) {
				state.status = 'nativeFullScreen';
			}
		});
		on('leave-full-screen', () => {
			const state = this.states.get(id);
			if (state?.status === 'nativeFullScreen') {
				state.status = undefined;
			}
			follow();
		});
		// Dovo coming to the front covers the browser: put the browser back on top (without taking
		// focus, so the two don't trade focus back and forth). This is also when a permission that
		// was just granted in System Settings takes effect.
		on('focus', () => {
			const state = this.states.get(id);
			if (!state?.visible) {
				return;
			}
			if (state.status === 'permission' && this.trusted(false)) {
				state.status = undefined;
			}
			if (state.status === undefined || state.status === 'ok' || state.status === 'noWindow' || state.status === 'notRunning') {
				this.dirty.add(id);
				void this.drain();
			}
		});
		on('closed', () => {
			this.states.delete(id);
			this.dirty.delete(id);
			this.windowListeners.deleteAndDispose(id);
		});
		this.windowListeners.set(id, store);
	}

	/** Runs the pending placements, one System Events call at a time. */
	private drain(): Promise<void> {
		if (!this.running) {
			this.running = (async () => {
				try {
					while (this.dirty.size) {
						const [id] = this.dirty;
						this.dirty.delete(id);
						await this.place(id);
					}
				} finally {
					this.running = undefined;
				}
			})();
		}
		return this.running;
	}

	private async place(id: number): Promise<void> {
		const state = this.states.get(id);
		const window = BrowserWindow.fromId(id);
		if (!state?.visible || !state.rect || !window || window.isDestroyed() || window.isMinimized()) {
			return;
		}
		if (window.isFullScreen()) {
			state.status = 'nativeFullScreen';
			return;
		}
		const content = window.getContentBounds();
		const target: IRectangle = {
			x: Math.round(content.x + state.rect.x),
			y: Math.round(content.y + state.rect.y),
			width: Math.max(200, Math.round(state.rect.width)),
			height: Math.max(120, Math.round(state.rect.height)),
		};
		// Already there: only bring it to the front (the window event may have been Dovo's focus).
		const action: Action = sameRect(target, state.placed) && !state.pick && state.status === 'ok' ? 'raise' : 'place';
		let result = await this.act(state, action, target);
		if ((result.status === 'notRunning' || result.status === 'noWindow') && action === 'place') {
			// Start the browser (or give it a window) and try again once it's up.
			if (await this.launch(state.app)) {
				for (let attempt = 0; attempt < 20 && (result.status === 'notRunning' || result.status === 'noWindow'); attempt++) {
					await new Promise(resolve => setTimeout(resolve, 250));
					result = await this.act(state, 'place', target);
				}
			}
		}
		state.status = result.status;
		if (result.status === 'ok') {
			state.title = result.title;
		}
	}

	private async act(state: IWindowState, action: Action, target?: IRectangle): Promise<IDovoBrowserDockResult> {
		const pick = state.pick;
		const find = pick
			? ['pick', String(pick.x), String(pick.y), '0', '0', pick.title]
			: state.placed
				? ['docked', String(state.placed.x), String(state.placed.y), String(state.placed.width), String(state.placed.height), '']
				: ['front', '0', '0', '0', '0', ''];
		const to = target ?? state.placed ?? { x: 0, y: 0, width: 0, height: 0 };
		const { status, out } = await this.osascript(actScript, [state.app, action, String(to.x), String(to.y), String(to.width), String(to.height), ...find]);
		if (status !== 'ok') {
			return { status };
		}
		const [word, x, y, width, height, ...title] = out.split('\t');
		if (word !== 'ok') {
			return { status: word === 'noWindow' ? 'noWindow' : 'error' };
		}
		if (action === 'place') {
			state.pick = undefined;
		}
		if (action !== 'minimize' && x !== undefined) {
			// What macOS actually gave it (it may clamp a window below the menu bar).
			state.placed = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
		}
		return { status: 'ok', title: title.join('\t') || undefined };
	}

	private launch(app: string, url?: string): Promise<boolean> {
		return new Promise(resolve => {
			const child = spawn('/usr/bin/open', ['-a', app, ...(url ? [url] : [])], { stdio: 'ignore' });
			child.on('error', () => resolve(false));
			child.on('exit', code => resolve(code === 0));
		});
	}

	private osascript(script: string, args: string[]): Promise<{ status: DovoBrowserDockStatus; out: string }> {
		return new Promise(resolve => {
			execFile('/usr/bin/osascript', ['-e', script, ...args], { timeout: 5000 }, (error, stdout, stderr) => {
				const out = String(stdout ?? '').trim();
				if (!error) {
					resolve({ status: out === 'notRunning' ? 'notRunning' : out === 'noWindow' ? 'noWindow' : 'ok', out });
					return;
				}
				const text = `${stderr ?? ''} ${error.message}`;
				if (/-1719|-25211|assistive|not allowed/i.test(text)) {
					resolve({ status: 'permission', out: '' });
				} else if (/-1728|-10814|Can.t get application/i.test(text)) {
					resolve({ status: 'missing', out: '' });
				} else {
					this.logService.warn(`[dovo browser] ${text.trim().slice(0, 300)}`);
					resolve({ status: 'error', out: '' });
				}
			});
		});
	}
}
