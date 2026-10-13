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

import { execFile } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const SOCKET = path.join(os.homedir(), '.dovo', 'remote-host.sock');
const SETTING = 'dovo.remote.shareTerminals';
/** Scrollback kept per terminal and replayed when the phone opens it. */
const RING_BYTES = 256 * 1024;
/** How often the list's preview and state are refreshed while a terminal writes. */
const UPDATE_EVERY = 1500;
/** No output for this long: idle. */
const IDLE_AFTER = 4000;
const RETRY_EVERY = 5000;

interface ISharedTerminal {
	readonly id: string;
	readonly terminal: vscode.Terminal;
	readonly created: number;
	ring: string[];
	ringBytes: number;
	lastActive: number;
	kind: 'claude' | 'shell';
	cols: number;
	rows: number;
	attached: boolean;
	sent: string;
}

/** Host to Dovo. */
interface IHostMessage {
	readonly t: 'attach' | 'detach' | 'input' | 'focus' | 'kill';
	readonly id: string;
	readonly b64?: string;
}

const ansiRegex = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][\w]|\x1b[=>78]/g;

/** What a terminal's last output says to a reader: plain lines, escape codes and carriage returns gone. */
function plainLines(text: string): string[] {
	return text.replace(ansiRegex, '').split(/\r?\n/).map(line => line.split('\r').pop() ?? '').map(line => line.trimEnd()).filter(line => line.trim());
}

function childCommands(pid: number): Promise<string> {
	return new Promise(resolve => execFile('/usr/bin/pgrep', ['-lP', String(pid)], { timeout: 2000 }, (_error, stdout) => resolve(stdout ?? '')));
}

class TerminalShare implements vscode.Disposable {

	private readonly terminals = new Map<vscode.Terminal, ISharedTerminal>();
	private readonly byId = new Map<string, ISharedTerminal>();
	private readonly disposables: vscode.Disposable[] = [];
	private socket: net.Socket | undefined;
	private received = '';
	private retry: NodeJS.Timeout | undefined;
	private ticker: NodeJS.Timeout | undefined;
	private next = 1;
	private disposed = false;

	constructor() {
		for (const terminal of vscode.window.terminals) {
			this.add(terminal);
		}
		this.disposables.push(
			vscode.window.onDidOpenTerminal(terminal => this.add(terminal)),
			vscode.window.onDidCloseTerminal(terminal => this.remove(terminal)),
			vscode.window.onDidWriteTerminalData(event => this.write(event.terminal, event.data)),
			vscode.window.onDidChangeTerminalDimensions(event => {
				const shared = this.terminals.get(event.terminal);
				if (shared) {
					shared.cols = event.dimensions.columns;
					shared.rows = event.dimensions.rows;
					this.send({ t: 'update', id: shared.id, cols: shared.cols, rows: shared.rows });
				}
			}),
		);
		this.connect();
		this.ticker = setInterval(() => void this.refresh(), UPDATE_EVERY);
	}

	private add(terminal: vscode.Terminal): void {
		if (this.terminals.has(terminal)) {
			return;
		}
		const shared: ISharedTerminal = {
			id: `dovo-${process.pid}-${this.next++}`,
			terminal,
			created: Math.floor(Date.now() / 1000),
			ring: [],
			ringBytes: 0,
			lastActive: Date.now(),
			kind: /claude|agent/i.test(terminal.name) ? 'claude' : 'shell',
			cols: terminal.dimensions?.columns ?? 80,
			rows: terminal.dimensions?.rows ?? 24,
			attached: false,
			sent: '',
		};
		this.terminals.set(terminal, shared);
		this.byId.set(shared.id, shared);
		this.send(this.describe(shared, 'open'));
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
		}
		shared.lastActive = Date.now();
		if (shared.attached) {
			this.send({ t: 'data', id: shared.id, b64: Buffer.from(data, 'utf8').toString('base64') });
		}
	}

	/** The list entry for a terminal: name, folder, kind, size, state and a two-line preview. */
	private describe(shared: ISharedTerminal, t: 'open' | 'update'): Record<string, unknown> {
		const tail = shared.ring.slice(-40).join('').slice(-6000);
		const lines = plainLines(tail);
		const needsYou = /Esc to cancel/i.test(tail.replace(ansiRegex, '')) || /^\s*\u276f?\s*1\.\s/m.test(lines.slice(-8).join('\n'));
		const cwd = shared.terminal.shellIntegration?.cwd?.fsPath
			?? (shared.terminal.creationOptions as vscode.TerminalOptions).cwd?.toString()
			?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
			?? os.homedir();
		return {
			t,
			id: shared.id,
			name: shared.terminal.name,
			cwd: cwd.replace(os.homedir(), '~'),
			kind: shared.kind,
			rc: /Remote Control (?:active|connected|is on)/i.test(tail),
			state: needsYou ? 'needsYou' : Date.now() - shared.lastActive < IDLE_AFTER ? 'running' : 'idle',
			cols: shared.cols,
			rows: shared.rows,
			created: shared.created,
			lastActive: Math.floor(shared.lastActive / 1000),
			preview: lines.slice(-2),
		};
	}

	/** Re-checks what runs in each terminal and sends what changed. */
	private async refresh(): Promise<void> {
		for (const shared of this.terminals.values()) {
			const pid = await shared.terminal.processId;
			if (pid) {
				const children = await childCommands(pid);
				shared.kind = /\bclaude\b/i.test(children) || /claude|agent/i.test(shared.terminal.name) ? 'claude' : 'shell';
			}
			const update = this.describe(shared, 'update');
			const key = JSON.stringify({ ...update, lastActive: 0 });
			if (key !== shared.sent) {
				shared.sent = key;
				this.send(update);
			}
		}
	}

	private connect(): void {
		if (this.disposed || !vscode.workspace.getConfiguration().get<boolean>(SETTING, true)) {
			return;
		}
		const socket = net.createConnection(SOCKET);
		socket.setEncoding('utf8');
		socket.once('connect', () => {
			this.socket = socket;
			this.received = '';
			this.send({ t: 'hello', app: 'dovo', v: 1, pid: process.pid });
			for (const shared of this.terminals.values()) {
				shared.attached = false;
				shared.sent = '';
				this.send(this.describe(shared, 'open'));
			}
		});
		socket.on('data', chunk => this.receive(String(chunk)));
		const lost = () => {
			if (this.socket === socket) {
				this.socket = undefined;
			}
			socket.destroy();
			if (!this.disposed && !this.retry) {
				this.retry = setTimeout(() => {
					this.retry = undefined;
					this.connect();
				}, RETRY_EVERY);
			}
		};
		socket.once('error', lost);
		socket.once('close', lost);
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
					shared.attached = true;
					this.send({ t: 'replay', id: shared.id, cols: shared.cols, rows: shared.rows, b64: Buffer.from(shared.ring.join(''), 'utf8').toString('base64') });
					break;
				case 'detach':
					shared.attached = false;
					break;
				case 'input':
					if (message.b64) {
						shared.terminal.sendText(Buffer.from(message.b64, 'base64').toString('utf8'), false);
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
		if (this.socket && !this.socket.destroyed) {
			this.socket.write(`${JSON.stringify(message)}\n`);
		}
	}

	/** The setting changed: connect or let go. */
	reconfigure(): void {
		if (vscode.workspace.getConfiguration().get<boolean>(SETTING, true)) {
			if (!this.socket && !this.retry) {
				this.connect();
			}
		} else {
			this.socket?.end();
			this.socket = undefined;
		}
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.retry);
		clearInterval(this.ticker);
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
