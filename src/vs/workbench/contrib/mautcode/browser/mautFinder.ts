/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DataTransfers } from '../../../../base/browser/dnd.js';
import { AnchorAxisAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import * as dom from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { IMatch } from '../../../../base/common/filters.js';
import { prepareQuery, scoreFuzzy2 } from '../../../../base/common/fuzzyScorer.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { basename, dirname, isEqualOrParent, relativePath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService, IOpenContextView } from '../../../../platform/contextview/browser/contextView.js';
import { CodeDataTransfers } from '../../../../platform/dnd/browser/dnd.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor, createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { IMautClaudeService } from '../../terminal/browser/mautClaude.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import './media/mautFinder.css';

/** Contributed by the built-in `maut-claude-images` extension: changed and new files, newest first. */
const changedFilesCommandId = '_maut.files.changed';
const openFinderCommandId = 'maut.finder.open';
const maxResults = 60;

interface IEntry {
	readonly resource: URI;
	readonly folder: boolean;
	/** Where it lives, relative to the project. */
	readonly dir: string;
	readonly matches?: IMatch[];
	readonly tag?: 'changed' | 'new';
	/** One of your open files (browsing). */
	readonly open?: boolean;
	/** Its depth in the folder tree (browsing). */
	readonly depth?: number;
}

const IMautFinderService = createDecorator<IMautFinderService>('mautFinderService');

interface IMautFinderService {
	readonly _serviceBrand: undefined;
	toggle(): void;
}

/**
 * The finder: files and folders by name, fast, and handed to Claude. One panel over the editor
 * (nothing behind it resizes). Empty, it browses: what Claude changed, your open files, the folder
 * tree. Typing searches names, fuzzy, like Quick Open. Enter opens, Cmd+Enter adds to Claude's
 * prompt as @mentions, Shift+Enter picks several, Tab searches inside files instead.
 *
 * The rail in the activity bar (when the side bar is hidden) shows the files Claude changed and
 * your open files, one click away.
 */
class MautFinder extends Disposable implements IMautFinderService {
	declare readonly _serviceBrand: undefined;

	private readonly _panel: HTMLElement;
	private readonly _input: HTMLInputElement;
	private readonly _modes: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _add: HTMLButtonElement;
	private readonly _queryBuilder: QueryBuilder;
	private readonly _search = this._register(new RunOnceScheduler(() => this._render(), 70));
	private readonly _renderStore = this._register(new DisposableStore());
	private _searchToken: CancellationTokenSource | undefined;
	private _entries: IEntry[] = [];
	private _rows: HTMLElement[] = [];
	private _pickBoxes: HTMLElement[] = [];
	private _selected = 0;
	private readonly _picked = new Map<string, URI>();
	private readonly _expanded = new Set<string>();
	private _changed: { resource: URI; isNew: boolean }[] = [];

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IEditorService private readonly _editorService: IEditorService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly _searchService: ISearchService,
		@ICommandService private readonly _commandService: ICommandService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IMautClaudeService private readonly _claudeService: IMautClaudeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._queryBuilder = instantiationService.createInstance(QueryBuilder);
		this._panel = dom.$('.maut-finder');
		this._panel.setAttribute('role', 'dialog');
		this._panel.setAttribute('aria-label', localize('maut.finder.label', "Find Files and Folders"));
		const head = dom.append(this._panel, dom.$('.maut-finder-head'));
		const box = dom.append(head, dom.$('.maut-finder-box'));
		dom.append(box, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.search)}`));
		this._input = dom.append(box, dom.$<HTMLInputElement>('input.maut-finder-input', {
			type: 'text',
			spellcheck: 'false',
			placeholder: localize('maut.finder.placeholder', "Find files and folders"),
		}));
		this._modes = dom.append(this._panel, dom.$('.maut-finder-modes'));
		const names = dom.append(this._modes, dom.$<HTMLButtonElement>('button.on', { type: 'button' }, localize('maut.finder.names', "Names")));
		const contents = dom.append(this._modes, dom.$<HTMLButtonElement>('button', { type: 'button' }, localize('maut.finder.contents', "Contents")));
		names.setAttribute('aria-pressed', 'true');
		this._register(dom.addDisposableListener(contents, dom.EventType.CLICK, () => this._searchContents()));
		this._list = dom.append(this._panel, dom.$('.maut-finder-list'));
		this._list.setAttribute('role', 'listbox');
		this._add = dom.append(this._panel, dom.$<HTMLButtonElement>('button.maut-finder-add', { type: 'button' }));
		this._register(dom.addDisposableListener(this._add, dom.EventType.CLICK, () => this._addToClaude()));
		const foot = dom.append(this._panel, dom.$('.maut-finder-foot'));
		const mod = isMacintosh ? '\u2318' : 'Ctrl+';
		for (const [key, what] of [['\u21b5', localize('maut.finder.open', "open")], [`${mod}\u21b5`, localize('maut.finder.toClaude', "to Claude")], ['\u21e7\u21b5', localize('maut.finder.pick', "pick")], ['tab', localize('maut.finder.inside', "inside files")]]) {
			dom.append(foot, dom.$('span', undefined, dom.$('b', undefined, key), ` ${what}`));
		}

		this._register(dom.addDisposableListener(this._input, dom.EventType.INPUT, () => {
			this._selected = 0;
			this._search.schedule();
		}));
		this._register(dom.addDisposableListener(this._input, dom.EventType.KEY_DOWN, e => this._onKey(e)));
		// Clicking anywhere else closes it.
		this._register(dom.addDisposableListener(mainWindow.document, dom.EventType.MOUSE_DOWN, e => {
			if (this._isOpen() && !dom.isAncestor(e.target as Node, this._panel) && !(e.target as HTMLElement).closest?.('.maut-rail')) {
				this.hide();
			}
		}, true));
		this._register({ dispose: () => this._panel.remove() });
	}

	toggle(): void {
		if (this._isOpen()) {
			this.hide();
		} else {
			this.show();
		}
	}

	show(): void {
		const container = this._layoutService.mainContainer;
		if (!this._panel.parentElement) {
			container.appendChild(this._panel);
		}
		// Over the editor, next to the activity bar (and the side bar, if it shows).
		const anchor = this._layoutService.getContainer(mainWindow, Parts.SIDEBAR_PART);
		const sidebarShown = this._layoutService.isVisible(Parts.SIDEBAR_PART);
		const activity = this._layoutService.getContainer(mainWindow, Parts.ACTIVITYBAR_PART);
		const left = sidebarShown && anchor ? anchor.getBoundingClientRect().right : (activity?.getBoundingClientRect().right ?? 48);
		const editor = this._layoutService.getContainer(mainWindow, Parts.EDITOR_PART)?.getBoundingClientRect();
		const containerRect = container.getBoundingClientRect();
		this._panel.style.left = `${left - containerRect.left}px`;
		this._panel.style.top = `${(editor?.top ?? 35) - containerRect.top}px`;
		this._panel.style.height = `${editor?.height ?? 600}px`;
		this._panel.classList.add('open');
		this._picked.clear();
		this._input.value = '';
		this._selected = 0;
		this._loadChanged();
		this._render();
		this._input.focus();
	}

	hide(): void {
		this._panel.classList.remove('open');
		this._searchToken?.cancel();
	}

	private _isOpen(): boolean {
		return this._panel.classList.contains('open');
	}

	private _root(): URI | undefined {
		return this._workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private async _loadChanged(): Promise<void> {
		const root = this._root();
		if (!root || root.scheme !== Schemas.file) {
			return;
		}
		const files = await this._commandService.executeCommand<{ path: string; isNew: boolean }[]>(changedFilesCommandId, root.fsPath).catch(() => undefined);
		this._changed = (files ?? []).map(file => ({ resource: URI.file(file.path), isNew: file.isNew }));
		if (this._isOpen() && !this._input.value) {
			this._render();
		}
	}

	// ---------- Rendering ----------

	private async _render(): Promise<void> {
		const query = this._input.value.trim();
		this._entries = query ? await this._findByName(query) : await this._browse();
		if (query !== this._input.value.trim()) {
			return; // a newer query is on its way
		}
		this._renderStore.clear();
		dom.clearNode(this._list);
		this._rows = [];
		this._pickBoxes = [];
		let group: string | undefined;
		this._entries.forEach((entry, index) => {
			const heading = this._groupOf(entry, query);
			if (heading !== group) {
				group = heading;
				dom.append(this._list, dom.$('.maut-finder-group', undefined, heading));
			}
			this._rows.push(this._renderRow(entry, index, !query));
		});
		if (!this._entries.length) {
			dom.append(this._list, dom.$('.maut-finder-empty', undefined, query ? localize('maut.finder.nothing', "No file or folder named like that") : localize('maut.finder.noFolder', "Open a folder to browse its files")));
		}
		this._selected = Math.min(this._selected, Math.max(0, this._entries.length - 1));
		this._highlight();
		this._renderAdd();
	}

	private _groupOf(entry: IEntry, query: string): string {
		if (query) {
			return localize('maut.finder.matches', "Files and Folders");
		}
		if (entry.tag) {
			return localize('maut.finder.changed', "Changed");
		}
		return entry.open ? localize('maut.finder.openFiles', "Open") : localize('maut.finder.all', "All Files");
	}

	private _renderRow(entry: IEntry, index: number, tree: boolean): HTMLElement {
		const row = dom.append(this._list, dom.$('.maut-finder-row'));
		row.setAttribute('role', 'option');
		row.draggable = true;
		const depth = entry.depth ?? 0;
		if (tree && depth) {
			row.style.paddingLeft = `${8 + depth * 12}px`;
		}
		const key = entry.resource.toString();
		const pick = dom.append(row, dom.$('span.maut-finder-pick'));
		this._pickBoxes[index] = pick;
		pick.classList.toggle('on', this._picked.has(key));
		row.classList.toggle('picked', this._picked.has(key));
		if (entry.folder && tree && entry.depth !== undefined) {
			dom.append(row, dom.$(`span.maut-finder-chevron${ThemeIcon.asCSSSelector(this._expanded.has(key) ? Codicon.chevronDown : Codicon.chevronRight)}`));
		}
		const icon = dom.append(row, dom.$('span.maut-finder-icon.show-file-icons'));
		dom.append(icon, dom.$(`span.${getIconClasses(this._modelService, this._languageService, entry.resource, entry.folder ? FileKind.FOLDER : FileKind.FILE).join('.')}`));
		const name = dom.append(row, dom.$('span.maut-finder-name'));
		const label = basename(entry.resource);
		let at = 0;
		for (const match of entry.matches ?? []) {
			name.append(label.slice(at, match.start));
			dom.append(name, dom.$('mark', undefined, label.slice(match.start, match.end)));
			at = match.end;
		}
		name.append(label.slice(at));
		if (entry.dir && !tree) {
			dom.append(row, dom.$('span.maut-finder-dir', undefined, entry.dir));
		}
		if (entry.tag) {
			dom.append(row, dom.$(`span.maut-finder-tag.${entry.tag}`, undefined, entry.tag === 'new' ? 'U' : 'M'));
		} else if (entry.folder && !tree) {
			dom.append(row, dom.$('span.maut-finder-kind', undefined, localize('maut.finder.folder', "folder")));
		}
		this._renderStore.add(dom.addDisposableListener(pick, dom.EventType.MOUSE_DOWN, e => {
			e.preventDefault();
			e.stopPropagation();
			this._togglePick(index);
		}));
		this._renderStore.add(dom.addDisposableListener(row, dom.EventType.MOUSE_DOWN, e => {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			this._selected = index;
			if (e.shiftKey) {
				this._togglePick(index);
			} else if (e.metaKey || e.ctrlKey) {
				this._addToClaude(entry);
			} else {
				this._open(entry);
			}
		}));
		// Drag a result onto Claude: the terminal turns it into an @mention.
		this._renderStore.add(dom.addDisposableListener(row, dom.EventType.DRAG_START, e => {
			const uris = this._picked.size ? [...this._picked.values()] : [entry.resource];
			e.dataTransfer?.setData(DataTransfers.RESOURCES, JSON.stringify(uris.map(uri => uri.toString())));
			e.dataTransfer?.setData(CodeDataTransfers.FILES, JSON.stringify(uris.map(uri => uri.fsPath)));
			mainWindow.setTimeout(() => this.hide(), 0);
		}));
		return row;
	}

	private _highlight(): void {
		this._rows.forEach((row, index) => row.classList.toggle('selected', index === this._selected));
		this._rows[this._selected]?.scrollIntoView({ block: 'nearest' });
	}

	private _renderAdd(): void {
		const count = this._picked.size;
		this._add.classList.toggle('visible', count > 0);
		this._add.textContent = count === 1 ? localize('maut.finder.addOne', "Add 1 to Claude") : localize('maut.finder.addMany', "Add {0} to Claude", count);
	}

	// ---------- Browse: changed, open, the tree ----------

	private async _browse(): Promise<IEntry[]> {
		const root = this._root();
		if (!root) {
			return [];
		}
		const entries: IEntry[] = [];
		const seen = new Set<string>();
		for (const file of this._changed.slice(0, 8)) {
			entries.push({ resource: file.resource, folder: false, dir: this._dirOf(file.resource), tag: file.isNew ? 'new' : 'changed' });
			seen.add(file.resource.toString());
		}
		for (const editor of this._editorService.editors) {
			const resource = editor.resource;
			if (resource?.scheme === Schemas.file && !seen.has(resource.toString()) && isEqualOrParent(resource, root)) {
				seen.add(resource.toString());
				entries.push({ resource, folder: false, dir: this._dirOf(resource), open: true });
			}
			if (entries.length >= 14) {
				break;
			}
		}
		await this._appendTree(root, 0, entries);
		return entries;
	}

	private async _appendTree(folder: URI, depth: number, entries: IEntry[]): Promise<void> {
		let children: { resource: URI; isDirectory: boolean; name: string }[] = [];
		try {
			children = (await this._fileService.resolve(folder)).children ?? [];
		} catch {
			return;
		}
		const sorted = children
			.filter(child => child.name !== '.git' && child.name !== '.DS_Store')
			.sort((a, b) => a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1);
		for (const child of sorted) {
			entries.push({ resource: child.resource, folder: child.isDirectory, dir: '', depth });
			if (child.isDirectory && this._expanded.has(child.resource.toString())) {
				await this._appendTree(child.resource, depth + 1, entries);
			}
			if (entries.length > 400) {
				return;
			}
		}
	}

	// ---------- Find by name ----------

	private async _findByName(query: string): Promise<IEntry[]> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		const root = this._root();
		if (!folders.length || !root) {
			return [];
		}
		this._searchToken?.cancel();
		const token = this._searchToken = new CancellationTokenSource();
		let resources: URI[] = [];
		try {
			const result = await this._searchService.fileSearch(this._queryBuilder.file(folders, { filePattern: query, maxResults: 400, sortByScore: true }), token.token);
			resources = result.results.map(match => match.resource);
		} catch {
			return [];
		}
		const prepared = prepareQuery(query);
		const changed = new Map(this._changed.map(file => [file.resource.toString(), file.isNew]));
		const recent = new Set(this._editorService.editors.map(editor => editor.resource?.toString()).filter(Boolean));
		const scored: { entry: IEntry; score: number }[] = [];
		const folderSeen = new Set<string>();
		for (const resource of resources) {
			const [score, matches] = scoreFuzzy2(basename(resource), prepared);
			const pathScore = score ? 0 : (scoreFuzzy2(relativePath(root, resource) ?? '', prepared)[0] ?? 0);
			if (!score && !pathScore) {
				continue;
			}
			const key = resource.toString();
			const isChanged = changed.has(key);
			scored.push({
				entry: { resource, folder: false, dir: this._dirOf(resource), matches: score ? matches : undefined, tag: isChanged ? (changed.get(key) ? 'new' : 'changed') : undefined },
				score: (score ?? pathScore / 4) + (isChanged ? 1000 : 0) + (recent.has(key) ? 500 : 0),
			});
			// Folders on the way whose name matches: "comp" finds src/components/.
			for (let parent = dirname(resource); isEqualOrParent(parent, root) && parent.toString() !== root.toString(); parent = dirname(parent)) {
				const parentKey = parent.toString();
				if (folderSeen.has(parentKey)) {
					break;
				}
				folderSeen.add(parentKey);
				const [folderScore, folderMatches] = scoreFuzzy2(basename(parent), prepared);
				if (folderScore) {
					scored.push({ entry: { resource: parent, folder: true, dir: this._dirOf(parent), matches: folderMatches }, score: folderScore + 50 });
				}
			}
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, maxResults).map(item => item.entry);
	}

	private _dirOf(resource: URI): string {
		const root = this._root();
		const parent = dirname(resource);
		return root && isEqualOrParent(parent, root) ? (relativePath(root, parent) || '.') : parent.fsPath;
	}

	// ---------- Actions ----------

	private _onKey(e: KeyboardEvent): void {
		const mod = isMacintosh ? e.metaKey : e.ctrlKey;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			this._selected = Math.max(0, Math.min(this._entries.length - 1, this._selected + (e.key === 'ArrowDown' ? 1 : -1)));
			this._highlight();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const entry = this._entries[this._selected];
			if (mod) {
				this._addToClaude();
			} else if (e.shiftKey) {
				this._togglePick(this._selected);
			} else if (entry) {
				this._open(entry);
			}
		} else if (e.key === 'Tab') {
			e.preventDefault();
			this._searchContents();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this.hide();
		}
	}

	private _togglePick(index: number): void {
		const entry = this._entries[index];
		if (!entry) {
			return;
		}
		const key = entry.resource.toString();
		if (!this._picked.delete(key)) {
			this._picked.set(key, entry.resource);
		}
		const row = this._rows[index];
		row?.classList.toggle('picked', this._picked.has(key));
		this._pickBoxes[index]?.classList.toggle('on', this._picked.has(key));
		this._renderAdd();
		this._input.focus();
	}

	private _open(entry: IEntry): void {
		if (entry.folder) {
			if (!this._input.value.trim()) {
				// Browsing: a folder opens in place.
				const key = entry.resource.toString();
				if (!this._expanded.delete(key)) {
					this._expanded.add(key);
				}
				this._render();
				this._input.focus();
				return;
			}
			this.hide();
			this._commandService.executeCommand('revealInExplorer', entry.resource);
			return;
		}
		this.hide();
		this._editorService.openEditor({ resource: entry.resource, options: { pinned: false } });
	}

	/** Puts the picked results (or the given/selected one) into Claude's prompt as @mentions. */
	private _addToClaude(entry?: IEntry): void {
		const target = entry ?? this._entries[this._selected];
		const uris = this._picked.size ? [...this._picked.values()] : target ? [target.resource] : [];
		if (!uris.length) {
			return;
		}
		const active = this._terminalService.activeInstance;
		const claude = active && this._claudeService.isClaude(active) ? active : this._terminalService.instances.find(instance => this._claudeService.isClaude(instance));
		if (!claude) {
			this._notificationService.info(localize('maut.finder.noClaude', "Start Claude first: type maut or run claude in a terminal."));
			return;
		}
		this.hide();
		claude.insertDroppedFiles(uris);
	}

	private _searchContents(): void {
		const query = this._input.value.trim();
		this.hide();
		this._commandService.executeCommand('workbench.action.findInFiles', { query, triggerSearch: !!query });
	}
}

registerSingleton(IMautFinderService, MautFinder, InstantiationType.Delayed);

/** One folder Claude worked in: the deepest folder holding the files it changed there. */
interface IRailFolder {
	readonly folder: URI;
	readonly files: readonly { readonly resource: URI; readonly isNew: boolean; readonly mtime: number }[];
	/** When a file in it was last changed. */
	readonly mtime: number;
	readonly hasNew: boolean;
}

/** How many folders the rail shows before the rest go under "more". */
const railFolderSlots = 4;

/**
 * The rail: when the side bar is hidden, the activity bar shows the folders Claude has been
 * working in (the deepest folder of each change, newest first) under the project dock, plus the
 * finder. A folder opens a panel with its files and when each changed; "more" lists them all.
 */
class MautFinderRail extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.mautcode.finderRail';

	private readonly _rail = dom.$('.maut-rail');
	private readonly _buttons = this._register(new DisposableStore());
	private readonly _refresh = this._register(new RunOnceScheduler(() => this._render(), 300));
	private _folders: IRailFolder[] = [];
	/** The folder panel, while open. */
	private _panel: IOpenContextView | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly _commandService: ICommandService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IFileService private readonly _fileService: IFileService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IMautFinderService private readonly _finder: IMautFinderService,
	) {
		super();
		this._register({ dispose: () => this._rail.remove() });
		this._register({ dispose: () => this._panel?.close() });
		this._register(this._layoutService.onDidChangePartVisibility(() => this._refresh.schedule()));
		const timer = this._register(new dom.WindowIntervalTimer());
		timer.cancelAndSet(() => this._loadChanged(), 5000, mainWindow);
		this._loadChanged();
	}

	private get _root(): URI | undefined {
		return this._workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private async _loadChanged(): Promise<void> {
		const root = this._root;
		if (root?.scheme !== Schemas.file) {
			return;
		}
		const changed = await this._commandService.executeCommand<{ path: string; isNew: boolean }[]>(changedFilesCommandId, root.fsPath).catch(() => undefined) ?? [];
		const stats = await Promise.all(changed.slice(0, 200).map(async file => {
			const resource = URI.file(file.path);
			const mtime = await this._fileService.stat(resource).then(stat => stat.mtime ?? 0, () => 0);
			return { resource, isNew: file.isNew, mtime };
		}));
		const byFolder = new Map<string, { folder: URI; files: { resource: URI; isNew: boolean; mtime: number }[] }>();
		for (const file of stats) {
			const folder = dirname(file.resource);
			const key = folder.toString();
			let group = byFolder.get(key);
			if (!group) {
				group = { folder, files: [] };
				byFolder.set(key, group);
			}
			group.files.push(file);
		}
		const folders = [...byFolder.values()].map(group => {
			group.files.sort((a, b) => b.mtime - a.mtime);
			return { folder: group.folder, files: group.files, mtime: group.files[0]?.mtime ?? 0, hasNew: group.files.some(file => file.isNew) };
		}).sort((a, b) => b.mtime - a.mtime);
		const key = (list: readonly IRailFolder[]) => list.map(folder => `${folder.folder}:${folder.files.length}:${folder.mtime}`).join('|');
		if (key(folders) !== key(this._folders)) {
			this._folders = folders;
			this._render();
		}
	}

	/** The folder's path from the project root, or its name outside it. */
	private _relative(folder: URI): string {
		const root = this._root;
		const path = root ? relativePath(root, folder) : undefined;
		return path === undefined ? basename(folder) : path || basename(root ?? folder);
	}

	private _render(): void {
		// The activity bar has no slot for custom content; its content element is the anchor.
		// eslint-disable-next-line no-restricted-syntax
		const content = this._layoutService.mainContainer.querySelector('.part.activitybar > .content');
		const show = !this._layoutService.isVisible(Parts.SIDEBAR_PART);
		if (!content || !show) {
			this._panel?.close();
			this._rail.remove();
			return;
		}
		if (this._rail.parentElement !== content) {
			// Right under the project dock, above the view icons.
			// eslint-disable-next-line no-restricted-syntax
			const dock = content.querySelector('.maut-project-dock');
			content.insertBefore(this._rail, dock ? dock.nextSibling : content.firstChild);
		}
		this._buttons.clear();
		dom.clearNode(this._rail);
		const button = (icon: HTMLElement, label: string, run: (element: HTMLElement) => void, extraClass = '') => {
			const element = dom.append(this._rail, dom.$<HTMLButtonElement>(`button.maut-rail-button${extraClass}`, { type: 'button' }));
			element.appendChild(icon);
			element.setAttribute('aria-label', label);
			this._buttons.add(this._hoverService.setupDelayedHover(element, { content: label, position: { hoverPosition: HoverPosition.RIGHT } }));
			this._buttons.add(dom.addDisposableListener(element, dom.EventType.CLICK, () => run(element)));
			return element;
		};
		const finderLabel = isMacintosh ? localize('maut.rail.findMac', "Find files and folders (\u21e7\u2318F)") : localize('maut.rail.find', "Find files and folders (Ctrl+Shift+F)");
		button(dom.$(`span${ThemeIcon.asCSSSelector(Codicon.search)}`), finderLabel, () => this._finder.toggle());

		const many = this._folders.length > railFolderSlots;
		const shown = this._folders.slice(0, many ? railFolderSlots - 1 : railFolderSlots);
		for (const folder of shown) {
			const icon = dom.$('span.maut-rail-folder');
			dom.append(icon, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.folder)}`));
			dom.append(icon, dom.$('span.maut-rail-caption', undefined, basename(folder.folder)));
			// One pill: the dot says new (green) or changed (amber), the number how many files.
			const pill = dom.append(icon, dom.$('span.maut-rail-pill'));
			dom.append(pill, dom.$(`span.maut-rail-pill-dot.${folder.hasNew ? 'new' : 'changed'}`));
			dom.append(pill, dom.$('span', undefined, String(folder.files.length)));
			const label = localize('maut.rail.folder', "{0}: {1} changed, {2}", this._relative(folder.folder), folder.files.length, fromNow(folder.mtime, true));
			button(icon, label, element => this._togglePanel(element, folder), '.folder');
		}
		if (many) {
			const icon = dom.$('span.maut-rail-folder');
			dom.append(icon, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.ellipsis)}`));
			dom.append(icon, dom.$('span.maut-rail-caption', undefined, localize('maut.rail.moreCount', "+{0}", this._folders.length - shown.length)));
			button(icon, localize('maut.rail.more', "All folders Claude worked in"), element => this._togglePanel(element, undefined), '.folder.more');
		}
		button(dom.$(`span${ThemeIcon.asCSSSelector(Codicon.folderOpened)}`), localize('maut.rail.browse', "Browse files"), () => this._finder.toggle());
	}

	/** Opens the panel beside the rail: every folder, newest first, with `open` expanded. */
	private _togglePanel(anchor: HTMLElement, open: IRailFolder | undefined): void {
		if (this._panel) {
			const same = anchor.classList.contains('active');
			this._panel.close();
			if (same) {
				return;
			}
		}
		anchor.classList.add('active');
		this._panel = this._contextViewService.showContextView({
			getAnchor: () => anchor,
			anchorAxisAlignment: AnchorAxisAlignment.HORIZONTAL,
			render: container => this._renderPanel(container, open),
			onHide: () => {
				anchor.classList.remove('active');
				this._panel = undefined;
			},
		});
	}

	private _renderPanel(container: HTMLElement, open: IRailFolder | undefined): IDisposable {
		const store = new DisposableStore();
		const panel = dom.append(container, dom.$('.maut-rail-panel'));
		const head = dom.append(panel, dom.$('.maut-rail-panel-head'));
		dom.append(head, dom.$('b', undefined, localize('maut.rail.panelTitle', "Where Claude worked")));
		const total = this._folders.reduce((sum, folder) => sum + folder.files.length, 0);
		dom.append(head, dom.$('span', undefined, localize('maut.rail.panelCount', "{0} files in {1} folders", total, this._folders.length)));
		const list = dom.append(panel, dom.$('.maut-rail-panel-list'));
		for (const folder of open ? [open, ...this._folders.filter(candidate => candidate !== open)] : this._folders) {
			const group = dom.append(list, dom.$('.maut-rail-group'));
			const row = dom.append(group, dom.$<HTMLButtonElement>('button.maut-rail-group-row', { type: 'button' }));
			dom.append(row, dom.$(`span.maut-rail-chevron${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
			dom.append(row, dom.$(`span.maut-rail-group-icon${ThemeIcon.asCSSSelector(Codicon.folder)}`));
			const names = dom.append(row, dom.$('span.maut-rail-group-names'));
			dom.append(names, dom.$('span.maut-rail-group-name', undefined, basename(folder.folder)));
			const parent = this._relative(dirname(folder.folder));
			if (parent && parent !== basename(folder.folder)) {
				dom.append(names, dom.$('span.maut-rail-group-path', undefined, parent));
			}
			dom.append(row, dom.$('span.maut-rail-group-count', undefined, String(folder.files.length)));
			dom.append(row, dom.$('span.maut-rail-time', undefined, fromNow(folder.mtime, true)));
			const files = dom.append(group, dom.$('.maut-rail-files'));
			for (const file of folder.files) {
				const item = dom.append(files, dom.$<HTMLButtonElement>('button.maut-rail-file', { type: 'button' }));
				const icon = dom.append(item, dom.$('span.maut-rail-icon.show-file-icons'));
				dom.append(icon, dom.$(`span.${getIconClasses(this._modelService, this._languageService, file.resource, FileKind.FILE).join('.')}`));
				dom.append(item, dom.$('span.maut-rail-file-name', undefined, basename(file.resource)));
				if (file.isNew) {
					dom.append(item, dom.$('span.maut-rail-badge', undefined, localize('maut.rail.new', "new")));
				}
				dom.append(item, dom.$('span.maut-rail-time', undefined, fromNow(file.mtime, true)));
				item.title = this._relative(file.resource);
				store.add(dom.addDisposableListener(item, dom.EventType.CLICK, () => {
					this._panel?.close();
					void this._editorService.openEditor({ resource: file.resource, options: { pinned: false } });
				}));
			}
			group.classList.toggle('open', folder === open);
			store.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => group.classList.toggle('open')));
		}
		if (!this._folders.length) {
			dom.append(list, dom.$('.maut-rail-empty', undefined, localize('maut.rail.empty', "Claude hasn't changed any files yet.")));
		}
		return store;
	}
}

registerWorkbenchContribution2(MautFinderRail.ID, MautFinderRail, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: openFinderCommandId,
			title: localize2('maut.finder.title', "Find Files and Folders"),
			category: localize2('maut.finder.category', "Dovo"),
			f1: true,
			keybinding: {
				// Above the Search view's own binding: names first, Contents is one Tab away.
				weight: KeybindingWeight.WorkbenchContrib + 100,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IMautFinderService).toggle();
	}
});
