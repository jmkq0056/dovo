/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shares Dovo's integrated terminals (the Claude panes included) with Dovo Remote Host, so the
// phone's Terminals list shows them and can open them. Dovo connects to the host's Unix socket
// ~/.dovo/remote-host.sock and speaks newline-delimited JSON (see CONTRACT-dovo-terminals.md in
// dovo-remote). Output streams only for terminals a phone has open; the list gets a short preview
// and a state (running, idle, needs you). The terminals still belong to Dovo: they end when Dovo
// quits. Only tmux keeps a terminal alive after that.
//
// What a terminal shows comes from the workbench, which has its screen: whether Claude runs there
// and asks something, and the screen itself (with its scrollback) when a phone opens it. Outside
// Dovo's own workbench (no such commands) the raw output kept here stands in.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';

const FOLDER = path.join(os.homedir(), '.dovo');
const SOCKET_NAME = 'remote-host.sock';
const SOCKET = path.join(FOLDER, SOCKET_NAME);
const SETTING = 'dovo.remote.shareTerminals';
/** Raw output kept per terminal: the replay when the workbench can't draw the screen. */
const RING_BYTES = 256 * 1024;
/** Largest replay sent to the host. */
const REPLAY_BYTES = 256 * 1024;
/** How often the list's preview and state are refreshed (at most once per terminal per period). */
const UPDATE_EVERY = 1500;
/** After quiet output, the first new output refreshes this soon instead of waiting for the next tick. */
const WAKE_AFTER = 250;
/** No output for this long: idle. */
const IDLE_AFTER = 4000;
/** Reconnecting waits this long at first, doubling up to {@link RETRY_LONGEST} while the host is down. */
const RETRY_FIRST = 500;
const RETRY_LONGEST = 5000;
/** The host stopped reading: more than this waiting to be written drops the connection (and reconnects). */
const BACKLOG_LIMIT = 16 * 1024 * 1024;
/** From the workbench (terminal.maut.remoteShare.contribution.ts). */
const STATES_COMMAND = '_dovo.remote.terminalStates';
const SNAPSHOT_COMMAND = '_dovo.remote.terminalSnapshot';
/** Dovo's own Claude tabs: "Agent 2", or "2 -- DOVO" / "2 -- MAUT" restored from older versions. */
const agentNameRegex = /^(?:Agent \d+|\d+ -- (?:DOVO|MAUT))$/;
/** Programs that run Claude Code as a script: `node /path/to/claude`, `bun .../cli.js`. */
const runtimeRegex = /^(?:node|bun|deno|npx|bunx|tsx)$/;

type Kind = 'claude' | 'shell';
type State = 'needsYou' | 'running' | 'idle';

interface ISharedTerminal {
	readonly id: string;
	readonly terminal: vscode.Terminal;
	readonly created: number;
	/** Turns the phone's bytes into text; keeps a character split across two messages whole. */
	readonly decoder: StringDecoder;
	ring: string[];
	ringBytes: number;
	/** Output was dropped from the front of {@link ring}. */
	truncated: boolean;
	lastActive: number;
	kind: Kind;
	state: State;
	preview: string[];
	cols: number;
	rows: number;
	/** A phone has it open: output streams. */
	attached: boolean;
	/** A replay is being prepared (its number); output until then is in the replay. */
	attaching: number;
	/** What the list last got, to send only changes, and when. */
	sent: string;
	sentAt: number;
}

/** Host to Dovo. */
interface IHostMessage {
	readonly t: 'attach' | 'detach' | 'input' | 'focus' | 'kill';
	readonly id: string;
	readonly b64?: string;
}

/** What the workbench reads off a terminal's screen. */
interface IScreenState {
	readonly processId: number;
	readonly claude: boolean;
	readonly needsYou: boolean;
	readonly working: boolean;
	readonly preview: string[];
}

interface IScreenSnapshot {
	readonly data: string;
	readonly cols: number;
	readonly rows: number;
}

const ansiRegex = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][\w]|\x1b[=>78]/g;

/** What a terminal's last output says to a reader: plain lines, escape codes and carriage returns gone. */
function plainLines(text: string): string[] {
	return text.replace(ansiRegex, '').split(/\r?\n/).map(line => line.split('\r').pop() ?? '').map(line => line.trimEnd()).filter(line => line.trim());
}

/** Whether a command line runs Claude Code: `claude`, a path to it, or a runtime running its script. */
function isClaudeCommand(args: string): boolean {
	const words = args.trim().split(/\s+/);
	const program = path.basename(words[0] ?? '');
	if (program === 'claude' || /(?:^|\/)claude\/versions\//.test(words[0] ?? '')) {
		return true;
	}
	if (!runtimeRegex.test(program)) {
		return false;
	}
	const script = words.slice(1).find(word => !word.startsWith('-'));
	return !!script && (path.basename(script) === 'claude' || script.includes('@anthropic-ai/claude-code'));
}

/** Every process on this Mac by its parent: what runs inside each terminal. */
function processTree(): Promise<Map<number, { readonly pid: number; readonly args: string }[]>> {
	return new Promise(resolve => {
		execFile('/bin/ps', ['-axww', '-o', 'pid=,ppid=,args='], { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (_error, stdout) => {
			const children = new Map<number, { pid: number; args: string }[]>();
			for (const line of (stdout ?? '').split('\n')) {
				const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<args>.*)$/.exec(line);
				if (match?.groups) {
					const ppid = Number(match.groups.ppid);
					const list = children.get(ppid) ?? [];
					list.push({ pid: Number(match.groups.pid), args: match.groups.args });
					children.set(ppid, list);
				}
			}
			resolve(children);
		});
	});
}

/** Whether Claude runs anywhere under `pid` (through wrappers like `clsp`, npx or a nested shell). */
function runsClaude(children: Map<number, { readonly pid: number; readonly args: string }[]>, pid: number): boolean {
	const queue = [pid];
	for (let index = 0; index < queue.length && index < 200; index++) {
		for (const child of children.get(queue[index]) ?? []) {
			if (isClaudeCommand(child.args)) {
				return true;
			}
			queue.push(child.pid);
		}
	}
	return false;
}

/** The workbench's command, or undefined when this isn't Dovo's workbench (or it failed). */
async function workbench<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
	try {
		return await vscode.commands.executeCommand<T>(command, ...args);
	} catch {
		return undefined;
	}
}

class TerminalShare implements vscode.Disposable {

	private readonly terminals = new Map<vscode.Terminal, ISharedTerminal>();
	private readonly byId = new Map<string, ISharedTerminal>();
	private readonly disposables: vscode.Disposable[] = [];
	/** The live connection, once connected. */
	private socket: net.Socket | undefined;
	/** A connection being made. */
	private connecting: net.Socket | undefined;
	private received = '';
	private retry: NodeJS.Timeout | undefined;
	private retryDelay = RETRY_FIRST;
	private watcher: fs.FSWatcher | undefined;
	private ticker: NodeJS.Timeout | undefined;
	private wake: NodeJS.Timeout | undefined;
	private refreshing = false;
	private next = 1;
	private attachments = 0;
	private disposed = false;

	constructor() {
		for (const terminal of vscode.window.terminals) {
			this.add(terminal, false);
		}
		this.disposables.push(
			vscode.window.onDidOpenTerminal(terminal => this.add(terminal, true)),
			vscode.window.onDidCloseTerminal(terminal => this.remove(terminal)),
			vscode.window.onDidWriteTerminalData(event => this.write(event.terminal, event.data)),
			vscode.window.onDidChangeTerminalDimensions(event => {
				const shared = this.terminals.get(event.terminal);
				if (shared && (shared.cols !== event.dimensions.columns || shared.rows !== event.dimensions.rows)) {
					shared.cols = event.dimensions.columns;
					shared.rows = event.dimensions.rows;
					this.send({ t: 'update', id: shared.id, cols: shared.cols, rows: shared.rows });
				}
			}),
		);
		this.watch();
		this.connect();
		this.ticker = setInterval(() => void this.refresh(), UPDATE_EVERY);
	}

	private add(terminal: vscode.Terminal, fresh: boolean): void {
		if (this.terminals.has(terminal) || (terminal.creationOptions as vscode.TerminalOptions).hideFromUser) {
			return;
		}
		const shared: ISharedTerminal = {
			id: `dovo-${process.pid}-${this.next++}`,
			terminal,
			created: Math.floor(Date.now() / 1000),
			decoder: new StringDecoder('utf8'),
			ring: [],
			ringBytes: 0,
			// A terminal from before Dovo Remote started watching has output this ring never saw.
			truncated: !fresh,
			lastActive: Date.now(),
			kind: agentNameRegex.test(terminal.name) || /\bclaude\b/i.test(terminal.name) ? 'claude' : 'shell',
			state: 'idle',
			preview: [],
			cols: terminal.dimensions?.columns ?? 80,
			rows: terminal.dimensions?.rows ?? 24,
			attached: false,
			attaching: 0,
			sent: '',
			sentAt: 0,
		};
		this.terminals.set(terminal, shared);
		this.byId.set(shared.id, shared);
		this.open(shared);
		this.wakeSoon();
	}

	private remove(terminal: vscode.Terminal): void {
		const shared = this.terminals.get(terminal);
		if (!shared) {
			return;
		}
		this.terminals.delete(terminal);
		this.byId.delete(shared.id);
		this.send({ t: 'close', id: shared.id, code: terminal.exitStatus?.code ?? null });
	}

	private write(terminal: vscode.Terminal, data: string): void {
		const shared = this.terminals.get(terminal);
		if (!shared) {
			return;
		}
		shared.ring.push(data);
		shared.ringBytes += data.length;
		while (shared.ringBytes > RING_BYTES && shared.ring.length > 1) {
			shared.ringBytes -= shared.ring.shift()!.length;
			shared.truncated = true;
		}
		shared.lastActive = Date.now();
		if (shared.attached) {
			this.send({ t: 'data', id: shared.id, b64: Buffer.from(data, 'utf8').toString('base64') });
		}
		if (shared.state === 'idle') {
			this.wakeSoon();
		}
	}

	/** Refreshes the list shortly, so a terminal that starts working shows it within a moment. */
	private wakeSoon(): void {
		if (!this.wake) {
			this.wake = setTimeout(() => {
				this.wake = undefined;
				void this.refresh();
			}, WAKE_AFTER);
		}
	}

	private open(shared: ISharedTerminal): void {
		const message = this.describe(shared, 'open');
		shared.sent = this.key(message);
		shared.sentAt = Date.now();
		this.send(message);
	}

	/** The list entry for a terminal: name, folder, kind, size, state and a two-line preview. */
	private describe(shared: ISharedTerminal, t: 'open' | 'update'): Record<string, unknown> {
		const options = shared.terminal.creationOptions as vscode.TerminalOptions;
		const cwd = shared.terminal.shellIntegration?.cwd?.fsPath
			?? (typeof options.cwd === 'string' ? options.cwd : options.cwd?.fsPath)
			?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
			?? os.homedir();
		const home = os.homedir();
		return {
			t,
			id: shared.id,
			name: shared.terminal.name,
			cwd: cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd,
			kind: shared.kind,
			rc: /Remote Control (?:active|connected|is on)/i.test(this.tail(shared)),
			state: shared.state,
			cols: shared.cols,
			rows: shared.rows,
			created: shared.created,
			lastActive: Math.floor(shared.lastActive / 1000),
			preview: shared.preview,
		};
	}

	/** What decides whether the list needs an update: everything but the time of the last output. */
	private key(message: Record<string, unknown>): string {
		return JSON.stringify({ ...message, t: '', lastActive: 0 });
	}

	private tail(shared: ISharedTerminal): string {
		return shared.ring.slice(-40).join('').slice(-6000);
	}

	/** Re-checks what runs in each terminal and what it shows, and sends what changed (with `announce`). */
	private async refresh(announce = true): Promise<void> {
		if (this.refreshing || !this.socket || !this.terminals.size) {
			return;
		}
		this.refreshing = true;
		try {
			const [screens, children] = await Promise.all([
				workbench<IScreenState[]>(STATES_COMMAND),
				processTree(),
			]);
			const byProcess = new Map((screens ?? []).map(screen => [screen.processId, screen]));
			for (const shared of [...this.terminals.values()]) {
				const pid = await shared.terminal.processId;
				const screen = pid ? byProcess.get(pid) : undefined;
				const claude = !!screen?.claude || (!!pid && runsClaude(children, pid)) || agentNameRegex.test(shared.terminal.name);
				shared.kind = claude ? 'claude' : 'shell';
				const recent = Date.now() - shared.lastActive < IDLE_AFTER;
				if (screen) {
					// Claude redraws while you type; only its own footer and spinner say it's working.
					shared.state = screen.needsYou ? 'needsYou' : (claude ? screen.working : recent) ? 'running' : 'idle';
					shared.preview = screen.preview;
				} else {
					const tail = this.tail(shared);
					const plain = tail.replace(ansiRegex, '');
					const lines = plainLines(tail);
					const asking = Math.max(plain.lastIndexOf('Esc to cancel'), [...plain.matchAll(/\u276f\s*1\.\s/g)].pop()?.index ?? -1);
					const needsYou = claude && asking >= 0 && asking > plain.lastIndexOf('esc to interrupt');
					shared.state = needsYou ? 'needsYou' : recent ? 'running' : 'idle';
					shared.preview = lines.slice(-2);
				}
				if (!announce || !this.byId.has(shared.id)) {
					continue;
				}
				const update = this.describe(shared, 'update');
				const key = this.key(update);
				if (key !== shared.sent && Date.now() - shared.sentAt >= UPDATE_EVERY - 100) {
					shared.sent = key;
					shared.sentAt = Date.now();
					this.send(update);
				}
			}
		} finally {
			this.refreshing = false;
		}
	}

	/** A phone opened the terminal: its screen as Dovo shows it, then live output. */
	private async attach(shared: ISharedTerminal): Promise<void> {
		const attaching = ++this.attachments;
		shared.attaching = attaching;
		shared.attached = false;
		const pid = await shared.terminal.processId;
		const snapshot = pid ? await workbench<IScreenSnapshot>(SNAPSHOT_COMMAND, pid, REPLAY_BYTES) : undefined;
		if (shared.attaching !== attaching || this.byId.get(shared.id) !== shared) {
			// Detached, closed or disconnected meanwhile.
			return;
		}
		shared.attaching = 0;
		let data: string;
		if (snapshot) {
			// Output that arrived while the workbench drew the snapshot is part of it.
			data = snapshot.data;
			shared.cols = snapshot.cols;
			shared.rows = snapshot.rows;
		} else {
			data = shared.ring.join('').slice(-REPLAY_BYTES);
			if (shared.truncated) {
				// Start at a line, not inside an escape sequence cut in half.
				data = data.slice(data.indexOf('\n') + 1);
			}
		}
		this.send({ t: 'replay', id: shared.id, cols: shared.cols, rows: shared.rows, b64: Buffer.from(data, 'utf8').toString('base64') });
		shared.attached = true;
	}

	private connect(): void {
		if (this.disposed || this.socket || this.connecting || !this.enabled()) {
			return;
		}
		clearTimeout(this.retry);
		this.retry = undefined;
		const socket = net.createConnection(SOCKET);
		this.connecting = socket;
		socket.setEncoding('utf8');
		socket.once('connect', () => {
			this.connecting = undefined;
			this.socket = socket;
			this.received = '';
			this.retryDelay = RETRY_FIRST;
			this.send({ t: 'hello', app: 'dovo', v: 1, pid: process.pid });
			void this.announce(socket);
		});
		socket.on('data', chunk => this.receive(String(chunk)));
		// 'close' follows every error; reconnecting happens there.
		socket.on('error', () => undefined);
		socket.once('close', () => this.lost(socket));
	}

	/** The host knows nothing after it (or Dovo) restarts: every terminal again, as it is now. */
	private async announce(socket: net.Socket): Promise<void> {
		await this.refresh(false);
		if (this.socket !== socket) {
			return;
		}
		for (const shared of this.terminals.values()) {
			shared.attached = false;
			shared.attaching = 0;
			this.open(shared);
		}
	}

	private lost(socket: net.Socket): void {
		if (this.connecting === socket) {
			this.connecting = undefined;
		}
		if (this.socket === socket) {
			this.socket = undefined;
			for (const shared of this.terminals.values()) {
				shared.attached = false;
				shared.attaching = 0;
			}
		}
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.disposed || this.retry || this.socket || this.connecting || !this.enabled()) {
			return;
		}
		this.retry = setTimeout(() => {
			this.retry = undefined;
			this.connect();
		}, this.retryDelay);
		this.retryDelay = Math.min(this.retryDelay * 2, RETRY_LONGEST);
	}

	/** The host (re)creates its socket when it starts: connect right then instead of at the next retry. */
	private watch(): void {
		try {
			fs.mkdirSync(FOLDER, { recursive: true, mode: 0o700 });
			this.watcher = fs.watch(FOLDER, (_event, name) => {
				if (String(name) === SOCKET_NAME && !this.socket && !this.connecting && this.enabled()) {
					clearTimeout(this.retry);
					this.retry = undefined;
					this.retryDelay = RETRY_FIRST;
					// The file exists a moment before the host listens on it.
					this.scheduleRetry();
				}
			});
			this.watcher.on('error', () => {
				this.watcher?.close();
				this.watcher = undefined;
			});
		} catch {
			// Retrying on a timer still finds the host.
		}
	}

	private receive(chunk: string): void {
		this.received += chunk;
		let newline: number;
		while ((newline = this.received.indexOf('\n')) >= 0) {
			const line = this.received.slice(0, newline);
			this.received = this.received.slice(newline + 1);
			let message: IHostMessage;
			try {
				message = JSON.parse(line) as IHostMessage;
			} catch {
				continue;
			}
			const shared = this.byId.get(message.id);
			if (!shared) {
				continue;
			}
			switch (message.t) {
				case 'attach':
					void this.attach(shared);
					break;
				case 'detach':
					shared.attached = false;
					shared.attaching = 0;
					break;
				case 'input':
					if (message.b64) {
						// As typed: Claude echoes it into its prompt box, which Dovo's Reader shows as its input.
						const text = shared.decoder.write(Buffer.from(message.b64, 'base64'));
						if (text) {
							shared.terminal.sendText(text, false);
						}
					}
					break;
				case 'focus':
					shared.terminal.show(false);
					break;
				case 'kill':
					shared.terminal.dispose();
					break;
			}
		}
	}

	private send(message: Record<string, unknown>): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			return;
		}
		if (socket.writableLength > BACKLOG_LIMIT) {
			// The host stopped reading. Start over: reconnecting sends everything afresh.
			socket.destroy();
			return;
		}
		socket.write(`${JSON.stringify(message)}\n`);
	}

	private enabled(): boolean {
		return vscode.workspace.getConfiguration().get<boolean>(SETTING, true);
	}

	/** The setting changed: connect or let go. */
	reconfigure(): void {
		if (this.enabled()) {
			this.retryDelay = RETRY_FIRST;
			this.connect();
		} else {
			clearTimeout(this.retry);
			this.retry = undefined;
			this.connecting?.destroy();
			this.socket?.end();
		}
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.retry);
		clearTimeout(this.wake);
		clearInterval(this.ticker);
		this.watcher?.close();
		this.connecting?.destroy();
		this.socket?.end();
		this.disposables.forEach(disposable => disposable.dispose());
	}
}

/** Shares Dovo's terminals with Dovo Remote Host while `dovo.remote.shareTerminals` is on (macOS only). */
export function registerTerminalShare(context: vscode.ExtensionContext): void {
	if (process.platform !== 'darwin') {
		return;
	}
	const share = new TerminalShare();
	context.subscriptions.push(share, vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(SETTING)) {
			share.reconfigure();
		}
	}));
}
