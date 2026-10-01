/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Maut: resolve the `[Image #N]` references Claude Code prints to an image file on disk.
 *
 *  Claude Code (2.1.2xx+) no longer keeps one file per paste in `~/.claude/image-cache`. Images
 *  only reach disk once the prompt is sent:
 *  - pasted images: inline base64 in the session transcript, numbered by `imagePasteIds`
 *  - uploaded / queued images: the original file under `~/.claude/uploads/<session>/`, listed in
 *    an `inlined_image_paths` attachment; their numbers only survive in `~/.claude/history.jsonl`
 *
 *  Images in a prompt that hasn't been sent exist only in Claude's memory, so the workbench asks
 *  us to snapshot the clipboard the moment a new `[Image #N]` appears (Claude has just read the
 *  image from it). That copy is used until the transcript has the real one.
 *
 *  The session is found from the terminal's shell pid: `~/.claude/sessions/<pid>.json` records
 *  every running Claude process, and we walk up its parent chain to the shell.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const LEGACY_CACHE_DIR = path.join(CLAUDE_DIR, 'image-cache');
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const MEDIA_TYPE_EXTS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const IMAGE_TOKEN = /\[Image #(?<index>\d+)\]/g;

interface ISessionRecord {
	readonly pid: number;
	readonly sessionId: string;
	readonly updatedAt: number;
}

interface IContentBlock {
	readonly type?: string;
	readonly source?: { readonly type?: string; readonly media_type?: string; readonly data?: string };
}

interface ITranscriptEntry {
	readonly type?: string;
	readonly isSidechain?: boolean;
	readonly isMeta?: boolean;
	readonly origin?: { readonly kind?: string };
	readonly timestamp?: string;
	readonly imagePasteIds?: number[];
	readonly message?: { readonly content?: string | IContentBlock[] };
	readonly attachment?: { readonly type?: string; readonly paths?: string[] };
}

interface IUnnumberedMessage {
	readonly timestamp: number;
	readonly blocks: IContentBlock[];
	paths: string[] | undefined;
}

/**
 * Per-session state. The transcript is read incrementally from `offset`, so a long session is
 * only parsed once no matter how often the user hovers.
 */
interface ISessionImages {
	readonly transcript: string;
	offset: number;
	partial: string;
	/** Image number → file on disk (original upload, legacy cache file or decoded copy). */
	readonly files: Map<number, string>;
	/** Image messages that carried no `imagePasteIds` (uploaded or queued prompts). */
	readonly unnumbered: IUnnumberedMessage[];
	lastUnnumbered: IUnnumberedMessage | undefined;
	pendingBlocks: Map<number, IContentBlock>;
}

export class ClaudeImageResolver {
	private readonly _sessions = new Map<string, ISessionImages>();

	constructor(private readonly _cacheDir: string) { }

	/**
	 * Resolve image `index` for the Claude session running under the shell with `shellPid`.
	 * Returns the absolute path of the image file, or `undefined` when the image hasn't been
	 * sent yet (Claude only keeps unsent images in memory) or no session was found.
	 */
	async resolve(shellPid: number | undefined, index: number): Promise<string | undefined> {
		const sessionId = await findSessionId(shellPid);
		if (!sessionId) {
			return undefined;
		}
		const legacy = findLegacyCacheFile(sessionId, index);
		if (legacy) {
			return legacy;
		}
		const state = this._getState(sessionId);
		if (state) {
			await this._readNewTranscriptLines(state, sessionId);
			const known = state.files.get(index);
			if (known && fs.existsSync(known)) {
				return known;
			}
			const block = state.pendingBlocks.get(index);
			if (block) {
				const file = this._writeDecoded(sessionId, index, block);
				if (file) {
					state.files.set(index, file);
					state.pendingBlocks.delete(index);
				}
				return file;
			}
		}
		const snapshot = this._snapshotPath(sessionId, index);
		return fs.existsSync(snapshot) ? snapshot : undefined;
	}

	/**
	 * Save the clipboard image as image `index` of the terminal's session, unless that image is
	 * already known. Called right after Claude pasted it, so the clipboard still holds it.
	 */
	async captureClipboard(shellPid: number | undefined, index: number): Promise<string | undefined> {
		const sessionId = await findSessionId(shellPid);
		if (!sessionId) {
			return undefined;
		}
		const snapshot = this._snapshotPath(sessionId, index);
		// A fresh paste replaces any older snapshot with the same number (e.g. after /clear).
		fs.rmSync(snapshot, { force: true });
		const existing = await this.resolve(shellPid, index);
		if (existing) {
			return existing;
		}
		fs.mkdirSync(path.dirname(snapshot), { recursive: true });
		return await writeClipboardImage(snapshot) ? snapshot : undefined;
	}

	private _snapshotPath(sessionId: string, index: number): string {
		return path.join(this._cacheDir, sessionId, 'unsent', `${index}.png`);
	}

	/** Remove decoded copies for sessions not touched in a week. */
	pruneCache(): void {
		const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this._cacheDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const dir = path.join(this._cacheDir, entry.name);
			try {
				if (entry.isDirectory() && fs.statSync(dir).mtimeMs < cutoff) {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			} catch { /* skip */ }
		}
	}

	private _getState(sessionId: string): ISessionImages | undefined {
		let state = this._sessions.get(sessionId);
		if (!state) {
			const transcript = findTranscript(sessionId);
			if (!transcript) {
				return undefined;
			}
			state = { transcript, offset: 0, partial: '', files: new Map(), unnumbered: [], lastUnnumbered: undefined, pendingBlocks: new Map() };
			this._sessions.set(sessionId, state);
		}
		return state;
	}

	private async _readNewTranscriptLines(state: ISessionImages, sessionId: string): Promise<void> {
		let size: number;
		try {
			size = (await fs.promises.stat(state.transcript)).size;
		} catch {
			return;
		}
		if (size < state.offset) {
			// Rewritten from scratch; start over.
			state.offset = 0;
			state.partial = '';
			state.files.clear();
			state.unnumbered.length = 0;
			state.lastUnnumbered = undefined;
			state.pendingBlocks.clear();
		}
		if (size === state.offset) {
			return;
		}
		const handle = await fs.promises.open(state.transcript, 'r');
		let text: string;
		try {
			const buffer = Buffer.alloc(size - state.offset);
			await handle.read(buffer, 0, buffer.length, state.offset);
			text = state.partial + buffer.toString('utf8');
		} finally {
			await handle.close();
		}
		state.offset = size;
		const lines = text.split('\n');
		state.partial = lines.pop() ?? '';

		let sawUnnumbered = false;
		for (const line of lines) {
			// Cheap pre-filter: most lines are tool calls and never carry images.
			if (!line.includes('"imagePasteIds"') && !line.includes('"type":"image"') && !line.includes('inlined_image_paths')) {
				continue;
			}
			let entry: ITranscriptEntry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.attachment?.type === 'inlined_image_paths') {
				if (state.lastUnnumbered && !state.lastUnnumbered.paths) {
					state.lastUnnumbered.paths = entry.attachment.paths;
				}
				continue;
			}
			// Only prompts the user typed; tool screenshots arrive as meta user messages.
			if (entry.type !== 'user' || entry.isSidechain || entry.isMeta || (entry.origin && entry.origin.kind !== 'human') || !Array.isArray(entry.message?.content)) {
				continue;
			}
			const blocks = entry.message.content.filter(b => b?.type === 'image');
			if (!blocks.length) {
				continue;
			}
			if (entry.imagePasteIds?.length) {
				entry.imagePasteIds.forEach((id, i) => {
					if (blocks[i]) {
						state.pendingBlocks.set(id, blocks[i]);
					}
				});
				state.lastUnnumbered = undefined;
			} else {
				const message: IUnnumberedMessage = { timestamp: Date.parse(entry.timestamp ?? '') || 0, blocks, paths: undefined };
				state.unnumbered.push(message);
				state.lastUnnumbered = message;
				sawUnnumbered = true;
			}
		}
		if (sawUnnumbered || state.unnumbered.length) {
			await this._numberUnnumbered(state, sessionId);
		}
	}

	/**
	 * Messages without `imagePasteIds` get their numbers from the prompt history: the history
	 * entry is written when the prompt is submitted (or queued), so the match is the closest
	 * earlier unclaimed entry with the same number of images.
	 */
	private async _numberUnnumbered(state: ISessionImages, sessionId: string): Promise<void> {
		const history = await readHistoryImageEntries(sessionId);
		const claimed = new Set<number>([...state.files.keys(), ...state.pendingBlocks.keys()]);
		const remaining: IUnnumberedMessage[] = [];
		for (const message of state.unnumbered) {
			const candidates = history.filter(h => h.timestamp <= message.timestamp + 2000 && h.ids.length === message.blocks.length && !h.ids.some(id => claimed.has(id)));
			const match = candidates.at(-1);
			if (!match) {
				remaining.push(message);
				continue;
			}
			match.ids.forEach((id, i) => {
				claimed.add(id);
				const original = message.paths?.[i];
				if (original && fs.existsSync(original)) {
					state.files.set(id, original);
				} else if (message.blocks[i]) {
					state.pendingBlocks.set(id, message.blocks[i]);
				}
			});
		}
		state.unnumbered.splice(0, state.unnumbered.length, ...remaining);
	}

	private _writeDecoded(sessionId: string, index: number, block: IContentBlock): string | undefined {
		const data = block.source?.type === 'base64' ? block.source.data : undefined;
		if (!data) {
			return undefined;
		}
		const ext = MEDIA_TYPE_EXTS[block.source?.media_type ?? ''] ?? '.png';
		const dir = path.join(this._cacheDir, sessionId);
		const file = path.join(dir, `${index}${ext}`);
		try {
			if (!fs.existsSync(file)) {
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(file, Buffer.from(data, 'base64'));
			}
			return file;
		} catch {
			return undefined;
		}
	}
}

function readSessionRecords(): ISessionRecord[] {
	const records: ISessionRecord[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(SESSIONS_DIR);
	} catch {
		return records;
	}
	for (const name of names) {
		if (!name.endsWith('.json')) {
			continue;
		}
		try {
			const record = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'));
			if (typeof record.pid === 'number' && typeof record.sessionId === 'string') {
				records.push({ pid: record.pid, sessionId: record.sessionId, updatedAt: record.updatedAt ?? record.startedAt ?? 0 });
			}
		} catch { /* skip */ }
	}
	return records;
}

function readParentPids(): Promise<Map<number, number>> {
	const [command, args] = process.platform === 'win32'
		? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']]
		: ['ps', ['-A', '-o', 'pid=,ppid=']];
	return new Promise(resolve => {
		execFile(command, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
			const parents = new Map<number, number>();
			if (!error) {
				for (const line of stdout.split('\n')) {
					const [pid, ppid] = line.trim().split(/\s+/).map(Number);
					if (pid) {
						parents.set(pid, ppid);
					}
				}
			}
			resolve(parents);
		});
	});
}

async function findSessionId(shellPid: number | undefined): Promise<string | undefined> {
	const records = readSessionRecords();
	if (!records.length) {
		return undefined;
	}
	const parents = await readParentPids();
	const alive = records.filter(r => parents.has(r.pid));
	if (shellPid !== undefined) {
		for (const record of alive) {
			let pid: number | undefined = record.pid;
			for (let depth = 0; pid && pid > 1 && depth < 16; depth++) {
				if (pid === shellPid) {
					return record.sessionId;
				}
				pid = parents.get(pid);
			}
		}
	}
	// Not under this terminal's shell (e.g. ssh or tmux): fall back to the most recently active session.
	return [...alive].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionId;
}

function findTranscript(sessionId: string): string | undefined {
	let projects: string[];
	try {
		projects = fs.readdirSync(PROJECTS_DIR);
	} catch {
		return undefined;
	}
	for (const project of projects) {
		const candidate = path.join(PROJECTS_DIR, project, `${sessionId}.jsonl`);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function findLegacyCacheFile(sessionId: string, index: number): string | undefined {
	for (const ext of IMAGE_EXTS) {
		const candidate = path.join(LEGACY_CACHE_DIR, sessionId, `${index}${ext}`);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

async function readHistoryImageEntries(sessionId: string): Promise<{ timestamp: number; ids: number[] }[]> {
	let text: string;
	try {
		text = await fs.promises.readFile(HISTORY_FILE, 'utf8');
	} catch {
		return [];
	}
	const entries: { timestamp: number; ids: number[] }[] = [];
	for (const line of text.split('\n')) {
		if (!line.includes(sessionId) || !line.includes('[Image #')) {
			continue;
		}
		try {
			const entry = JSON.parse(line);
			if (entry.sessionId !== sessionId || typeof entry.display !== 'string') {
				continue;
			}
			const ids = [...entry.display.matchAll(IMAGE_TOKEN)].map(m => Number(m.groups?.index));
			if (ids.length) {
				entries.push({ timestamp: entry.timestamp ?? 0, ids });
			}
		} catch { /* skip */ }
	}
	return entries.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Write the clipboard image to `file` as PNG. On macOS screenshots and browsers put PNG on the
 * clipboard, other apps only TIFF, which `sips` converts.
 */
async function writeClipboardImage(file: string): Promise<boolean> {
	if (process.platform === 'win32') {
		return writeWindowsClipboardImage(file);
	}
	if (process.platform !== 'darwin') {
		return false;
	}
	const write = async (type: string, target: string) => {
		const ok = await run('osascript', [
			'-e', `set f to open for access (POSIX file ${JSON.stringify(target)}) with write permission`,
			'-e', 'set eof f to 0',
			'-e', `try\nwrite (the clipboard as ${type}) to f\non error\nclose access f\nerror "no image"\nend try`,
			'-e', 'close access f',
		]);
		if (!ok) {
			fs.rmSync(target, { force: true });
		}
		return ok;
	};
	// allow-any-unicode-next-line
	if (await write('«class PNGf»', file)) {
		return true;
	}
	const tiff = `${file}.tiff`;
	try {
		// allow-any-unicode-next-line
		return await write('«class TIFF»', tiff) && await run('sips', ['-s', 'format', 'png', tiff, '--out', file]);
	} finally {
		fs.rmSync(tiff, { force: true });
	}
}

/** Windows Forms reads the clipboard; it needs a single-threaded apartment (`-STA`). */
async function writeWindowsClipboardImage(file: string): Promise<boolean> {
	const script = [
		'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
		'$image = [System.Windows.Forms.Clipboard]::GetImage()',
		'if ($null -eq $image) { exit 1 }',
		`$image.Save('${file.replace(/'/g, '\'\'')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
	].join('; ');
	const ok = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script]);
	if (!ok) {
		fs.rmSync(file, { force: true });
	}
	return ok;
}

function run(command: string, args: string[]): Promise<boolean> {
	return new Promise(resolve => execFile(command, args, { windowsHide: true }, error => resolve(!error)));
}
