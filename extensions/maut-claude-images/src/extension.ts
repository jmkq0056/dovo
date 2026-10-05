/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Maut: open a single terminal in the editor area running `clsp`, with EDITOR/VISUAL set so
 *  Claude Code's external-editor command opens files in this Maut code window. Also resolves
 *  `[Image #N]` references for the workbench's terminal image previews.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeImageResolver, findSessionId, readSessionRecords } from './claudeImageResolver';
import { claudeCommand, registerClaudeLaunch } from './claudeLaunch';
import { ClaudeSessionReader } from './claudeSession';

// Use the full claude flag rather than the user's `clsp` alias so the app works on machines
// where the alias isn't defined.

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
	return `${n} -- DOVO`;
}

function startClaudeInNewTerminal(opts?: { autoResume?: boolean }): vscode.Terminal {
	const t = createMautTerminal();
	void runClaude(t, opts?.autoResume ?? false);
	return t;
}

function createMautTerminal(): vscode.Terminal {
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
	mautTerminal = t;
	return t;
}

/**
 * Start Claude in `terminal` once its shell is ready. With `resume`, try `--continue` first and
 * start a fresh session if that exits right away (e.g. no earlier conversation in this folder).
 */
async function runClaude(terminal: vscode.Terminal, resume: boolean): Promise<void> {
	if (!resume) {
		await runCommand(terminal, claudeCommand());
		return;
	}
	const result = await runCommand(terminal, `${claudeCommand()} --continue`);
	if (result === 'ended-quickly') {
		await runCommand(terminal, claudeCommand());
	}
}

/**
 * Run a command through shell integration so it's executed for real (not typed into a shell
 * that isn't ready yet) and its end is known. Falls back to typing it after a few seconds.
 * Resolves `ended-quickly` if the command finished within 8 seconds, else `running`.
 */
async function runCommand(terminal: vscode.Terminal, command: string): Promise<'ended-quickly' | 'running'> {
	const integration = terminal.shellIntegration ?? await new Promise<vscode.TerminalShellIntegration | undefined>(resolve => {
		const timer = setTimeout(() => { listener.dispose(); resolve(undefined); }, 5000);
		const listener = vscode.window.onDidChangeTerminalShellIntegration(e => {
			if (e.terminal === terminal) {
				clearTimeout(timer);
				listener.dispose();
				resolve(e.shellIntegration);
			}
		});
	});
	if (!integration) {
		terminal.sendText(command, true);
		return 'running';
	}
	const execution = integration.executeCommand(command);
	return new Promise(resolve => {
		const timer = setTimeout(() => { listener.dispose(); resolve('running'); }, 8000);
		const listener = vscode.window.onDidEndTerminalShellExecution(e => {
			if (e.execution === execution) {
				clearTimeout(timer);
				listener.dispose();
				resolve('ended-quickly');
			}
		});
	});
}

/** Tells the workbench's startup splash what's happening. */
function reportStartup(state: 'resuming' | 'starting' | 'skip' | 'failed', message?: string): void {
	void vscode.commands.executeCommand('_maut.startup.status', state, message).then(undefined, () => { /* no splash */ });
}

/** Whether Claude Code has a conversation saved for `folder` (in ~/.claude/projects). */
function hasConversation(folder: string): boolean {
	const dir = path.join(os.homedir(), '.claude', 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'));
	try {
		return fs.readdirSync(dir).some(name => name.endsWith('.jsonl'));
	} catch {
		return false;
	}
}

/** The program in the `maut.claude.command` setting, without its arguments. */
function claudeProgram(): string {
	return (vscode.workspace.getConfiguration('maut.claude').get<string>('command', 'claude').trim() || 'claude').split(/\s+/)[0];
}

/** PATH plus the places Claude Code's installers use, which a GUI app's PATH often lacks. */
function claudeSearchPath(): string[] {
	return [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
}

/** Why Claude can't start, if it can't: its command isn't installed or isn't found. */
async function claudeMissing(): Promise<string | undefined> {
	const command = claudeProgram();
	if (command.includes('/') || command.includes('\\')) {
		return fs.existsSync(command.replace(/^~/, os.homedir())) ? undefined : `${command} doesn't exist. Check the maut.claude.command setting.`;
	}
	const places = claudeSearchPath();
	const names = process.platform === 'win32' ? [`${command}.exe`, `${command}.cmd`, command] : [command];
	for (const dir of places) {
		for (const name of names) {
			if (dir && fs.existsSync(path.join(dir, name))) {
				return undefined;
			}
		}
	}
	return `The ${command} command isn't installed on this computer, so Dovo can't start Claude for you.`;
}

/** A file as it is in the last commit, or undefined when it isn't tracked (or there's no git). */
function gitOriginal(fsPath: string): Promise<string | undefined> {
	return new Promise(resolve => {
		cp.execFile('git', ['-C', path.dirname(fsPath), 'show', `HEAD:./${path.basename(fsPath)}`], { maxBuffer: 16 * 1024 * 1024, timeout: 4000 }, (error, stdout) => resolve(error ? undefined : stdout));
	});
}

/** Anthropic's official one-line installer for Claude Code. */
const claudeInstallCommand = process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';

/** Installs Claude Code in a terminal, with Anthropic's official installer. */
function installClaude(): void {
	const terminal = vscode.window.createTerminal({ name: 'Install Claude Code' });
	terminal.show();
	terminal.sendText(claudeInstallCommand, true);
}

interface ClaudeStatus {
	readonly installed: boolean;
	readonly version?: string;
	readonly problem?: string;
	readonly installCommand: string;
}

/** For the Dovo welcome: is Claude Code installed, which version, and how to install it. Never throws. */
async function claudeStatus(): Promise<ClaudeStatus> {
	try {
		const problem = await claudeMissing();
		if (problem) {
			return { installed: false, problem, installCommand: claudeInstallCommand };
		}
		const version = await new Promise<string | undefined>(resolve => {
			const env = { ...process.env, PATH: claudeSearchPath().join(path.delimiter) };
			cp.execFile(claudeProgram().replace(/^~/, os.homedir()), ['--version'], { timeout: 5000, env, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim().split(/\r?\n/)[0] || undefined));
		});
		return { installed: true, version, installCommand: claudeInstallCommand };
	} catch (error) {
		return { installed: false, problem: error instanceof Error ? error.message : String(error), installCommand: claudeInstallCommand };
	}
}

/** Waits while the Dovo welcome is open, so Claude starts with the choices made there. */
async function untilWelcomeDone(): Promise<void> {
	try {
		await vscode.commands.executeCommand('_dovo.onboarding.whenDone');
	} catch {
		// no welcome in this build, or it failed: start as usual
	}
}

/** True if a Claude Code process is running under any of this window's terminals. */
async function isClaudeRunningHere(): Promise<boolean> {
	for (const terminal of vscode.window.terminals) {
		const pid = await terminal.processId;
		if (pid && await findSessionId(pid)) {
			return true;
		}
	}
	return false;
}

/** A real project folder: not missing, not your home folder, not the disk root. */
function projectFolder(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder || folder.scheme !== 'file') {
		return undefined;
	}
	const fsPath = path.resolve(folder.fsPath);
	return fsPath === os.homedir() || fsPath === path.parse(fsPath).root ? undefined : fsPath;
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
	entries.push({ label: '$(add) Start new DOVO', description: 'spawn a fresh numbered terminal' });
	const pick = await vscode.window.showQuickPick(entries, { placeHolder: 'Switch Dovo terminal' });
	if (!pick) { return; }
	if (pick.label.startsWith('$(add)')) {
		startClaudeInNewTerminal();
		return;
	}
	const m = /(\d+) -- (?:DOVO|MAUT)/.exec(pick.label);
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

	// On extension activation, mark any restored "N -- DOVO" terminals as CLOSED until a
	// shell-execution event proves them alive again.
	void markRestoredTerminalsClosed();
}

async function markRestoredTerminalsClosed(): Promise<void> {
	// Defer to give VS Code time to restore terminal tabs.
	await new Promise(r => setTimeout(r, 1500));
	for (const t of vscode.window.terminals) {
		if (!/^\d+ -- (?:DOVO|MAUT)$/.test(t.name)) { continue; }
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
	const sessionReader = new ClaudeSessionReader();
	registerClaudeLaunch(context);
	context.subscriptions.push(
		vscode.commands.registerCommand('_maut.claudeImages.resolve', (shellPid: number | undefined, index: number) => imageResolver.resolve(shellPid, index)),
		vscode.commands.registerCommand('_maut.claudeImages.captureClipboard', (shellPid: number | undefined, index: number) => imageResolver.captureClipboard(shellPid, index)),
		// The conversation of the Claude session in a terminal, for the workbench's Reader view.
		vscode.commands.registerCommand('_maut.claude.session', (shellPid: number | undefined) => sessionReader.read(shellPid)),
		vscode.commands.registerCommand('_maut.claude.agent', (shellPid: number | undefined, agentId: string) => sessionReader.readAgent(shellPid, agentId)),
		vscode.commands.registerCommand('_maut.claude.install', () => installClaude()),
		vscode.commands.registerCommand('_maut.claude.check', () => claudeStatus()),
		vscode.commands.registerCommand('_maut.git.original', (fsPath: string) => gitOriginal(fsPath)),
		vscode.commands.registerCommand('_maut.files.changed', (cwd: string) => sessionReader.changedFiles(cwd)),
		vscode.commands.registerCommand('_maut.claude.stopShell', (shellPid: number | undefined, taskId: string) => sessionReader.stopShell(shellPid, taskId)),
		// Running Claude sessions by folder, for the workbench's project dock.
		vscode.commands.registerCommand('_maut.claude.statuses', () => runningClaudeSessions()),
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

	// A restored "N -- DOVO" tab is just a fresh shell with its old output replayed, so decide on
	// whether Claude is actually running, not on tab names. Only in a real project folder.
	const folder = projectFolder();
	if (autoLaunch && folder) {
		setTimeout(async () => {
			await untilWelcomeDone();
			if (await isClaudeRunningHere()) {
				reportStartup('skip');
				return;
			}
			const missing = await claudeMissing();
			if (missing) {
				reportStartup('failed', missing);
				return;
			}
			// Continue only when there is a conversation here to continue: no waiting to find out.
			const resume = autoResume && hasConversation(folder);
			reportStartup(resume ? 'resuming' : 'starting');
			startClaudeInNewTerminal({ autoResume: resume });
			if (autoFocus) {
				setTimeout(() => {
					void vscode.commands.executeCommand('maut.focus.toggleTerminal').then(undefined, () => { /* noop */ });
				}, 250);
			}
		}, 150);
	} else {
		reportStartup('skip');
	}
}

export function deactivate(): void { /* noop */ }

/** Folder and status (`busy` / `idle`) of every Claude Code process that is still running. */
function runningClaudeSessions(): { cwd: string; status: string }[] {
	return readSessionRecords().filter(record => {
		try {
			process.kill(record.pid, 0);
			return !!record.cwd;
		} catch {
			return false;
		}
	}).map(record => ({ cwd: record.cwd!, status: record.status ?? 'idle' }));
}
