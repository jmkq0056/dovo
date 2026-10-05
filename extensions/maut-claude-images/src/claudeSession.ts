/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Maut: the conversation of the Claude Code session running in a terminal, as chat turns for
 *  the workbench's Reader view. Read incrementally from the session transcript
 *  (`~/.claude/projects/<project>/<session>.jsonl`); image data is dropped while parsing so a long
 *  session with many screenshots stays small.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { readTranscriptLines } from './transcriptLines';
import { findSessionId, findTranscript, readSessionRecords } from './claudeImageResolver';

/** A piece of Claude's reply. */
export type ClaudeItem =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'step'; readonly verb: string; readonly target: string; readonly file?: string }
	| { readonly kind: 'edit'; readonly file: string; readonly added: number; readonly removed: number; readonly lines: readonly (readonly ['a' | 'd', string])[]; readonly isNew: boolean }
	/** A message you sent while Claude worked, which it took in mid-turn. */
	| { readonly kind: 'user'; readonly text: string; readonly images: number[] }
	/** You stopped Claude (Esc). */
	| { readonly kind: 'interrupted' };

export interface ClaudeTurn {
	readonly prompt: string;
	/** `[Image #N]` numbers attached to the prompt. */
	readonly images: number[];
	readonly time: number;
	/** Time of the last entry in this turn. */
	end: number;
	readonly items: ClaudeItem[];
}

export interface ClaudeSessionView {
	readonly sessionId: string;
	readonly project: string;
	readonly model: string | undefined;
	/** Tokens in Claude's context after its last reply; what `/context` reports, within one reply. */
	readonly contextTokens: number | undefined;
	/** The context window: from the latest `/context` report, else known for the model. */
	readonly contextWindow: number | undefined;
	/** From the latest `/context` run in this session: Claude's own count. */
	readonly contextReport: { readonly used: string; readonly window: string; readonly percent: number; readonly time: number } | undefined;
	/** `working` (Claude is busy), `idle` (waiting for you). */
	readonly status: 'working' | 'idle';
	readonly turns: readonly ClaudeTurn[];
	/**
	 * Per turn (same order as `turns`): files in the project's git repo that are changed or new and
	 * were last written during that turn. Claude often edits through shell commands, which no
	 * transcript entry records as an edit.
	 */
	readonly changedFiles: readonly (readonly IChangedFile[])[];
	/** Background shells and agents Claude started in this session, newest first. */
	readonly tasks: readonly IClaudeTask[];
}

/** A background shell or an agent that Claude started. */
export interface IClaudeTask {
	readonly id: string;
	readonly kind: 'shell' | 'agent';
	/** Claude's description of it ("Build the macOS app"), else the command or prompt. */
	readonly title: string;
	readonly command?: string;
	readonly agentType?: string;
	readonly outputFile?: string;
	readonly status: 'running' | 'completed' | 'failed' | 'killed';
	readonly start: number;
	readonly end?: number;
	readonly summary?: string;
	/** The last lines a running shell printed. */
	readonly tail?: string;
}

export interface IChangedFile {
	readonly path: string;
	/** Relative to the project folder, for display. */
	readonly label: string;
	readonly isNew: boolean;
}

interface IContentBlock {
	readonly type?: string;
	readonly id?: string;
	readonly tool_use_id?: string;
	readonly content?: unknown;
	readonly text?: string;
	readonly name?: string;
	readonly input?: Record<string, unknown>;
}

interface ITranscriptEntry {
	readonly type?: string;
	readonly isSidechain?: boolean;
	readonly isMeta?: boolean;
	readonly origin?: { readonly kind?: string };
	readonly timestamp?: string;
	readonly cwd?: string;
	readonly imagePasteIds?: number[];
	readonly attachment?: { readonly type?: string; readonly prompt?: string | IContentBlock[] };
	/** A queue operation's message. */
	readonly content?: string;
	readonly toolUseResult?: { readonly backgroundTaskId?: string; readonly agentId?: string; readonly status?: string };
	readonly message?: {
		readonly model?: string;
		readonly content?: string | IContentBlock[];
		readonly usage?: { readonly input_tokens?: number; readonly cache_read_input_tokens?: number; readonly cache_creation_input_tokens?: number };
	};
}

interface ISessionState {
	readonly transcript: string;
	offset: number;
	partial: string;
	readonly turns: ClaudeTurn[];
	model: string | undefined;
	contextTokens: number | undefined;
	contextReport: { used: string; window: string; percent: number; time: number } | undefined;
	cwd: string | undefined;
	/** Background shell and agent calls, by tool-use id, until their result names the task. */
	readonly pendingTasks: Map<string, { readonly name: string; readonly input: Record<string, unknown> }>;
	readonly tasks: Map<string, IClaudeTask>;
	/** Agent transcripts are sidechains; the main conversation skips them. */
	readonly sidechain: boolean;
}

const maxDiffLines = 40;
/** Tools whose calls are bookkeeping, not something worth showing. */
const hiddenTools = new Set(['TodoWrite', 'ToolSearch', 'ExitPlanMode', 'EnterPlanMode']);

export class ClaudeSessionReader {
	private readonly _sessions = new Map<string, ISessionState>();
	private readonly _agents = new Map<string, ISessionState>();
	private readonly _gitCache = new Map<string, { time: number; files: Promise<{ path: string; isNew: boolean; mtime: number }[]> }>();

	async read(shellPid: number | undefined, maxTurns = 60): Promise<ClaudeSessionView | undefined> {
		const sessionId = await findSessionId(shellPid);
		if (!sessionId) {
			return undefined;
		}
		const state = this._getState(sessionId);
		if (!state) {
			return undefined;
		}
		await this._readNewLines(state);
		const record = readSessionRecords().find(r => r.sessionId === sessionId);
		const turns = state.turns.slice(-maxTurns);
		const status = record?.status === 'idle' ? 'idle' : 'working';
		const project = record?.cwd ?? state.cwd;
		return {
			sessionId,
			// The folder Claude started in; the transcript's cwd follows every `cd` Claude runs.
			project: path.basename(record?.cwd ?? state.cwd ?? ''),
			model: state.model,
			contextTokens: state.contextTokens,
			contextWindow: parseTokenCount(state.contextReport?.window) ?? windowForModel(state.model),
			contextReport: state.contextReport,
			status,
			turns,
			changedFiles: project ? await this._changedFiles(project, turns, status === 'working') : turns.map(() => []),
			tasks: await this._taskView(state, record?.pid),
		};
	}

	/** An agent's own conversation, from its transcript next to the session's. */
	async readAgent(shellPid: number | undefined, agentId: string): Promise<{ readonly turns: readonly ClaudeTurn[] } | undefined> {
		const sessionId = await findSessionId(shellPid);
		const main = sessionId ? this._getState(sessionId) : undefined;
		if (!main || !/^[\w-]+$/.test(agentId)) {
			return undefined;
		}
		const transcript = path.join(main.transcript.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
		let state = this._agents.get(transcript);
		if (!state) {
			state = newState(transcript, true);
			this._agents.set(transcript, state);
		}
		await this._readNewLines(state);
		return { turns: state.turns };
	}

	/** Stops a background shell: its process group, found under Claude's process by its command. */
	async stopShell(shellPid: number | undefined, taskId: string): Promise<boolean> {
		const sessionId = await findSessionId(shellPid);
		const state = sessionId ? this._getState(sessionId) : undefined;
		const command = state?.tasks.get(taskId)?.command;
		const record = readSessionRecords().find(r => r.sessionId === sessionId);
		if (!command || !record) {
			return false;
		}
		const group = (await shellProcesses(record.pid)).find(p => p.command.includes(quotedForEval(command)))?.pgid;
		if (!group) {
			return false;
		}
		try {
			process.kill(-group, 'SIGTERM');
			return true;
		} catch {
			return false;
		}
	}

	private _trackTasks(state: ISessionState, entry: ITranscriptEntry, time: number): void {
		const content = entry.message?.content;
		if (entry.type === 'assistant' && Array.isArray(content)) {
			for (const block of content) {
				const input = block.input ?? {};
				if (block.type === 'tool_use' && block.id && ((block.name === 'Bash' && input.run_in_background) || block.name === 'Agent' || block.name === 'Task')) {
					state.pendingTasks.set(block.id, { name: block.name, input });
				}
			}
			return;
		}
		if (entry.type === 'attachment' || entry.type === 'queue-operation') {
			// Task notifications Claude took in mid-turn arrive queued, not as their own message.
			const prompt = entry.attachment?.prompt;
			this._applyNotifications(state, entry.type === 'queue-operation' ? entry.content ?? '' : typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? prompt.map(b => b.text ?? '').join('') : '', time);
			return;
		}
		if (entry.type !== 'user') {
			return;
		}
		const result = entry.toolUseResult;
		const useId = Array.isArray(content) ? content.find(b => b.type === 'tool_result')?.tool_use_id : undefined;
		const call = useId ? state.pendingTasks.get(useId) : undefined;
		if (useId && call && result) {
			state.pendingTasks.delete(useId);
			const str = (key: string) => typeof call.input[key] === 'string' ? call.input[key] as string : '';
			if (call.name === 'Bash' && result.backgroundTaskId) {
				state.tasks.set(result.backgroundTaskId, {
					id: result.backgroundTaskId, kind: 'shell', title: firstLine(str('description') || str('command')), command: str('command'),
					outputFile: outputFileFrom(content), status: 'running', start: time,
				});
			} else if (call.name !== 'Bash' && result.agentId) {
				const running = result.status === 'async_launched';
				state.tasks.set(result.agentId, {
					id: result.agentId, kind: 'agent', title: str('description') || firstLine(str('prompt')), agentType: str('subagent_type') || 'general-purpose',
					status: running ? 'running' : 'completed', start: time, end: running ? undefined : time,
				});
			}
		}
		this._applyNotifications(state, typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => b.type === 'text' ? b.text ?? '' : '').join('') : '', time);
	}

	/** Claude is told when a task ends: a <task-notification> with its id and status. */
	private _applyNotifications(state: ISessionState, text: string, time: number): void {
		for (const match of text.matchAll(/<task-notification>(?<body>[\s\S]*?)<\/task-notification>/g)) {
			const body = match.groups?.body ?? '';
			const id = /<task-id>(?<v>[^<]+)<\/task-id>/.exec(body)?.groups?.v;
			const status = /<status>(?<v>[^<]+)<\/status>/.exec(body)?.groups?.v;
			const task = id ? state.tasks.get(id) : undefined;
			if (task && status) {
				state.tasks.set(task.id, {
					...task,
					status: status === 'completed' ? 'completed' : status === 'killed' ? 'killed' : status === 'failed' ? 'failed' : task.status,
					end: time,
					summary: /<summary>(?<v>[\s\S]*?)<\/summary>/.exec(body)?.groups?.v?.trim(),
				});
			}
		}
	}

	private async _taskView(state: ISessionState, claudePid: number | undefined): Promise<IClaudeTask[]> {
		const tasks = [...state.tasks.values()].sort((a, b) => b.start - a.start).slice(0, 40);
		const running = tasks.some(task => task.kind === 'shell' && task.status === 'running');
		const processes = running && claudePid ? await shellProcesses(claudePid) : [];
		return Promise.all(tasks.map(async task => {
			if (task.kind !== 'shell' || task.status !== 'running') {
				return task;
			}
			// A shell is only still running if its process is: a restarted Claude leaves none behind.
			// (Windows has no process list to check, so there Claude's own notifications decide.)
			const alive = process.platform === 'win32' || (!!task.command && processes.some(p => p.command.includes(quotedForEval(task.command!))));
			return alive ? { ...task, tail: await tailOf(task.outputFile) } : { ...task, status: 'completed' as const };
		}));
	}

	private async _changedFiles(project: string, turns: readonly ClaudeTurn[], working: boolean): Promise<IChangedFile[][]> {
		const files = await this._gitChanges(project);
		const now = Date.now();
		return turns.map((turn, index) => {
			const next = turns[index + 1];
			// A turn runs until the next prompt; the last one until now while Claude still works.
			const end = next ? next.time : working ? now : turn.end + 10_000;
			const shown = new Set(turn.items.flatMap(item => item.kind === 'edit' ? [item.file] : []));
			return files
				.filter(file => file.mtime >= turn.time - 1000 && file.mtime <= end && !shown.has(path.relative(project, file.path)) && !shown.has(file.path))
				.map(file => ({ path: file.path, label: path.relative(project, file.path), isNew: file.isNew }));
		});
	}

	/** Files changed or new in the repo at `cwd`, most recently written first (for the finder). */
	async changedFiles(cwd: string): Promise<{ path: string; isNew: boolean; mtime: number }[]> {
		return (await this._gitChanges(cwd)).sort((a, b) => b.mtime - a.mtime).slice(0, 50);
	}

	/** Changed and untracked files of the repo at `cwd`, with their modification times; cached briefly. */
	private _gitChanges(cwd: string): Promise<{ path: string; isNew: boolean; mtime: number }[]> {
		const cached = this._gitCache.get(cwd);
		if (cached && Date.now() - cached.time < 3000) {
			return cached.files;
		}
		const files = new Promise<{ path: string; isNew: boolean; mtime: number }[]>(resolve => {
			cp.execFile('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, async (error, stdout) => {
				if (error) {
					resolve([]);
					return;
				}
				const root = await new Promise<string>(done => cp.execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 2000 }, (e, out) => done(e ? cwd : out.trim())));
				const entries = stdout.split('\0').filter(Boolean).slice(0, 2000);
				const result: { path: string; isNew: boolean; mtime: number }[] = [];
				for (const entry of entries) {
					const code = entry.slice(0, 2);
					if (code.includes('D') || code.includes('R')) {
						continue;
					}
					const file = path.join(root, entry.slice(3));
					try {
						const stat = await fs.promises.stat(file);
						if (stat.isFile()) {
							result.push({ path: file, isNew: code === '??' || code.includes('A'), mtime: stat.mtimeMs });
						}
					} catch {
						// gone meanwhile
					}
				}
				resolve(result);
			});
		});
		this._gitCache.set(cwd, { time: Date.now(), files });
		return files;
	}

	private _getState(sessionId: string): ISessionState | undefined {
		let state = this._sessions.get(sessionId);
		if (!state) {
			const transcript = findTranscript(sessionId);
			if (!transcript) {
				return undefined;
			}
			state = newState(transcript, false);
			this._sessions.set(sessionId, state);
		}
		return state;
	}

	private async _readNewLines(state: ISessionState): Promise<void> {
		let size: number;
		try {
			size = (await fs.promises.stat(state.transcript)).size;
		} catch {
			return;
		}
		if (size < state.offset) {
			state.offset = 0;
			state.partial = '';
			state.turns.length = 0;
		}
		if (size === state.offset) {
			return;
		}
		const position = await readTranscriptLines(state.transcript, state, size, line => {
			if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"queued_command"') && !line.includes('task-notification')) {
				return;
			}
			let entry: ITranscriptEntry;
			try {
				// Images aren't needed here; dropping their base64 keeps parsing cheap.
				entry = JSON.parse(line.length > 50_000 ? line.replace(/"data":"[A-Za-z0-9+/=]{1000,}"/g, '"data":""') : line);
			} catch {
				return;
			}
			this._apply(state, entry);
		});
		state.offset = position.offset;
		state.partial = position.partial;
	}

	private _apply(state: ISessionState, entry: ITranscriptEntry): void {
		if (entry.isSidechain && !state.sidechain) {
			return;
		}
		const time = Date.parse(entry.timestamp ?? '') || 0;
		this._trackTasks(state, entry, time);
		if (entry.cwd) {
			state.cwd = entry.cwd;
		}
		if (entry.type === 'attachment') {
			// A message you queued that Claude read without ending its turn.
			const turn = state.turns.at(-1);
			const prompt = entry.attachment?.type === 'queued_command' ? entry.attachment.prompt : undefined;
			const text = typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? prompt.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : undefined;
			const cleaned = text === undefined ? undefined : cleanPrompt(text);
			if (turn && cleaned !== undefined) {
				turn.end = time;
				turn.items.push({ kind: 'user', text: cleaned, images: imageNumbers(cleaned) });
			}
			return;
		}
		if (entry.type === 'user') {
			if (isInterruption(entry)) {
				const turn = state.turns.at(-1);
				if (turn) {
					turn.end = time;
					turn.items.push({ kind: 'interrupted' });
				}
				return;
			}
			const report = contextReport(entry, time);
			if (report) {
				state.contextReport = report;
				return;
			}
			let prompt = promptText(entry);
			const opening = state.turns.length === 1 && !state.turns[0].prompt ? state.turns[0] : undefined;
			if (prompt === undefined && state.sidechain && (!state.turns.length || opening)) {
				// An agent forked from a conversation gets its task next to the result of the call that started it.
				prompt = agentTaskText(entry);
				if (prompt !== undefined && opening) {
					state.turns[0] = { ...opening, prompt };
					return;
				}
			}
			if (prompt === undefined) {
				return;
			}
			state.turns.push({ prompt, images: entry.imagePasteIds ?? [], time, end: time, items: [] });
			return;
		}
		if (entry.type !== 'assistant' || !entry.message) {
			return;
		}
		const message = entry.message;
		if (message.model && !message.model.startsWith('<')) {
			state.model = message.model;
		}
		if (message.usage) {
			state.contextTokens = (message.usage.input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0);
		}
		if (!state.turns.length && state.sidechain) {
			// An agent's transcript can open with its own work before any prompt of its own.
			state.turns.push({ prompt: '', images: [], time, end: time, items: [] });
		}
		const turn = state.turns.at(-1);
		if (!turn || !Array.isArray(message.content)) {
			return;
		}
		turn.end = time;
		for (const block of message.content) {
			const item = toItem(block, state.cwd);
			if (item) {
				turn.items.push(item);
			}
		}
	}
}

function newState(transcript: string, sidechain: boolean): ISessionState {
	return { transcript, offset: 0, partial: '', turns: [], model: undefined, contextTokens: undefined, contextReport: undefined, cwd: undefined, pendingTasks: new Map(), tasks: new Map(), sidechain };
}

/** The output file Claude names in a background shell's result. */
function outputFileFrom(content: string | IContentBlock[] | undefined): string | undefined {
	const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => typeof b.content === 'string' ? b.content : '').join('') : '';
	return /Output is being written to: (?<file>\S+?)\.?(?:\s|$)/.exec(text)?.groups?.file;
}

/** How Claude's shell wraps a command: `eval '...'`, with single quotes escaped. */
function quotedForEval(command: string): string {
	return `eval '${command.replace(/'/g, `'\\''`)}`.slice(0, 200);
}

/** Shells Claude runs: direct children of its process, each in its own process group. */
function shellProcesses(claudePid: number): Promise<{ pid: number; pgid: number; command: string }[]> {
	if (process.platform === 'win32') {
		return Promise.resolve([]);
	}
	return new Promise(resolve => cp.execFile('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { maxBuffer: 16 * 1024 * 1024, timeout: 3000 }, (error, stdout) => {
		if (error) {
			resolve([]);
			return;
		}
		resolve(stdout.split('\n').flatMap(line => {
			const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s+(?<command>.*)$/.exec(line);
			return match?.groups && Number(match.groups.ppid) === claudePid ? [{ pid: Number(match.groups.pid), pgid: Number(match.groups.pgid), command: match.groups.command }] : [];
		}));
	}));
}

/** The last few lines a shell wrote. */
async function tailOf(file: string | undefined): Promise<string | undefined> {
	if (!file) {
		return undefined;
	}
	try {
		const handle = await fs.promises.open(file, 'r');
		try {
			const size = (await handle.stat()).size;
			const length = Math.min(size, 4096);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			return buffer.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).filter(line => line.trim()).slice(-4).join('\n');
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/** `1m` → 1_000_000, `200k` → 200_000. */
function parseTokenCount(text: string | undefined): number | undefined {
	const match = text ? /^(?<n>[\d.]+)(?<unit>[kKmM]?)$/.exec(text.trim()) : null;
	if (!match?.groups) {
		return undefined;
	}
	const unit = match.groups.unit.toLowerCase();
	return Math.round(Number(match.groups.n) * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1));
}

/** Claude 5 models run with a 1M-token window in Claude Code; older ones with 200k. */
function windowForModel(model: string | undefined): number | undefined {
	if (!model) {
		return undefined;
	}
	return /claude-(?:opus|sonnet|fable)-5/.test(model) || /\[1m\]/i.test(model) ? 1_000_000 : 200_000;
}

/** `846.2k / 1m (85%)` from a `/context` run, which Claude logs as a meta user entry. */
function contextReport(entry: ITranscriptEntry, time: number): { used: string; window: string; percent: number; time: number } | undefined {
	const content = entry.message?.content;
	const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => b.text ?? '').join('\n') : '';
	// Claude logs the report as a meta entry: "## Context Usage … **Tokens:** 48.4k / 1m (5%)".
	if (!text.includes('Context Usage')) {
		return undefined;
	}
	const plain = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\*\*/g, '');
	const match = /(?<used>[\d.]+[kKmM]?)\s*\/\s*(?<window>[\d.]+[kKmM]?)(?:\s+tokens)?\s*\((?<percent>\d+)%\)/.exec(plain);
	if (!match?.groups) {
		return undefined;
	}
	return { used: match.groups.used, window: match.groups.window, percent: Number(match.groups.percent), time };
}

/** The text of a prompt you typed, or undefined for tool results, meta entries and the like. */
function promptText(entry: ITranscriptEntry): string | undefined {
	if (entry.isMeta || (entry.origin && entry.origin.kind !== 'human')) {
		return undefined;
	}
	const content = entry.message?.content;
	if (typeof content === 'string') {
		return cleanPrompt(content);
	}
	if (!Array.isArray(content) || content.some(b => b.type === 'tool_result')) {
		return undefined;
	}
	const text = content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
	const hasImage = content.some(b => b.type === 'image');
	return text || hasImage ? cleanPrompt(text) : undefined;
}

/** The task text an agent got alongside a tool result (how a forked agent receives its prompt). */
function agentTaskText(entry: ITranscriptEntry): string | undefined {
	const content = entry.message?.content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	const text = content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n')
		// A forked agent's task starts with instructions for the fork itself; show only its task.
		.replace(/<fork-boilerplate>[\s\S]*?<\/fork-boilerplate>/g, '')
		.replace(/^\s*Your directive:\s*/i, '')
		.trim();
	return text ? cleanPrompt(text) : undefined;
}

/** The note Claude logs when you press Esc: `[Request interrupted by user]` (or `… for tool use`). */
function isInterruption(entry: ITranscriptEntry): boolean {
	const content = entry.message?.content;
	const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text ?? '').join('') : '';
	return /^\[Request interrupted by user/.test(text.trim());
}

/** `[Image #3]` references in a message. */
function imageNumbers(text: string): number[] {
	return [...text.matchAll(/\[Image #(?<n>\d+)\]/g)].map(match => Number(match.groups?.n));
}

function cleanPrompt(text: string): string | undefined {
	// Claude wraps slash commands and system notes in tags; keep what you'd recognize.
	const command = /<command-name>(.*?)<\/command-name>/s.exec(text);
	if (command) {
		if (/^\/?context$/.test(command[1].trim())) {
			return undefined; // the header's context check, not something you said
		}
		const args = /<command-args>(.*?)<\/command-args>/s.exec(text)?.[1]?.trim();
		return `${command[1].trim()}${args ? ` ${args}` : ''}`;
	}
	if (/^\s*<(local-command-stdout|system-reminder|task-notification)/.test(text) || /^\[Request interrupted/.test(text.trim())) {
		return undefined;
	}
	// Pasted text arrives wrapped in tags; show just the text.
	return text.replace(/<\/?pasted_content[^>]*>/g, '').trim();
}

function toItem(block: IContentBlock, cwd: string | undefined): ClaudeItem | undefined {
	if (block.type === 'text' && block.text?.trim()) {
		return { kind: 'text', text: block.text.trim() };
	}
	if (block.type !== 'tool_use' || !block.name || hiddenTools.has(block.name)) {
		return undefined;
	}
	const input = block.input ?? {};
	const str = (key: string) => typeof input[key] === 'string' ? input[key] as string : '';
	const rel = (file: string) => cwd && file.startsWith(cwd + '/') ? file.slice(cwd.length + 1) : file;
	switch (block.name) {
		case 'Read': return { kind: 'step', verb: 'Read', target: rel(str('file_path')), file: str('file_path') };
		case 'Edit': return editItem(str('file_path'), rel(str('file_path')), str('old_string'), str('new_string'), false);
		case 'MultiEdit': {
			const edits = Array.isArray(input.edits) ? input.edits as { old_string?: string; new_string?: string }[] : [];
			return editItem(str('file_path'), rel(str('file_path')), edits.map(e => e.old_string ?? '').join('\n'), edits.map(e => e.new_string ?? '').join('\n'), false);
		}
		case 'Write': return editItem(str('file_path'), rel(str('file_path')), '', str('content'), true);
		case 'Bash': return { kind: 'step', verb: 'Ran', target: firstLine(str('description') || str('command')) };
		case 'Grep': return { kind: 'step', verb: 'Searched', target: str('pattern') };
		case 'Glob': return { kind: 'step', verb: 'Listed', target: str('pattern') };
		case 'WebFetch': return { kind: 'step', verb: 'Fetched', target: str('url') };
		case 'WebSearch': return { kind: 'step', verb: 'Searched the web', target: str('query') };
		case 'Agent':
		case 'Task': return { kind: 'step', verb: 'Agent', target: str('description') };
		default: return { kind: 'step', verb: block.name.replace(/^mcp__\w+__/, ''), target: '' };
	}
}

function editItem(file: string, shown: string, before: string, after: string, isNew: boolean): ClaudeItem {
	const removed = before ? before.split('\n') : [];
	const added = after ? after.split('\n') : [];
	const lines: ['a' | 'd', string][] = [...removed.map(l => ['d', l] as ['d', string]), ...added.map(l => ['a', l] as ['a', string])];
	return { kind: 'edit', file: shown || file, added: added.length, removed: removed.length, lines: lines.slice(0, maxDiffLines), isNew };
}

function firstLine(text: string): string {
	const line = text.split('\n')[0];
	return line.length > 120 ? line.slice(0, 117) + '…' : line;
}
