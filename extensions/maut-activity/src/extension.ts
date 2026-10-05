/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Maut Activity: file-centric view of files Claude Code has changed in the current session.
//  One row per file, expandable to see individual edits. Diff vs session-start, one-click
//  undo via Claude's own pre-edit backups in ~/.claude/file-history/.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerSystemStats } from './systemStats';

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROJECTS_ROOT = path.join(CLAUDE_HOME, 'projects');
const FILE_HISTORY_ROOT = path.join(CLAUDE_HOME, 'file-history');

const REVERTABLE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

interface BackupRef {
	backupFileName: string;
	version: number;
}

interface Action {
	readonly id: string;
	readonly timestamp: number;
	readonly tool: string;
	readonly filePath: string;
	/** Backup ref captured in the snapshot just before this action's message. Restores PRE-action state. */
	readonly backup?: BackupRef;
}

interface FileGroup {
	filePath: string;
	basename: string;
	actions: Action[];
	hash?: string;
	sessionId: string;
}

function workspaceSlug(folder: string): string {
	return folder.split(path.sep).join('-');
}

function findCurrentSessionFile(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) { return undefined; }
	const slug = workspaceSlug(folder);
	const dir = path.join(PROJECTS_ROOT, slug);
	if (!fs.existsSync(dir)) { return undefined; }
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch { return undefined; }
	let best: { file: string; mtime: number } | undefined;
	for (const e of entries) {
		if (!e.isFile() || !e.name.endsWith('.jsonl')) { continue; }
		const full = path.join(dir, e.name);
		try {
			const st = fs.statSync(full);
			if (!best || st.mtimeMs > best.mtime) { best = { file: full, mtime: st.mtimeMs }; }
		} catch { /* skip */ }
	}
	return best?.file;
}

class SessionWatcher {
	private filePath: string | undefined;
	private position = 0;
	private watcher: fs.FSWatcher | undefined;
	private pendingBuffer = '';
	private parseDebounce: NodeJS.Timeout | undefined;
	private latestBackups = new Map<string, BackupRef>();
	private currentSessionId = '';
	private workspaceFolder = '';
	private fileGroups = new Map<string, FileGroup>();
	/** filePath → bytes that were the file's content just before an undo. Enables one-step redo. */
	readonly redoSnapshots = new Map<string, Buffer>();

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	notifyChanged(): void { this._onDidChange.fire(); }

	start(): void {
		this.stop();
		this.workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		this.filePath = findCurrentSessionFile();
		this.position = 0;
		this.pendingBuffer = '';
		this.latestBackups.clear();
		this.fileGroups.clear();
		if (!this.filePath) {
			this.fireChange();
			return;
		}
		this.readMore();
		try {
			this.watcher = fs.watch(this.filePath, () => this.scheduleRead());
		} catch { /* skip */ }
	}

	stop(): void {
		this.watcher?.close();
		this.watcher = undefined;
		if (this.parseDebounce) { clearTimeout(this.parseDebounce); this.parseDebounce = undefined; }
	}

	getFileGroups(): FileGroup[] {
		// Newest-touched first
		const groups = Array.from(this.fileGroups.values());
		groups.sort((a, b) => {
			const at = a.actions[a.actions.length - 1]?.timestamp ?? 0;
			const bt = b.actions[b.actions.length - 1]?.timestamp ?? 0;
			return bt - at;
		});
		return groups;
	}

	getSessionId(): string { return this.currentSessionId; }

	private scheduleRead(): void {
		if (this.parseDebounce) { clearTimeout(this.parseDebounce); }
		this.parseDebounce = setTimeout(() => this.readMore(), 100);
	}

	private readMore(): void {
		if (!this.filePath) { return; }
		let stat: fs.Stats;
		try { stat = fs.statSync(this.filePath); } catch { return; }
		if (stat.size <= this.position) { return; }
		try {
			const fd = fs.openSync(this.filePath, 'r');
			const len = stat.size - this.position;
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, this.position);
			fs.closeSync(fd);
			this.position = stat.size;
			this.processChunk(buf.toString('utf8'));
		} catch { /* skip */ }
	}

	private processChunk(chunk: string): void {
		const combined = this.pendingBuffer + chunk;
		const lines = combined.split('\n');
		this.pendingBuffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) { continue; }
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			this.consumeEntry(entry);
		}
		this.fireChange();
	}

	private isInWorkspace(filePath: string): boolean {
		if (!this.workspaceFolder) { return false; }
		const rel = path.relative(this.workspaceFolder, filePath);
		return !rel.startsWith('..') && !path.isAbsolute(rel);
	}

	private consumeEntry(entry: any): void {
		if (entry?.type === 'permission-mode' && entry.sessionId) {
			this.currentSessionId = entry.sessionId;
			return;
		}
		if (entry?.type === 'file-history-snapshot' && entry.snapshot?.trackedFileBackups) {
			for (const [filePath, ref] of Object.entries(entry.snapshot.trackedFileBackups as Record<string, BackupRef>)) {
				const abs = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceFolder, filePath);
				this.latestBackups.set(abs, ref);
			}
			return;
		}
		if (entry?.type === 'assistant' && entry.message?.content) {
			const content = entry.message.content;
			if (!Array.isArray(content)) { return; }
			const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
			for (const part of content) {
				if (part?.type !== 'tool_use') { continue; }
				const tool = String(part.name ?? '');
				if (!REVERTABLE_TOOLS.has(tool)) { continue; }
				const input = part.input ?? {};
				const filePath: string | undefined = typeof input.file_path === 'string' ? input.file_path : undefined;
				if (!filePath || !this.isInWorkspace(filePath)) { continue; }
				const backup = this.latestBackups.get(filePath);
				const action: Action = {
					id: String(part.id ?? `${ts}-${Math.random()}`),
					timestamp: ts,
					tool,
					filePath,
					backup,
				};
				this.appendAction(action);
			}
		}
	}

	private appendAction(action: Action): void {
		let group = this.fileGroups.get(action.filePath);
		if (!group) {
			group = {
				filePath: action.filePath,
				basename: path.basename(action.filePath),
				actions: [],
				hash: action.backup ? hashFromBackupName(action.backup.backupFileName) : undefined,
				sessionId: this.currentSessionId,
			};
			this.fileGroups.set(action.filePath, group);
		}
		group.sessionId = this.currentSessionId;
		if (!group.hash && action.backup) { group.hash = hashFromBackupName(action.backup.backupFileName); }
		group.actions.push(action);
	}

	private fireChange(): void { this._onDidChange.fire(); }
}

function hashFromBackupName(name: string): string | undefined {
	const m = /^(.+)@v\d+$/.exec(name);
	return m?.[1];
}

function backupAbsPath(sessionId: string, name: string): string {
	return path.join(FILE_HISTORY_ROOT, sessionId, name);
}

function firstBackupPath(group: FileGroup): string | undefined {
	if (!group.hash || !group.sessionId) { return undefined; }
	return backupAbsPath(group.sessionId, `${group.hash}@v1`);
}

function backupPathForAction(action: Action, sessionId: string): string | undefined {
	if (!action.backup) { return undefined; }
	return backupAbsPath(sessionId, action.backup.backupFileName);
}

function fmtRelativeTime(ts: number): string {
	const dt = Math.max(0, Date.now() - ts);
	const m = Math.floor(dt / 60000);
	if (m < 1) { return 'just now'; }
	if (m < 60) { return `${m}m ago`; }
	const h = Math.floor(m / 60);
	if (h < 24) { return `${h}h ago`; }
	return `${Math.floor(h / 24)}d ago`;
}

class FileGroupItem extends vscode.TreeItem {
	constructor(public readonly group: FileGroup, sessionId: string, hasRedo: boolean) {
		super(group.basename, vscode.TreeItemCollapsibleState.Collapsed);
		const count = group.actions.length;
		const lastAction = group.actions[group.actions.length - 1];
		const lastTime = lastAction ? fmtRelativeTime(lastAction.timestamp) : '';
		this.description = `${count} edit${count === 1 ? '' : 's'}  ·  ${lastTime}${hasRedo ? '  ·  \u21ba' : ''}`;
		const tools = new Set(group.actions.map(a => a.tool));
		const created = tools.has('Write') && !firstBackupExists(group);
		this.iconPath = new vscode.ThemeIcon(hasRedo ? 'discard' : (created ? 'new-file' : 'edit'));
		const relPath = vscode.workspace.workspaceFolders?.[0]
			? path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, group.filePath)
			: group.filePath;
		this.tooltip = new vscode.MarkdownString(`**${relPath}**\n\n${count} edit${count === 1 ? '' : 's'} this session.${hasRedo ? '\n\nUndo applied — Redo button available.' : '\n\nClick: diff session-start vs current. Right-click: undo.'}`);
		this.resourceUri = vscode.Uri.file(group.filePath);
		this.contextValue = hasRedo ? 'fileGroupWithRedo' : 'fileGroup';
		this.command = {
			command: 'maut.activity.openFileDiff',
			title: 'Diff Session-Start vs Current',
			arguments: [group, sessionId],
		};
	}
}

function firstBackupExists(group: FileGroup): boolean {
	const p = firstBackupPath(group);
	return !!p && fs.existsSync(p);
}

class ActionItem extends vscode.TreeItem {
	constructor(public readonly action: Action, sessionId: string) {
		const time = fmtTime(action.timestamp);
		super(`${time}  ·  ${action.tool}`, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon(action.tool === 'Write' ? 'new-file' : 'edit');
		this.tooltip = `${action.tool} at ${new Date(action.timestamp).toLocaleString()}`;
		this.contextValue = action.backup ? 'revertableAction' : 'action';
		this.command = action.backup ? {
			command: 'maut.activity.openActionDiff',
			title: 'Diff Pre-Edit vs Current',
			arguments: [action, sessionId],
		} : undefined;
	}
}

function fmtTime(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

type Node = FileGroup | Action;
function isFileGroup(n: Node): n is FileGroup { return 'basename' in n; }

class ActivityProvider implements vscode.TreeDataProvider<Node> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly watcher: SessionWatcher) {
		watcher.onDidChange(() => this._onDidChangeTreeData.fire());
	}

	getTreeItem(node: Node): vscode.TreeItem {
		const sessionId = this.watcher.getSessionId();
		if (isFileGroup(node)) {
			const hasRedo = this.watcher.redoSnapshots.has(node.filePath);
			return new FileGroupItem(node, sessionId, hasRedo);
		}
		return new ActionItem(node, sessionId);
	}

	getChildren(node?: Node): Node[] {
		if (!node) { return this.watcher.getFileGroups(); }
		if (isFileGroup(node)) { return [...node.actions].reverse(); }
		return [];
	}
}

async function openFileDiff(group: FileGroup, sessionId: string): Promise<void> {
	const firstPath = firstBackupPath(group);
	if (!firstPath || !fs.existsSync(firstPath)) {
		if (group.actions.some(a => a.tool === 'Write')) {
			vscode.window.showInformationMessage(`${group.basename} was created by Claude this session — there is no pre-session version to diff.`);
		} else {
			vscode.window.showWarningMessage(`No session-start backup found for ${group.basename}.`);
		}
		return;
	}
	const left = vscode.Uri.file(firstPath);
	const right = vscode.Uri.file(group.filePath);
	const title = `${group.basename}  ·  session start  ↔  current`;
	void sessionId;
	await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

async function openActionDiff(action: Action, sessionId: string): Promise<void> {
	const backupPath = backupPathForAction(action, sessionId);
	if (!backupPath || !fs.existsSync(backupPath)) {
		vscode.window.showWarningMessage(`No backup found for this ${action.tool}.`);
		return;
	}
	const left = vscode.Uri.file(backupPath);
	const right = vscode.Uri.file(action.filePath);
	const title = `${path.basename(action.filePath)}  ·  before ${action.tool}  ↔  current`;
	await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

async function captureForRedo(watcher: SessionWatcher, target: string): Promise<void> {
	try {
		const current = fs.readFileSync(target);
		watcher.redoSnapshots.set(target, current);
	} catch {
		// file might not exist yet (created by Claude); allow undo-as-delete to be redone too
		watcher.redoSnapshots.delete(target);
	}
}

async function restoreFromBackup(backupPath: string, target: string, watcher: SessionWatcher): Promise<boolean> {
	try {
		await captureForRedo(watcher, target);
		const content = fs.readFileSync(backupPath);
		fs.writeFileSync(target, content);
		const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === target);
		if (doc) {
			await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
		}
		return true;
	} catch (err) {
		vscode.window.showErrorMessage(`Failed to restore: ${err}`);
		return false;
	}
}

async function undoFile(group: FileGroup, watcher: SessionWatcher): Promise<void> {
	const firstPath = firstBackupPath(group);
	if (!firstPath || !fs.existsSync(firstPath)) {
		if (group.actions.some(a => a.tool === 'Write')) {
			const choice = await vscode.window.showWarningMessage(
				`${group.basename} was created by Claude this session. Delete the file?`,
				{ modal: true }, 'Delete',
			);
			if (choice === 'Delete') {
				await captureForRedo(watcher, group.filePath);
				try { fs.unlinkSync(group.filePath); }
				catch (err) { vscode.window.showErrorMessage(`Delete failed: ${err}`); return; }
				vscode.window.showInformationMessage(`Deleted ${group.basename}. Redo available.`);
				watcher.notifyChanged();
			}
			return;
		}
		vscode.window.showWarningMessage(`No session-start backup found for ${group.basename}.`);
		return;
	}
	const count = group.actions.length;
	const choice = await vscode.window.showWarningMessage(
		`Restore ${group.basename} to its state before this Claude session started? This undoes all ${count} of Claude's edits to this file. Any of your own edits since then will also be lost. Redo will restore the post-Claude state.`,
		{ modal: true }, 'Restore',
	);
	if (choice !== 'Restore') { return; }
	if (await restoreFromBackup(firstPath, group.filePath, watcher)) {
		vscode.window.showInformationMessage(`${group.basename} restored. Redo available.`);
		watcher.notifyChanged();
	}
}

async function undoAction(action: Action, sessionId: string, watcher: SessionWatcher): Promise<void> {
	const backupPath = backupPathForAction(action, sessionId);
	if (!backupPath || !fs.existsSync(backupPath)) {
		vscode.window.showWarningMessage('Snapshot for this edit is unavailable.');
		return;
	}
	const choice = await vscode.window.showWarningMessage(
		`Restore ${path.basename(action.filePath)} to the state before this ${action.tool}? All later edits to this file will be lost. Redo will restore the current state.`,
		{ modal: true }, 'Restore',
	);
	if (choice !== 'Restore') { return; }
	if (await restoreFromBackup(backupPath, action.filePath, watcher)) {
		vscode.window.showInformationMessage(`${path.basename(action.filePath)} restored.`);
		watcher.notifyChanged();
	}
}

async function redoFile(filePath: string, watcher: SessionWatcher): Promise<void> {
	const snapshot = watcher.redoSnapshots.get(filePath);
	if (!snapshot) {
		vscode.window.showWarningMessage('Nothing to redo for this file.');
		return;
	}
	try {
		fs.writeFileSync(filePath, snapshot);
		watcher.redoSnapshots.delete(filePath);
		const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
		if (doc) {
			await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
		}
		vscode.window.showInformationMessage(`${path.basename(filePath)} redone.`);
		watcher.notifyChanged();
	} catch (err) {
		vscode.window.showErrorMessage(`Redo failed: ${err}`);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	registerSystemStats(context);
	const watcher = new SessionWatcher();
	const provider = new ActivityProvider(watcher);
	context.subscriptions.push(vscode.window.registerTreeDataProvider('maut.activity', provider));

	watcher.start();
	context.subscriptions.push({ dispose: () => watcher.stop() });

	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => watcher.start()));

	context.subscriptions.push(vscode.commands.registerCommand('maut.activity.refresh', () => watcher.start()));
	context.subscriptions.push(vscode.commands.registerCommand('maut.activity.openFileDiff', (group: FileGroup, sessionId: string) => openFileDiff(group, sessionId)));
	context.subscriptions.push(vscode.commands.registerCommand('maut.activity.openActionDiff', (action: Action, sessionId: string) => openActionDiff(action, sessionId)));
	context.subscriptions.push(vscode.commands.registerCommand('maut.activity.undoFile', (item: FileGroupItem | FileGroup) => {
		const group = (item as FileGroupItem)?.group ?? (item as FileGroup);
		return undoFile(group, watcher);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('maut.activity.undoAction', (item: ActionItem | Action) => {
		const action = (item as ActionItem)?.action ?? (item as Action);
		return undoAction(action, watcher.getSessionId(), watcher);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('maut.activity.redoFile', (item: FileGroupItem | FileGroup) => {
		const group = (item as FileGroupItem)?.group ?? (item as FileGroup);
		return redoFile(group.filePath, watcher);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('maut.activity.openFile', (item: FileGroupItem | FileGroup | ActionItem | Action) => {
		const fp = (item as FileGroupItem)?.group?.filePath
			?? (item as FileGroup)?.filePath
			?? (item as ActionItem)?.action?.filePath
			?? (item as Action)?.filePath;
		if (fp) { void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fp)); }
	}));
}

export function deactivate(): void { /* noop */ }
