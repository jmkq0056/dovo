/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Maut: open a single terminal in the editor area running `clsp`, with EDITOR/VISUAL set so
 *  Claude Code's external-editor command opens files in this Maut code window. Also resolves
 *  `[Image #N]` references for the workbench's terminal image previews.
 */

import * as vscode from 'vscode';
import { ClaudeImageResolver } from './claudeImageResolver';

// Use the full claude flag rather than the user's `clsp` alias so the app works on machines
// where the alias isn't defined.
const CLSP_COMMAND = 'claude --dangerously-skip-permissions';

let mautTerminal: vscode.Terminal | undefined;

interface MautTerminalInfo {
	readonly number: number;
	state: 'active' | 'idle';
	icon: string;
	color: string;
}

const ICON_POOL = [
	'flame', 'rocket', 'star-empty', 'beaker', 'lightbulb', 'mortar-board',
	'snake', 'octoface', 'bug', 'gear', 'plug', 'briefcase', 'bell', 'book',
	'calendar', 'compass', 'dashboard', 'database', 'archive', 'diff',
];

const COLOR_POOL = [
	'terminal.ansiBlue', 'terminal.ansiCyan', 'terminal.ansiGreen', 'terminal.ansiMagenta',
	'terminal.ansiRed', 'terminal.ansiYellow',
	'terminal.ansiBrightBlue', 'terminal.ansiBrightCyan', 'terminal.ansiBrightGreen',
	'terminal.ansiBrightMagenta', 'terminal.ansiBrightRed', 'terminal.ansiBrightYellow',
];

const usedIcons = new Map<string, number>(); // icon → refcount
const usedColors = new Map<string, number>();

function allocateIcon(): string {
	for (const ic of ICON_POOL) {
		if (!usedIcons.has(ic)) { usedIcons.set(ic, 1); return ic; }
	}
	// All taken; pick least-used.
	let min: { id: string; count: number } | undefined;
	for (const [id, count] of usedIcons) {
		if (!min || count < min.count) { min = { id, count }; }
	}
	const id = min?.id ?? ICON_POOL[0];
	usedIcons.set(id, (usedIcons.get(id) ?? 0) + 1);
	return id;
}

function allocateColor(): string {
	for (const c of COLOR_POOL) {
		if (!usedColors.has(c)) { usedColors.set(c, 1); return c; }
	}
	let min: { id: string; count: number } | undefined;
	for (const [id, count] of usedColors) {
		if (!min || count < min.count) { min = { id, count }; }
	}
	const id = min?.id ?? COLOR_POOL[0];
	usedColors.set(id, (usedColors.get(id) ?? 0) + 1);
	return id;
}

function releaseAllocation(info: MautTerminalInfo): void {
	const ic = usedIcons.get(info.icon);
	if (ic !== undefined) {
		if (ic <= 1) { usedIcons.delete(info.icon); } else { usedIcons.set(info.icon, ic - 1); }
	}
	const co = usedColors.get(info.color);
	if (co !== undefined) {
		if (co <= 1) { usedColors.delete(info.color); } else { usedColors.set(info.color, co - 1); }
	}
}

const mautTerminals = new Map<vscode.Terminal, MautTerminalInfo>();

function isClaudeCommand(cmd: string): boolean {
	const trimmed = cmd.trim();
	return /^(clsp|claude)(\s|$)/.test(trimmed);
}

function nextNumber(): number {
	const used = new Set<number>();
	for (const info of mautTerminals.values()) {
		if (info.state === 'active') { used.add(info.number); }
	}
	let n = 1;
	while (used.has(n)) { n++; }
	return n;
}

function makeMautName(n: number): string {
	return `${n} -- MAUT`;
}

function startClaudeInNewTerminal(opts?: { autoResume?: boolean }): vscode.Terminal {
	const n = nextNumber();
	const icon = allocateIcon();
	const color = allocateColor();
	const t = vscode.window.createTerminal({
		name: makeMautName(n),
		iconPath: new vscode.ThemeIcon(icon),
		color: new vscode.ThemeColor(color),
		env: {
			EDITOR: 'maut-code --wait',
			VISUAL: 'maut-code --wait',
		},
	});
	mautTerminals.set(t, { number: n, state: 'active', icon, color });
	t.show(false);
	// `clsp --continue` (auto-resume of latest session) vs `clsp` (fresh). The shell alias
	// passes args through to the underlying claude binary.
	const cmd = opts?.autoResume ? `${CLSP_COMMAND} --continue` : CLSP_COMMAND;
	t.sendText(cmd, true);
	mautTerminal = t;
	return t;
}

function mautInfo(t: vscode.Terminal): MautTerminalInfo | undefined {
	return mautTerminals.get(t);
}

function labelFor(t: vscode.Terminal): string {
	const info = mautInfo(t);
	if (!info) { return t.name; }
	return makeMautName(info.number);
}

async function switchMautTerminal(): Promise<void> {
	const entries: vscode.QuickPickItem[] = [];
	const sorted = Array.from(mautTerminals.entries()).sort((a, b) => a[1].number - b[1].number);
	for (const [, info] of sorted) {
		entries.push({
			label: `${info.state === 'active' ? '$(circle-filled)' : '$(circle-outline)'} ${makeMautName(info.number)}`,
			description: info.state === 'active' ? 'active' : 'idle',
		});
	}
	entries.push({ label: '$(add) Start new MAUT', description: 'spawn a fresh numbered terminal' });
	const pick = await vscode.window.showQuickPick(entries, { placeHolder: 'Switch Maut terminal' });
	if (!pick) { return; }
	if (pick.label.startsWith('$(add)')) {
		startClaudeInNewTerminal();
		return;
	}
	const m = /(\d+) -- MAUT/.exec(pick.label);
	if (!m) { return; }
	const target = sorted.find(([, info]) => info.number === parseInt(m[1], 10));
	if (target) {
		target[0].show(false);
		mautTerminal = target[0];
	}
}

function bindShellExecutionTracking(context: vscode.ExtensionContext): void {
	const onStart: vscode.Event<vscode.TerminalShellExecutionStartEvent> | undefined = vscode.window.onDidStartTerminalShellExecution;
	const onEnd: vscode.Event<vscode.TerminalShellExecutionEndEvent> | undefined = vscode.window.onDidEndTerminalShellExecution;
	if (onStart) {
		context.subscriptions.push(onStart(async (e) => {
			const cmd = e.execution?.commandLine?.value ?? '';
			if (!isClaudeCommand(cmd)) { return; }
			let info = mautTerminals.get(e.terminal);
			if (!info) {
				const n = nextNumber();
				const icon = allocateIcon();
				const color = allocateColor();
				info = { number: n, state: 'active', icon, color };
				mautTerminals.set(e.terminal, info);
				try {
					e.terminal.show(false);
					await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: makeMautName(n) });
					await vscode.commands.executeCommand('maut.terminal.setAppearance', { icon, color });
				} catch { /* noop */ }
			} else if (info.state === 'idle') {
				// Previously CLOSED terminal → allocate fresh number + fresh appearance + rename.
				const n = nextNumber();
				const icon = allocateIcon();
				const color = allocateColor();
				(info as { number: number }).number = n;
				info.icon = icon;
				info.color = color;
				info.state = 'active';
				try {
					e.terminal.show(false);
					await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: makeMautName(n) });
					await vscode.commands.executeCommand('maut.terminal.setAppearance', { icon, color });
				} catch { /* noop */ }
			} else {
				info.state = 'active';
			}
			mautTerminal = e.terminal;
		}));
	}
	if (onEnd) {
		context.subscriptions.push(onEnd(async (e) => {
			const cmd = e.execution?.commandLine?.value ?? '';
			if (!isClaudeCommand(cmd)) { return; }
			const info = mautTerminals.get(e.terminal);
			if (!info || info.state === 'idle') { return; }
			// Free the number + colorful slot, rename tab to CLOSED, mute the icon.
			releaseAllocation(info);
			info.state = 'idle';
			info.icon = 'history';
			info.color = 'terminal.ansiBlack';
			try {
				e.terminal.show(false);
				await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: 'CLOSED' });
				await vscode.commands.executeCommand('maut.terminal.setAppearance', { icon: info.icon, color: info.color });
			} catch { /* noop */ }
		}));
	}

	// On extension activation, mark any restored "N -- MAUT" terminals as CLOSED until a
	// shell-execution event proves them alive again.
	void markRestoredTerminalsClosed();
}

async function markRestoredTerminalsClosed(): Promise<void> {
	// Defer to give VS Code time to restore terminal tabs.
	await new Promise(r => setTimeout(r, 1500));
	for (const t of vscode.window.terminals) {
		if (!/^\d+ -- MAUT$/.test(t.name)) { continue; }
		if (mautTerminals.has(t)) { continue; }
		try {
			t.show(false);
			await new Promise(r => setTimeout(r, 50));
			await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: 'CLOSED' });
			await vscode.commands.executeCommand('maut.terminal.setAppearance', { icon: 'history', color: 'terminal.ansiBlack' });
		} catch { /* noop */ }
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// The workbench (terminalContrib/maut) draws the previews and handles cmd+click; it asks us
	// for the file behind `[Image #N]` because only the extension host can read ~/.claude.
	const imageResolver = new ClaudeImageResolver(vscode.Uri.joinPath(context.globalStorageUri, 'claude-images').fsPath);
	imageResolver.pruneCache();
	context.subscriptions.push(
		vscode.commands.registerCommand('_maut.claudeImages.resolve', (shellPid: number | undefined, index: number) => imageResolver.resolve(shellPid, index)),
		vscode.commands.registerCommand('_maut.claudeImages.captureClipboard', (shellPid: number | undefined, index: number) => imageResolver.captureClipboard(shellPid, index)),
	);

	context.subscriptions.push(
		vscode.window.onDidCloseTerminal((t) => {
			const info = mautTerminals.get(t);
			if (info) { releaseAllocation(info); }
			mautTerminals.delete(t);
			if (t === mautTerminal) { mautTerminal = undefined; }
		}),
	);

	bindShellExecutionTracking(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('maut.chat.startClaude', () => startClaudeInNewTerminal()),
		vscode.commands.registerCommand('maut.terminals.switch', () => switchMautTerminal()),
		vscode.commands.registerCommand('maut.terminals.label', (t: vscode.Terminal) => labelFor(t)),
	);

	// Move any editor-area terminals down into the bottom panel (like a drag-and-drop)
	// so they share the panel and free up editor area width.
	for (const t of vscode.window.terminals) {
		try {
			t.show(false);
			await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
		} catch { /* noop */ }
	}

	// Smart auto-launch: if there's no Maut-active terminal AND the setting allows it,
	// spawn a fresh clsp. Existing non-Maut terminals (zsh, etc.) are left alone — we don't
	// hijack them; we just add a new Maut terminal alongside.
	const cfg = vscode.workspace.getConfiguration('maut');
	const autoLaunch = cfg.get<boolean>('autoLaunchClsp', true);
	const autoFocus = cfg.get<boolean>('autoEnterFocusMode', false);
	const autoResume = cfg.get<boolean>('autoResumeOnLaunch', true);

	const existingMaut = vscode.window.terminals.find(t => /^\d+ -- MAUT$/.test(t.name) || t.name.startsWith('Maut'));
	if (existingMaut) {
		mautTerminal = existingMaut;
		existingMaut.show(false);
	} else if (autoLaunch) {
		setTimeout(() => {
			startClaudeInNewTerminal({ autoResume });
			if (autoFocus) {
				setTimeout(() => {
					void vscode.commands.executeCommand('maut.focus.toggleTerminal').then(undefined, () => { /* noop */ });
				}, 250);
			}
		}, 400);
	}
}

export function deactivate(): void { /* noop */ }
