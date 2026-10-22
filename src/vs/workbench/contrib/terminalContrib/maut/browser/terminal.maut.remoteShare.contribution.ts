/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import { timeout } from '../../../../../base/common/async.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IMautClaudeService } from '../../../terminal/browser/mautClaude.js';
import { IScreen, isWorkingOnScreen, readScreen } from '../../../terminal/browser/mautClaudeScreen.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { XtermAddonImporter } from '../../../terminal/browser/xterm/xtermAddonImporter.js';

// What the `maut-activity` extension (its terminalShare.ts) asks about Dovo's terminals to share
// them with Dovo Remote: which ones run Claude and what Claude is doing, read off the same screen
// the Reader reads; and a terminal's screen and scrollback as escape sequences, so the phone
// starts from exactly what Dovo shows. Terminals are named by their shell's process id, which
// the extension knows too.

/** One terminal as Dovo Remote lists it. */
interface IRemoteTerminalState {
	readonly processId: number;
	/** Claude runs in it: Dovo started Claude there, or Claude's own UI is on its screen. */
	readonly claude: boolean;
	/** Claude asks a question (numbered options) and waits for an answer. */
	readonly needsYou: boolean;
	/** Claude is mid-turn. */
	readonly working: boolean;
	/** At most two lines for the list: Claude's question, its latest output, or the shell's last lines. */
	readonly preview: string[];
}

/** A terminal's screen and scrollback, to paint before live output. */
interface IRemoteTerminalSnapshot {
	readonly data: string;
	readonly cols: number;
	readonly rows: number;
}

const statesCommandId = '_dovo.remote.terminalStates';
const snapshotCommandId = '_dovo.remote.terminalSnapshot';
/** Scrollback rows tried, longest first, until the snapshot fits the size the extension asks for. */
const scrollbacks = [2000, 800, 300, 100, 0];
/**
 * Output reaches the extension host in batches a few milliseconds late. The snapshot is answered
 * only after output has been quiet this long (or {@link longestWait} passed), so everything it
 * covers has reached the extension before the answer does.
 */
const quietFor = 12;
const previewLength = 200;
const longestWait = 150;

const serializeAddons = new WeakMap<RawXtermTerminal, SerializeAddonType>();
const addonImporter = new XtermAddonImporter();

/** The bottom of a terminal's buffer, whatever the user scrolled to in Dovo. */
function bottomScreen(raw: RawXtermTerminal): IScreen {
	const buffer = raw.buffer.active;
	return {
		rows: raw.rows,
		cols: raw.cols,
		buffer: { active: { viewportY: buffer.baseY, getLine: y => buffer.getLine(y) } },
	};
}

/** The last non-empty lines above `end` (rules left out), at most two. */
function lastLines(screen: IScreen, end: number): string[] {
	const buffer = screen.buffer.active;
	const lines: string[] = [];
	for (let row = end - 1; row >= 0 && lines.length < 2; row--) {
		const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true).trim() ?? '';
		if (line && !/^[\u2500-\u257f\s]+$/.test(line)) {
			lines.unshift(line.slice(0, previewLength));
		}
	}
	return lines;
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

async function snapshot(instance: ITerminalInstance, maxBytes: number): Promise<IRemoteTerminalSnapshot | undefined> {
	const raw = instance.xterm?.raw;
	if (!raw) {
		return undefined;
	}
	let addon = serializeAddons.get(raw);
	if (!addon) {
		const SerializeAddon = await addonImporter.importAddon('serialize');
		addon = new SerializeAddon();
		raw.loadAddon(addon);
		serializeAddons.set(raw, addon);
	}
	// A chunk of output is in the buffer once its data event fires (both happen when it's parsed),
	// so the snapshot covers exactly the output fired so far, and what fires from now on follows it.
	let data = '';
	for (const scrollback of scrollbacks) {
		data = addon.serialize({ scrollback });
		if (byteLength(data) <= maxBytes) {
			break;
		}
	}
	const after: string[] = [];
	let lastOutput = 0;
	const listener = instance.onData(chunk => {
		after.push(chunk);
		lastOutput = Date.now();
	});
	try {
		const started = Date.now();
		do {
			await timeout(quietFor);
		} while (Date.now() - lastOutput < quietFor && Date.now() - started < longestWait);
		return { data: data + after.join(''), cols: raw.cols, rows: raw.rows };
	} finally {
		listener.dispose();
	}
}

CommandsRegistry.registerCommand(statesCommandId, (accessor): IRemoteTerminalState[] => {
	const terminalService = accessor.get(ITerminalService);
	const claudeService = accessor.get(IMautClaudeService);
	const states: IRemoteTerminalState[] = [];
	for (const instance of terminalService.instances) {
		const processId = instance.processId;
		if (!processId) {
			continue;
		}
		const raw = instance.xterm?.raw;
		if (!raw) {
			states.push({ processId, claude: claudeService.isClaude(instance), needsYou: false, working: false, preview: [] });
			continue;
		}
		const screen = bottomScreen(raw);
		const state = readScreen(screen);
		const claude = claudeService.isClaude(instance) || state.claude;
		const dialog = claude ? state.dialog : undefined;
		states.push({
			processId,
			claude,
			needsYou: !!dialog,
			working: claude && isWorkingOnScreen(screen),
			preview: dialog ? [dialog.question.slice(0, previewLength)] : lastLines(screen, claude ? state.liveTop : screen.rows),
		});
	}
	return states;
});

CommandsRegistry.registerCommand(snapshotCommandId, (accessor, processId: number, maxBytes: number): Promise<IRemoteTerminalSnapshot | undefined> => {
	const instance = accessor.get(ITerminalService).instances.find(candidate => candidate.processId === processId);
	return instance ? snapshot(instance, maxBytes) : Promise.resolve(undefined);
});
