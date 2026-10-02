/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DataTransfers } from '../../../../base/browser/dnd.js';
import * as dom from '../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { matchesFuzzy } from '../../../../base/common/filters.js';
import { basename, isAbsolute } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CodeDataTransfers, containsDragType } from '../../../../platform/dnd/browser/dnd.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMautClaudeService, MautClaudeLayoutMode, MautClaudeView } from './mautClaude.js';
import type { ITerminalInstance } from './terminal.js';
import { getFileResourcesFromDragEvent } from './terminalUri.js';
import type { IXtermCore } from './xterm-private.js';
import './media/mautClaudePane.css';

/** Contributed by the built-in `maut-claude-images` extension: the conversation in a terminal. */
const sessionCommandId = '_maut.claude.session';
const resolveImageCommandId = '_maut.claudeImages.resolve';
const headerHeight = 46;
const refreshInterval = 1500;
const imageFileRegex = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
/** Widest the terminal gets while Claude runs: a comfortable reading column. */
const maxColumnWidth = 1120;
const sidePadding = 24;
/** The live terminal strip under the Reader, framed like a chat composer. */
const composerMaxWidth = 820;
const composerMarginTop = 10;
const composerPaddingX = 14;
const composerPaddingY = 8;
const liveNoteHeight = 28;

type ClaudeItem =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'step'; readonly verb: string; readonly target: string; readonly file?: string }
	| { readonly kind: 'edit'; readonly file: string; readonly added: number; readonly removed: number; readonly lines: readonly (readonly ['a' | 'd', string])[]; readonly isNew: boolean }
	| { readonly kind: 'user'; readonly text: string; readonly images: number[] }
	| { readonly kind: 'interrupted' };

/** A background shell or an agent Claude started. */
interface IClaudeTask {
	readonly id: string;
	readonly kind: 'shell' | 'agent';
	readonly title: string;
	readonly agentType?: string;
	readonly outputFile?: string;
	readonly status: 'running' | 'completed' | 'failed' | 'killed';
	readonly start: number;
	readonly end?: number;
	readonly tail?: string;
}

interface IChangedFile {
	readonly path: string;
	readonly label: string;
	readonly isNew: boolean;
}

interface ILiveState {
	readonly block: string;
	readonly queued: string[];
	readonly status: string;
}

interface IClaudeTurn {
	readonly prompt: string;
	readonly images: number[];
	readonly time: number;
	readonly end: number;
	readonly items: ClaudeItem[];
}

interface IClaudeSessionView {
	readonly project: string;
	readonly model: string | undefined;
	readonly contextTokens: number | undefined;
	readonly contextWindow: number | undefined;
	readonly contextReport: { readonly used: string; readonly window: string; readonly percent: number; readonly time: number } | undefined;
	readonly status: 'working' | 'idle';
	readonly turns: readonly IClaudeTurn[];
	readonly changedFiles?: readonly (readonly IChangedFile[])[];
	readonly tasks?: readonly IClaudeTask[];
}

/**
 * The Claude pane: what a terminal editor shows while Claude Code runs in it. A header with the
 * project, model, context and status plus clear Reader | Terminal and Focus | IDE switches, and
 * either the Reader (the conversation as a chat, from Claude's transcript, over a strip of the
 * live terminal for typing) or the full terminal. When Claude isn't running, it stays out of the
 * way and the terminal editor looks as it always did.
 */
export class MautClaudePane extends Disposable {

	private readonly _header: HTMLElement;
	private readonly _reader: HTMLElement;
	private readonly _liveNote: HTMLElement;
	/** Marks on the Reader's right edge: one per prompt you sent (click to jump), one per edit. */
	private readonly _rail: HTMLElement;
	/** Elements of the current render, for the rail. */
	private _promptElements: HTMLElement[] = [];
	/** The rail mark for each prompt; close prompts share one mark. */
	private _railMarks: HTMLElement[] = [];
	/** Every prompt in a list, shown while you hover the rail: the way to jump when there are many. */
	private readonly _promptNav: HTMLElement;
	private readonly _promptNavHide = this._register(new MutableDisposable());
	private readonly _column: HTMLElement;
	private readonly _instanceDisposables = this._register(new DisposableStore());
	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _poll = this._register(new MutableDisposable<IntervalTimer>());
	private readonly _refreshSoon: RunOnceScheduler;
	private _instance: ITerminalInstance | undefined;
	private _session: IClaudeSessionView | undefined;
	private _renderedKey = '';
	/** Claude's in-progress output, mirrored from its screen until the transcript has it. */
	private readonly _live = dom.$('.mcp-live');
	private _liveText = '';
	private _liveStructure = '';
	/** Claude's live state as last read from its screen, for the header's "Now" line. */
	private _lastLive: ILiveState | undefined;
	private _now: HTMLElement | undefined;
	private _nowFile: string | undefined;
	private _liveBlock: HTMLElement | undefined;
	private _liveStatus: HTMLElement | undefined;
	private _wasReader = false;
	/** The Activity panel: Claude's background shells and agents. */
	private readonly _activity: HTMLElement;
	private _activityOpen = false;
	/** The agent whose conversation the panel shows, if any. */
	private _activityAgent: IClaudeTask | undefined;
	private _activityKey = '';
	private _activityBody: HTMLElement | undefined;
	private readonly _activityDisposables = this._register(new DisposableStore());
	/** A taller input, for long prompts and Claude's menus (like its agent picker). */
	private _composerExpanded = false;
	private readonly _expandButton: HTMLButtonElement;
	/** The Reader follows new output, like a chat, until you scroll up to read. */
	private _followBottom = true;
	/** Set while the Reader scrolls itself, so that scroll isn't taken as yours. */
	private _autoScrolling = false;
	private readonly _jumpToLatest: HTMLButtonElement;
	private _visible = false;
	private readonly _imagePaths = new Map<number, string | undefined>();
	/** Rows at the bottom of Claude's screen the composer shows: its prompt box (or a question). */
	private _composerRows = 6;
	private readonly _renderWatch = this._register(new MutableDisposable<DisposableStore>());
	/** The terminal currently rendered with Claude's larger reading font. */
	private _fontApplied: ITerminalInstance | undefined;

	constructor(
		private readonly _root: HTMLElement,
		private readonly _terminalHost: HTMLElement,
		private readonly _relayout: () => void,
		@IMautClaudeService private readonly _claudeService: IMautClaudeService,
		@ICommandService private readonly _commandService: ICommandService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
		this._root.classList.add('maut-claude-host');
		this._header = dom.$('.mcp-header');
		this._reader = dom.$('.mcp-reader');
		this._column = dom.append(this._reader, dom.$('.mcp-column'));
		this._root.insertBefore(this._reader, this._terminalHost);
		this._root.insertBefore(this._header, this._reader);
		this._liveNote = dom.$('.mcp-live-note', undefined, dom.$('i'), dom.$('span', undefined, localize('maut.claude.liveNote', "Live Claude terminal. What you type goes straight to Claude.")));
		this._expandButton = dom.append(this._liveNote, dom.$<HTMLButtonElement>('button.mcp-expand', { type: 'button' }));
		this._register(dom.addDisposableListener(this._expandButton, dom.EventType.CLICK, () => {
			this._composerExpanded = !this._composerExpanded;
			this._renderExpandButton();
			this._relayout();
			this._instance?.focus();
		}));
		this._renderExpandButton();
		this._root.appendChild(this._liveNote);
		this._activity = dom.append(this._root, dom.$('.mcp-activity'));
		this._rail = dom.append(this._root, dom.$('.mcp-rail'));
		this._promptNav = dom.append(this._root, dom.$('.mcp-prompt-nav'));
		for (const element of [this._rail, this._promptNav]) {
			this._register(dom.addDisposableListener(element, dom.EventType.MOUSE_ENTER, () => this._showPromptNav()));
			this._register(dom.addDisposableListener(element, dom.EventType.MOUSE_LEAVE, () => {
				const search = this._promptNavSearch();
				if (search && (search.value || dom.getActiveElement() === search)) {
					return; // you're searching: it stays until you pick, press Escape or click away
				}
				const handle = dom.getWindow(this._root).setTimeout(() => this._promptNav.classList.remove('open'), 220);
				this._promptNavHide.value = toDisposable(() => dom.getWindow(this._root).clearTimeout(handle));
			}));
		}
		this._register(dom.addDisposableListener(this._reader, 'scroll', () => {
			if (!this._autoScrolling) {
				this._followBottom = this._isAtBottom();
				this._jumpToLatest.classList.toggle('visible', !this._followBottom);
			}
			this._highlightRail();
		}));
		this._jumpToLatest = dom.append(this._root, dom.$<HTMLButtonElement>('button.mcp-jump-latest', { type: 'button' }, localize('maut.claude.jumpToLatest', "Jump to Latest")));
		this._register(dom.addDisposableListener(this._jumpToLatest, dom.EventType.CLICK, () => this._scrollToEnd(true)));
		// Anything that grows the conversation (new turns, live output, images loading) keeps the
		// latest in view while the Reader follows.
		const resizeObserver = this._register(new dom.DisposableResizeObserver('mautClaudeReader', () => this._scrollToEnd(), dom.getWindow(this._root)));
		this._register(resizeObserver.observe(this._column));
		this._register(resizeObserver.observe(this._reader));
		this._register(dom.addDisposableListener(this._promptNav, 'focusout', e => {
			if (!dom.isAncestor(e.relatedTarget as Node | null, this._promptNav)) {
				this._promptNav.classList.remove('open');
			}
		}));
		this._register(dom.addDisposableListener(this._reader, dom.EventType.KEY_DOWN, e => {
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
				e.preventDefault();
				this._searchPrompts();
				return;
			}
			if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
				e.preventDefault();
				this._jumpPrompt(e.key === 'ArrowUp' ? -1 : 1);
			}
		}));
		this._reader.tabIndex = 0;
		this._refreshSoon = this._register(new RunOnceScheduler(() => this._refresh(), 350));
		this._register(this._claudeService.onDidChange(() => this._update()));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('terminal.integrated.fontSize') || e.affectsConfiguration('terminal.integrated.lineHeight')) {
				this._fontApplied = undefined;
				this._updateFont();
			}
		}));
		this._register(dom.addDisposableListener(this._reader, dom.EventType.CLICK, e => this._onReaderClick(e)));
		this._registerFileDrop();
		this._register(dom.addDisposableListener(this._terminalHost, dom.EventType.KEY_DOWN, e => this._onComposerKey(e), true));
		this._update();
	}

	/** True while the terminal shown runs Claude, so the pane's header and Reader are in use. */
	get active(): boolean {
		return !!this._instance && this._claudeService.isClaude(this._instance);
	}

	setInstance(instance: ITerminalInstance | undefined): void {
		if (instance === this._instance) {
			return;
		}
		this._resetFont();
		this._instance = instance;
		this._followBottom = true;
		this._instanceDisposables.clear();
		this._session = undefined;
		this._renderedKey = '';
		this._imagePaths.clear();
		if (instance) {
			// Claude printing means the transcript is changing; refresh shortly after.
			this._instanceDisposables.add(instance.onData(() => this._refreshSoon.schedule()));
			instance.xtermReadyPromise.then(xterm => {
				if (xterm && instance === this._instance) {
					const store = new DisposableStore();
					let scheduled = false;
					store.add(xterm.raw.onRender(() => {
						if (!scheduled) {
							scheduled = true;
							dom.getWindow(this._root).requestAnimationFrame(() => {
								scheduled = false;
								this._measureComposer();
							});
						}
					}));
					this._renderWatch.value = store;
				}
			});
		} else {
			this._renderWatch.clear();
		}
		this._update();
	}

	/**
	 * Ctrl+Enter or Cmd+Enter sends what you typed now, even while Claude works, as in Claude's
	 * own terminal. Ctrl+Enter reaches Claude as a plain Enter here, so send Claude's other key
	 * for it, Ctrl+X then Ctrl+S, as two separate keys.
	 */
	private _onComposerKey(e: KeyboardEvent): void {
		if (!this.active || e.key !== 'Enter' || e.altKey || e.shiftKey || e.isComposing) {
			return;
		}
		// Sending something: bring the Reader back to the latest, where the reply will appear.
		this._scrollToEnd(true);
		if (!(e.ctrlKey || e.metaKey)) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const instance = this._instance;
		if (instance) {
			instance.sendText('\x18', false);
			dom.getWindow(this._root).setTimeout(() => instance.sendText('\x13', false), 60);
		}
	}

	/**
	 * Whether Claude is mid-turn. The session file lags behind, so also trust Claude's own footer,
	 * which offers "esc to interrupt" only while it works.
	 */
	private _isWorking(): boolean {
		if (this._session?.status === 'working') {
			return true;
		}
		const raw = this._instance?.xterm?.raw;
		if (!raw) {
			return false;
		}
		const buffer = raw.buffer.active;
		for (let row = raw.rows - 1; row >= Math.max(0, raw.rows - 4); row--) {
			if ((buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').includes('esc to interrupt')) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Claude's live state as its screen shows it, above the prompt box: the block it's on now (the
	 * transcript only gets a block once it's finished), the messages you queued, and its spinner.
	 */
	private _readLive(promptTop: number): ILiveState | undefined {
		const raw = this._instance?.xterm?.raw;
		if (!raw || !this._isWorking()) {
			return undefined;
		}
		const buffer = raw.buffer.active;
		const line = (row: number) => (buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').trimEnd();
		const isPrompt = (text: string) => /^\u276f\s/.test(text);
		const isBlock = (text: string) => /^\u23fa/.test(text);
		const isHint = (text: string) => /to send now|ctrl\+x ctrl\+s/i.test(text);
		// Walk up from the prompt box to where the live part starts: the latest block, or the prompt
		// Claude is answering. Below a "send now" hint, prompt lines are queued messages.
		let start = promptTop;
		let phase: 'status' | 'queue' | 'block' = 'status';
		for (let row = promptTop - 1; row >= Math.max(0, promptTop - 80); row--) {
			const text = line(row);
			if (phase === 'status' && isHint(text)) {
				phase = 'queue';
			} else if (phase === 'queue' && text.trim() && !isPrompt(text) && !/^\s/.test(text)) {
				phase = 'block';
			}
			if (isPrompt(text) && phase !== 'queue') {
				break;
			}
			start = row;
			if (isBlock(text)) {
				break;
			}
		}
		const state: { block: string[]; queued: string[]; status: string } = { block: [], queued: [], status: '' };
		let section: 'block' | 'queue' | 'status' | 'note' = 'block';
		for (let row = start; row < promptTop; row++) {
			const text = line(row);
			if (isPrompt(text) && section !== 'status' && section !== 'note') {
				section = 'queue';
				state.queued.push(text.replace(/^\u276f\s*/, ''));
			} else if (isHint(text)) {
				section = 'block';
			} else if (/^\S\s\S.*\u2026/.test(text) && !isBlock(text) && !isPrompt(text)) {
				section = 'status';
				state.status = text.replace(/^\S\s/, '');
			} else if (section === 'queue' && /^\s+\S/.test(text)) {
				state.queued[state.queued.length - 1] += ` ${text.trim()}`;
			} else if (section === 'status' || section === 'note') {
				section = 'note'; // the spinner's notes and tips: noise in the Reader
			} else if (section === 'block') {
				state.block.push(text);
			}
		}
		while (state.block.length && !state.block.at(-1)!.trim()) {
			state.block.pop();
		}
		let block = state.block.join('\n').trim();
		// Already in the transcript? Then the Reader shows it properly.
		const first = block.split('\n')[0].replace(/^\u23fa\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
		const last = this._session?.turns.at(-1)?.items.at(-1);
		if (first && last?.kind === 'text' && last.text.replace(/\s+/g, ' ').startsWith(first)) {
			block = '';
		}
		return { block: block.replace(/^\u23fa\s*/, ''), queued: state.queued, status: state.status };
	}

	private _updateLive(promptTop: number): void {
		const live = this._readLive(promptTop);
		this._lastLive = live;
		this._updateNow();
		const key = live ? JSON.stringify(live) : '';
		if (key === this._liveText) {
			return;
		}
		const structure = live ? `${!!live.block}:${live.queued.join('\n')}:${!!live.status}` : '';
		const sameStructure = structure === this._liveStructure;
		this._liveText = key;
		this._liveStructure = structure;
		this._live.classList.toggle('visible', !!live && !!(live.block || live.queued.length || live.status));
		if (!live) {
			dom.clearNode(this._live);
			return;
		}
		// Only text changed (the spinner's timer, more output): update in place, no rebuild, no blink.
		if (sameStructure && this._live.childElementCount) {
			if (this._liveBlock) {
				this._liveBlock.textContent = live.block;
			}
			if (this._liveStatus) {
				this._liveStatus.textContent = live.status;
			}
		} else {
			dom.clearNode(this._live);
			this._liveBlock = live.block ? dom.append(this._live, dom.$('.mcp-live-block', undefined, live.block)) : undefined;
			for (const queued of live.queued) {
				const user = dom.append(this._live, dom.$('.mcp-user.mcp-queued'));
				const bubble = dom.append(user, dom.$('.mcp-bubble'));
				dom.append(bubble, dom.$('.mcp-prompt', undefined, queued));
				dom.append(bubble, dom.$('.mcp-queued-note', undefined, localize('maut.claude.queuedNote', "Queued. Claude reads it after this step, or press Ctrl+Enter to send it now.")));
			}
			this._liveStatus = undefined;
			if (live.status) {
				this._liveStatus = dom.$('span', undefined, live.status);
				dom.append(this._live, dom.$('.mcp-live-status', undefined, dom.$('i'), this._liveStatus));
			}
		}
		this._scrollToEnd();
	}

	private _isAtBottom(): boolean {
		return this._reader.scrollTop + this._reader.clientHeight >= this._reader.scrollHeight - 48;
	}

	/** Show the latest, instantly: a smooth scroll would read as "you scrolled up" mid-way. */
	private _scrollToEnd(force = false): void {
		if (force) {
			this._followBottom = true;
			this._jumpToLatest.classList.remove('visible');
		}
		if (!this._followBottom || this._isAtBottom() && !force) {
			return;
		}
		this._autoScrolling = true;
		this._reader.scrollTo({ top: this._reader.scrollHeight, behavior: 'instant' });
		dom.getWindow(this._root).requestAnimationFrame(() => this._autoScrolling = false);
	}

	/** Rows of the two lowest rules on Claude's screen: the bottom and top of its prompt box. */
	private _findRules(): number[] {
		const raw = this._instance?.xterm?.raw;
		const rules: number[] = [];
		if (!raw) {
			return rules;
		}
		const buffer = raw.buffer.active;
		for (let row = raw.rows - 1; row >= Math.max(0, raw.rows - 30) && rules.length < 2; row--) {
			const text = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '';
			if (/^\s*[\u2500\u2501]{8,}\s*$/.test(text)) {
				rules.push(row);
			}
		}
		return rules;
	}

	/** Files dropped anywhere on Claude (the Reader included) go to Claude's prompt as paths. */
	private _registerFileDrop(): void {
		const accepts = (e: DragEvent) => this.active && !!this._instance && containsDragType(e, DataTransfers.FILES, DataTransfers.RESOURCES, CodeDataTransfers.FILES);
		this._register(new dom.DragAndDropObserver(this._root, {
			onDragOver: e => {
				if (accepts(e)) {
					e.preventDefault();
					this._root.classList.add('mcp-drop-target');
				}
			},
			onDragLeave: () => this._root.classList.remove('mcp-drop-target'),
			onDragEnd: () => this._root.classList.remove('mcp-drop-target'),
			onDrop: e => {
				this._root.classList.remove('mcp-drop-target');
				if (!accepts(e)) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				const paths = getFileResourcesFromDragEvent(e);
				if (paths.length) {
					this._instance?.insertDroppedFiles(paths);
				}
			},
		}));
	}

	setVisible(visible: boolean): void {
		this._visible = visible;
		this._updatePolling();
	}

	/** Lay out header and Reader; returns the size the terminal itself should take. */
	layout(dimension: dom.Dimension): dom.Dimension {
		const host = this._terminalHost.style;
		const reader = this.active && this._claudeService.view === 'reader';
		this._terminalHost.classList.toggle('mcp-composer', reader);
		if (!this.active) {
			host.height = host.width = host.margin = host.padding = '';
			return dimension;
		}
		this._header.classList.toggle('mcp-compact', dimension.width < 900);
		this._header.classList.toggle('mcp-narrow', dimension.width < 700);
		const body = Math.max(0, dimension.height - headerHeight);
		// A centered reading column instead of edge-to-edge text.
		const width = Math.max(0, Math.min(dimension.width - sidePadding * 2, maxColumnWidth));
		host.width = `${width}px`;
		host.margin = '0 auto';
		if (!reader) {
			this._activity.style.bottom = '0px';
			this._reader.style.height = '0px';
			host.height = `${body}px`;
			host.padding = '10px 0 0';
			return new dom.Dimension(width, body - 10);
		}
		// Reader: the conversation above; below it the live terminal framed as a composer. The
		// terminal keeps a full-height screen so Claude lays out normally, but the frame shows only
		// its bottom rows: the prompt box, or a question Claude is asking.
		const cell = this._cellHeight();
		const terminalRows = Math.max(12, Math.floor(body * 0.85 / cell));
		const visibleRows = Math.min(this._composerExpanded ? Math.max(this._composerRows, Math.floor(terminalRows * 0.75)) : this._composerRows, terminalRows);
		const composer = Math.round(visibleRows * cell) + composerPaddingY * 2 + 2;
		const composerWidth = Math.max(0, Math.min(dimension.width - sidePadding * 2, composerMaxWidth));
		const readerHeight = Math.max(0, body - composer - composerMarginTop - liveNoteHeight);
		this._reader.style.height = `${readerHeight}px`;
		this._jumpToLatest.style.bottom = `${composer + composerMarginTop + liveNoteHeight + 14}px`;
		// The Activity panel ends above the input, so both stay in view.
		this._activity.style.bottom = `${composer + composerMarginTop + liveNoteHeight}px`;
		this._rail.style.top = `${headerHeight + 8}px`;
		this._rail.style.height = `${Math.max(0, readerHeight - 16)}px`;
		this._promptNav.style.top = `${headerHeight + 8}px`;
		this._promptNav.style.maxHeight = `${Math.max(0, readerHeight - 16)}px`;
		dom.getWindow(this._root).requestAnimationFrame(() => this._renderRail());
		host.width = `${composerWidth}px`;
		host.height = `${composer}px`;
		host.margin = `${composerMarginTop}px auto 0`;
		host.padding = `${composerPaddingY}px ${composerPaddingX}px`;
		this._liveNote.style.width = `${composerWidth}px`;
		// Border (1px each side) and padding come out of the terminal's own width.
		return new dom.Dimension(composerWidth - composerPaddingX * 2 - 2, Math.round(terminalRows * cell));
	}

	private _update(): void {
		this._updateFont();
		const active = this.active;
		const reader = active && this._claudeService.view === 'reader';
		if (reader && !this._wasReader) {
			// Back to the Reader (from Terminal, or a new Claude): show the latest once laid out.
			dom.getWindow(this._root).requestAnimationFrame(() => this._scrollToEnd(true));
		}
		this._wasReader = reader;
		this._root.classList.toggle('maut-claude-active', active);
		this._root.classList.toggle('maut-claude-reader', active && this._claudeService.view === 'reader');
		if (active) {
			this._renderHeader();
			this._refresh();
		}
		this._updatePolling();
		this._relayout();
	}

	private _cellHeight(): number {
		const xterm = this._instance?.xterm;
		const core = (xterm?.raw as unknown as { _core?: IXtermCore } | undefined)?._core;
		const height = core?._renderService?.dimensions.css.cell.height;
		return height && height > 0 ? height : 19;
	}

	/**
	 * Find how much of the bottom of Claude's screen belongs to its input: from the top rule of
	 * the prompt box (Claude draws a rule above and below the chevron line) down. Anything else at the
	 * bottom, like a permission question, gets a taller frame, within limits.
	 */
	private _measureComposer(): void {
		const raw = this._instance?.xterm?.raw;
		if (!raw || !this.active || this._claudeService.view !== 'reader') {
			return;
		}
		const rules = this._findRules();
		this._updateLive(rules.length === 2 ? rules[1] : raw.rows - 12);
		// The frame shows just the prompt box (or a question Claude asks): stable while Claude works.
		const rows = rules.length === 2 ? raw.rows - rules[1] : 12;
		const capped = Math.max(3, Math.min(rows, Math.floor(raw.rows * 0.6)));
		if (capped !== this._composerRows) {
			this._composerRows = capped;
			this._relayout();
		}
	}

	/** Larger text and line spacing while Claude runs; the terminal settings otherwise. */
	private async _updateFont(): Promise<void> {
		const instance = this._instance;
		if (!instance || !this.active) {
			this._resetFont();
			return;
		}
		if (this._fontApplied === instance) {
			return;
		}
		this._fontApplied = instance;
		const xterm = await instance.xtermReadyPromise;
		if (!xterm || this._fontApplied !== instance) {
			return;
		}
		const size = this._configurationService.getValue<number>('terminal.integrated.fontSize') || 12;
		const lineHeight = this._configurationService.getValue<number>('terminal.integrated.lineHeight') || 1;
		xterm.setFontOverride({ fontSize: Math.max(size + 2, 14), lineHeight: Math.max(lineHeight, 1.3) });
		this._refitFont(instance);
	}

	private _resetFont(): void {
		const instance = this._fontApplied;
		this._fontApplied = undefined;
		if (instance && !instance.isDisposed && instance.xterm) {
			instance.xterm.setFontOverride(undefined);
			this._refitFont(instance);
		}
	}

	/** Re-measure now, and once more after xterm has drawn at the new size. */
	private _refitFont(instance: ITerminalInstance): void {
		instance.refreshFont();
		dom.getWindow(this._root).setTimeout(() => {
			if (!instance.isDisposed) {
				instance.refreshFont();
			}
		}, 150);
	}

	private _updatePolling(): void {
		if (this.active && this._visible) {
			if (!this._poll.value) {
				const timer = new IntervalTimer();
				timer.cancelAndSet(() => this._refresh(), refreshInterval);
				this._poll.value = timer;
			}
		} else {
			this._poll.clear();
		}
	}

	private async _refresh(): Promise<void> {
		const instance = this._instance;
		if (!instance || !this.active) {
			return;
		}
		let session: IClaudeSessionView | undefined;
		try {
			session = await this._commandService.executeCommand<IClaudeSessionView>(sessionCommandId, instance.processId);
		} catch {
			return;
		}
		if (instance !== this._instance) {
			return;
		}
		if (!session) {
			if (this._renderedKey !== 'none') {
				this._renderedKey = 'none';
				dom.clearNode(this._column);
				dom.append(this._column, dom.$('.mcp-empty', undefined, localize('maut.claude.noSession', "The conversation appears here once Claude has saved it. Type below to start.")));
			}
			return;
		}
		this._session = session;
		this._renderHeader();
		this._renderActivity();
		const last = session.turns.at(-1);
		const changed = session.changedFiles?.map(files => files.map(file => file.label).join(',')).join('|') ?? '';
		const key = `${session.turns.length}:${last?.items.length}:${last?.end}:${session.status}:${changed}`;
		if (key !== this._renderedKey) {
			this._renderedKey = key;
			this._renderConversation();
		}
	}

	// ---------- Header ----------

	// ---------- Now: what Claude is doing right now ----------

	/**
	 * The header's "Now" line while Claude works: "Editing mautProjectDock.ts · 14s". From Claude's
	 * screen first (the block it's on and its spinner's timer), else its latest step in the transcript.
	 */
	private _updateNow(): void {
		const now = this._now;
		if (!now) {
			return;
		}
		const activity = this.active && this._isWorking() ? this._currentActivity() : undefined;
		now.classList.toggle('visible', !!activity);
		this._nowFile = activity?.file;
		if (!activity) {
			return;
		}
		const text = activity.elapsed ? `${activity.label} \u00b7 ${activity.elapsed}` : activity.label;
		if (now.textContent !== text) {
			dom.clearNode(now);
			dom.append(now, dom.$('i'));
			dom.append(now, dom.$('span', undefined, text));
			now.title = activity.file
				? localize('maut.claude.nowOpen', "{0}. Click to open the file.", activity.label)
				: localize('maut.claude.nowJump', "{0}. Click to see the latest.", activity.label);
		}
	}

	private _currentActivity(): { label: string; file?: string; elapsed?: string } {
		const live = this._lastLive;
		// The spinner reads "Catapulting... (2m 14s \u00b7 ...)": its first figure is how long this has run.
		const elapsed = /\((?<time>(?:\d+h\s*)?(?:\d+m\s*)?\d+s)/.exec(live?.status ?? '')?.groups?.time;
		const first = live?.block.split('\n')[0].trim() ?? '';
		const call = /^(?<tool>[A-Z][A-Za-z]+)\((?<arg>.*?)\)?$/.exec(first)?.groups;
		if (call) {
			return { ...describeActivity(call.tool, call.arg), elapsed };
		}
		// A command Claude described shows as its description, then "\u23bf $ command".
		const second = live?.block.split('\n')[1] ?? '';
		if (first && /^\s*\u23bf\s+\$\s/.test(second)) {
			return { label: first, elapsed };
		}
		if (first) {
			return { label: localize('maut.claude.nowWriting', "Writing a reply"), elapsed };
		}
		const last = this._session?.turns.at(-1)?.items.at(-1);
		if (last?.kind === 'step') {
			return { ...describeActivity(last.verb, last.target, last.file), elapsed };
		}
		if (last?.kind === 'edit') {
			return { label: localize('maut.claude.nowEditing', "Editing {0}", basename(last.file)), file: last.file, elapsed };
		}
		return { label: localize('maut.claude.nowThinking', "Thinking"), elapsed };
	}

	private _onNowClick(): void {
		const file = this._nowFile;
		if (file) {
			this._openFile(file);
		} else {
			this._scrollToEnd(true);
		}
	}

	private _renderExpandButton(): void {
		this._expandButton.textContent = this._composerExpanded ? localize('maut.claude.collapseInput', "Smaller Input") : localize('maut.claude.expandInput', "Larger Input");
		this._expandButton.setAttribute('aria-pressed', String(this._composerExpanded));
	}

	// ---------- Activity: background shells and agents ----------

	private _activityButton(session: IClaudeSessionView | undefined): HTMLElement {
		const tasks = session?.tasks ?? [];
		const running = tasks.filter(task => task.status === 'running').length;
		const button = dom.$<HTMLButtonElement>('button.mcp-activity-button', { type: 'button' });
		button.classList.toggle('on', this._activityOpen);
		button.classList.toggle('busy', running > 0);
		dom.append(button, dom.$('i'));
		dom.append(button, dom.$('span', undefined, running
			? localize('maut.claude.activityRunning', "{0} running", running)
			: localize('maut.claude.activity', "Activity")));
		button.title = localize('maut.claude.activityTitle', "Background shells and agents Claude started");
		button.addEventListener('click', () => {
			this._activityOpen = !this._activityOpen;
			this._activityAgent = undefined;
			this._activityKey = '';
			this._renderHeader();
			this._renderActivity();
		});
		return button;
	}

	private async _renderActivity(): Promise<void> {
		this._activity.classList.toggle('open', this._activityOpen && this.active);
		if (!this._activityOpen || !this.active) {
			this._activityKey = '';
			return;
		}
		const agent = this._activityAgent;
		const turns = agent ? (await this._commandService.executeCommand<{ turns: IClaudeTurn[] }>('_maut.claude.agent', this._instance?.processId, agent.id).catch(() => undefined))?.turns ?? [] : [];
		const tasks = this._session?.tasks ?? [];
		const current = agent ? tasks.find(task => task.id === agent.id) ?? agent : undefined;
		const key = agent
			? `agent:${agent.id}:${current?.status}:${turns.length}:${turns.at(-1)?.items.length}`
			: `list:${tasks.map(task => `${task.id}:${task.status}:${task.tail ?? ''}`).join('|')}:${Math.floor(Date.now() / 10000)}`;
		if (key === this._activityKey) {
			return;
		}
		this._activityKey = key;
		const scroll = this._activityBody?.scrollTop ?? 0;
		this._activityDisposables.clear();
		dom.clearNode(this._activity);

		const head = dom.append(this._activity, dom.$('.mcp-activity-head'));
		if (agent) {
			const back = dom.append(head, dom.$<HTMLButtonElement>('button.mcp-activity-back', { type: 'button' }, localize('maut.claude.back', "Back")));
			this._activityDisposables.add(dom.addDisposableListener(back, dom.EventType.CLICK, () => {
				this._activityAgent = undefined;
				this._activityKey = '';
				this._renderActivity();
			}));
		}
		dom.append(head, dom.$('span.mcp-activity-title', undefined, agent ? agent.title : localize('maut.claude.activityHead', "Background Shells and Agents")));
		const close = dom.append(head, dom.$<HTMLButtonElement>('button.mcp-activity-close', { type: 'button' }, localize('maut.claude.close', "Close")));
		this._activityDisposables.add(dom.addDisposableListener(close, dom.EventType.CLICK, () => {
			this._activityOpen = false;
			this._renderHeader();
			this._renderActivity();
		}));

		const content = this._activityBody = dom.append(this._activity, dom.$('.mcp-activity-body'));
		if (agent && current) {
			dom.append(content, dom.$('.mcp-activity-meta', undefined, this._taskMeta(current)));
			for (const turn of turns) {
				if (turn.prompt) {
					dom.append(content, dom.$('.mcp-agent-prompt', undefined, turn.prompt));
				}
				for (const item of turn.items) {
					if (item.kind === 'text') {
						const rendered = this._activityDisposables.add(renderMarkdown(new MarkdownString(item.text), {
							actionHandler: link => this._openerService.open(link, { fromUserGesture: true, allowCommands: false }),
						}));
						rendered.element.classList.add('mcp-prose');
						content.appendChild(rendered.element);
					} else if (item.kind === 'step') {
						const step = dom.append(content, dom.$('.mcp-step'));
						dom.append(step, dom.$('span.mcp-verb', undefined, item.verb));
						const target = dom.append(step, dom.$('span.mcp-target', undefined, item.target));
						if (item.file) {
							target.classList.add('mcp-file');
							target.dataset.file = item.file;
						}
					} else if (item.kind === 'edit') {
						content.appendChild(this._renderEdit(item));
					}
				}
			}
			if (!turns.length) {
				dom.append(content, dom.$('.mcp-activity-empty', undefined, localize('maut.claude.agentEmpty', "This agent hasn't written anything yet.")));
			}
		} else {
			const shells = tasks.filter(task => task.kind === 'shell');
			const agents = tasks.filter(task => task.kind === 'agent');
			if (!tasks.length) {
				dom.append(content, dom.$('.mcp-activity-empty', undefined, localize('maut.claude.activityEmpty', "When Claude runs a command in the background or starts an agent, it shows up here.")));
			}
			if (agents.length) {
				dom.append(content, dom.$('.mcp-activity-section', undefined, localize('maut.claude.agents', "Agents")));
				for (const task of agents) {
					const row = dom.append(content, dom.$<HTMLButtonElement>(`button.mcp-task.${task.status}`, { type: 'button' }));
					dom.append(row, dom.$('i.mcp-task-dot'));
					const text = dom.append(row, dom.$('.mcp-task-text'));
					dom.append(text, dom.$('.mcp-task-title', undefined, task.title));
					dom.append(text, dom.$('.mcp-task-meta', undefined, this._taskMeta(task)));
					this._activityDisposables.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
						this._activityAgent = task;
						this._activityKey = '';
						this._renderActivity();
					}));
				}
			}
			if (shells.length) {
				dom.append(content, dom.$('.mcp-activity-section', undefined, localize('maut.claude.shells', "Background Shells")));
				for (const task of shells) {
					const row = dom.append(content, dom.$(`.mcp-task.${task.status}`));
					dom.append(row, dom.$('i.mcp-task-dot'));
					const text = dom.append(row, dom.$('.mcp-task-text'));
					dom.append(text, dom.$('.mcp-task-title', undefined, task.title));
					dom.append(text, dom.$('.mcp-task-meta', undefined, this._taskMeta(task)));
					if (task.tail) {
						dom.append(text, dom.$('.mcp-task-tail', undefined, task.tail));
					}
					const actions = dom.append(text, dom.$('.mcp-task-actions'));
					if (task.outputFile) {
						const output = dom.append(actions, dom.$<HTMLButtonElement>('button', { type: 'button' }, localize('maut.claude.output', "Output")));
						output.dataset.file = task.outputFile;
						this._activityDisposables.add(dom.addDisposableListener(output, dom.EventType.CLICK, () => this._editorService.openEditor({ resource: URI.file(task.outputFile!), options: { pinned: false } })));
					}
					if (task.status === 'running') {
						const stop = dom.append(actions, dom.$<HTMLButtonElement>('button.mcp-task-stop', { type: 'button' }, localize('maut.claude.stop', "Stop")));
						this._activityDisposables.add(dom.addDisposableListener(stop, dom.EventType.CLICK, async () => {
							stop.disabled = true;
							await this._commandService.executeCommand('_maut.claude.stopShell', this._instance?.processId, task.id);
							this._refreshSoon.schedule();
						}));
					}
				}
			}
		}
		content.scrollTop = scroll;
	}

	private _taskMeta(task: IClaudeTask): string {
		const status = task.status === 'running' ? localize('maut.claude.taskRunning', "Running")
			: task.status === 'completed' ? localize('maut.claude.taskDone', "Done")
				: task.status === 'killed' ? localize('maut.claude.taskStopped', "Stopped")
					: localize('maut.claude.taskFailed', "Failed");
		const took = duration((task.end ?? Date.now()) - task.start);
		return task.kind === 'agent' ? `${task.agentType ?? ''} \u00b7 ${status} \u00b7 ${took}` : `${status} \u00b7 ${took}`;
	}

	private _renderHeader(): void {
		const session = this._session;
		const project = session?.project || this._workspaceContextService.getWorkspace().folders[0]?.name || localize('maut.claude.title', "Claude");
		const meta = session?.model ? modelLabel(session.model) : '';
		const status = !session ? 'starting' : this._isWorking() ? 'working' : session.status;
		const statusText = status === 'working' ? localize('maut.claude.working', "Working") : status === 'idle' ? localize('maut.claude.ready', "Ready") : localize('maut.claude.starting', "Starting");

		dom.clearNode(this._header);
		dom.append(this._header, dom.$('span.mcp-avatar'));
		dom.append(this._header, dom.$('span.mcp-name', undefined, project));
		dom.append(this._header, dom.$('span.mcp-meta', undefined, meta));
		this._now = dom.append(this._header, dom.$<HTMLButtonElement>('button.mcp-now', { type: 'button' }));
		this._now.addEventListener('click', () => this._onNowClick());
		this._updateNow();
		dom.append(this._header, dom.$('span.mcp-grow'));
		this._header.appendChild(this._activityButton(session));
		this._header.appendChild(this._contextButton(session));
		dom.append(this._header, dom.$(`span.mcp-status.${status}`, undefined, dom.$('i'), dom.$('span', undefined, statusText)));
		this._header.append(
			this._segment<MautClaudeView>(localize('maut.claude.viewLabel', "View"), [
				['reader', localize('maut.claude.reader', "Reader"), undefined],
				['terminal', localize('maut.claude.terminal', "Terminal"), undefined],
			], this._claudeService.view, view => this._claudeService.setView(view)),
			this._segment<MautClaudeLayoutMode>(localize('maut.claude.layoutLabel', "Layout"), [
				['focus', localize('maut.claude.focus', "Focus"), undefined],
				['ide', localize('maut.claude.ide', "IDE"), '⌘B'],
			], this._claudeService.layoutMode, mode => this._claudeService.requestLayoutMode(mode)),
		);
	}

	/** How full Claude's context is, read from its transcript after every reply; never types into Claude. */
	private _contextButton(session: IClaudeSessionView | undefined): HTMLElement {
		const element = dom.$('span.mcp-context');
		const tokens = session?.contextTokens;
		const window = session?.contextWindow;
		if (tokens === undefined || !window) {
			element.textContent = localize('maut.claude.contextPending', "Context after Claude's first reply");
			return element;
		}
		dom.append(element, dom.$('b', undefined, localize('maut.claude.contextPercent', "{0}% context", Math.min(100, Math.round(tokens / window * 100)))));
		dom.append(element, dom.$('span', undefined, `${formatTokens(tokens)} / ${formatTokens(window)}`));
		element.title = localize('maut.claude.contextTitle', "Tokens in Claude's context after its last reply, out of its context window. Run /context in Claude for the full breakdown.");
		return element;
	}

	private _segment<T extends string>(label: string, options: [T, string, string | undefined][], current: T, pick: (value: T) => void): HTMLElement {
		const group = dom.$('.mcp-seg');
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', label);
		for (const [value, text, hint] of options) {
			const button = dom.append(group, dom.$<HTMLButtonElement>('button.mcp-seg-button', { type: 'button' }, text));
			if (hint) {
				dom.append(button, dom.$('kbd', undefined, hint));
			}
			button.classList.toggle('on', value === current);
			button.setAttribute('aria-pressed', String(value === current));
			button.addEventListener('click', () => pick(value));
		}
		return group;
	}

	// ---------- Reader ----------

	private _renderConversation(): void {
		const session = this._session;
		if (!session) {
			return;
		}
		this._renderDisposables.clear();
		dom.clearNode(this._column);
		this._promptElements = [];
		if (!session.turns.length) {
			dom.append(this._column, dom.$('.mcp-empty', undefined, localize('maut.claude.empty', "Your conversation with Claude shows up here. Type below to start.")));
		}
		session.turns.forEach((turn, index) => {
			const isLast = index === session.turns.length - 1;
			this._column.appendChild(this._renderTurn(turn, isLast && session.status === 'working', session.changedFiles?.[index] ?? []));
		});
		// Claude's in-progress output, live from its screen.
		this._column.appendChild(this._live);
		this._scrollToEnd();
		this._renderRail();
	}

	// ---------- Prompt rail ----------

	private _renderRail(): void {
		dom.clearNode(this._rail);
		this._railMarks = [];
		const total = this._reader.scrollHeight;
		const height = this._rail.clientHeight;
		if (!total || !this._reader.clientHeight || !height) {
			return;
		}
		// A thin tick per prompt; prompts closer than a few pixels share a tick, so a long
		// conversation stays a calm line instead of a pile of dots. The hover list has them all.
		let last: { mark: HTMLElement; y: number } | undefined;
		this._promptElements.forEach((prompt, index) => {
			const y = Math.min(height, (prompt.offsetTop / total) * height);
			if (last && y - last.y < 6) {
				this._railMarks.push(last.mark);
				return;
			}
			const mark = dom.append(this._rail, dom.$<HTMLButtonElement>('button.mcp-rail-prompt', { type: 'button' }));
			mark.style.top = `${y}px`;
			mark.setAttribute('aria-label', localize('maut.claude.jumpToPrompt', "Prompt {0}", index + 1));
			mark.addEventListener('click', () => this._scrollToPrompt(prompt));
			this._railMarks.push(mark);
			last = { mark, y };
		});
		this._highlightRail();
	}

	private _showPromptNav(): void {
		this._promptNavHide.clear();
		if (this._promptNav.classList.contains('open') || !this._promptElements.length) {
			return;
		}
		dom.clearNode(this._promptNav);
		const head = dom.append(this._promptNav, dom.$('.mcp-prompt-nav-head'));
		const search = dom.append(head, dom.$<HTMLInputElement>('input.mcp-prompt-nav-search', {
			type: 'text',
			spellcheck: 'false',
			placeholder: localize('maut.claude.searchPrompts', "Search your {0} prompts", this._promptElements.length),
		}));
		const list = dom.append(this._promptNav, dom.$('.mcp-prompt-nav-list'));
		const prompts = this._promptElements.map((element, index) => ({ element, index, text: (element.textContent ?? '').trim() || localize('maut.claude.imageOnly', "(image)") }));
		const current = this._currentPrompt();
		let rows: { row: HTMLElement; element: HTMLElement }[] = [];
		let selected = -1;
		const select = (index: number) => {
			rows[selected]?.row.classList.remove('selected');
			selected = Math.max(0, Math.min(rows.length - 1, index));
			rows[selected]?.row.classList.add('selected');
			rows[selected]?.row.scrollIntoView({ block: 'nearest' });
		};
		const jump = (element: HTMLElement) => {
			this._scrollToPrompt(element);
			this._promptNav.classList.remove('open');
		};
		const render = () => {
			dom.clearNode(list);
			rows = [];
			const query = search.value.trim();
			let currentRow: HTMLElement | undefined;
			for (const prompt of prompts) {
				// Fuzzy, like Quick Open: "dck str" finds "dock ... star".
				const matches = query ? matchesFuzzy(query, prompt.text, true) : [];
				if (!matches) {
					continue;
				}
				const row = dom.append(list, dom.$<HTMLButtonElement>('button.mcp-prompt-nav-row', { type: 'button' }));
				dom.append(row, dom.$('span.mcp-prompt-nav-n', undefined, String(prompt.index + 1)));
				const text = dom.append(row, dom.$('span.mcp-prompt-nav-text'));
				let at = 0;
				for (const match of matches) {
					text.append(prompt.text.slice(at, match.start));
					dom.append(text, dom.$('mark', undefined, prompt.text.slice(match.start, match.end)));
					at = match.end;
				}
				text.append(prompt.text.slice(at));
				row.classList.toggle('current', prompt.index === current);
				if (prompt.index === current) {
					currentRow = row;
				}
				row.addEventListener('click', () => jump(prompt.element));
				rows.push({ row, element: prompt.element });
			}
			if (!rows.length) {
				dom.append(list, dom.$('.mcp-prompt-nav-empty', undefined, localize('maut.claude.noPromptMatch', "No prompt matches")));
			}
			selected = -1;
			if (query) {
				select(0);
			} else {
				currentRow?.scrollIntoView({ block: 'center' });
			}
		};
		search.addEventListener('input', render);
		search.addEventListener('keydown', e => {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				select(selected + (e.key === 'ArrowDown' ? 1 : -1));
			} else if (e.key === 'Enter' && rows[Math.max(0, selected)]) {
				e.preventDefault();
				jump(rows[Math.max(0, selected)].element);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this._promptNav.classList.remove('open');
				this._reader.focus();
			}
		});
		render();
		this._promptNav.classList.add('open');
	}

	/** Search your prompts: from the keyboard (Cmd/Ctrl+Shift+F in the Reader) or the rail. */
	private _searchPrompts(): void {
		this._promptNav.classList.remove('open');
		this._showPromptNav();
		this._promptNavSearch()?.focus();
	}

	private _promptNavSearch(): HTMLInputElement | undefined {
		const head = this._promptNav.firstElementChild?.firstElementChild;
		return dom.isHTMLInputElement(head) ? head : undefined;
	}

	private _currentPrompt(): number {
		const top = this._reader.scrollTop + 60;
		let current = -1;
		this._promptElements.forEach((prompt, index) => {
			if (prompt.offsetTop <= top) {
				current = index;
			}
		});
		return current;
	}

	private _highlightRail(): void {
		const current = this._railMarks[this._currentPrompt()];
		for (const mark of new Set(this._railMarks)) {
			mark.classList.toggle('current', mark === current);
		}
	}

	private _jumpPrompt(direction: 1 | -1): void {
		const prompts = this._promptElements;
		const top = this._reader.scrollTop + 4;
		const target = direction < 0
			? [...prompts].reverse().find(prompt => prompt.offsetTop < top - 8)
			: prompts.find(prompt => prompt.offsetTop > top + 8);
		if (target) {
			this._scrollToPrompt(target);
		}
	}

	private _scrollToPrompt(prompt: HTMLElement): void {
		this._reader.scrollTo({ top: Math.max(0, prompt.offsetTop - 16), behavior: 'smooth' });
		prompt.classList.add('mcp-flash');
		dom.getWindow(this._root).setTimeout(() => prompt.classList.remove('mcp-flash'), 900);
	}

	private _renderTurn(turn: IClaudeTurn, live: boolean, changedFiles: readonly IChangedFile[]): HTMLElement {
		const element = dom.$('.mcp-turn');
		if (turn.prompt || turn.images.length) {
			const user = dom.append(element, dom.$('.mcp-user'));
			this._promptElements.push(user);
			const bubble = dom.append(user, dom.$('.mcp-bubble'));
			if (turn.prompt) {
				dom.append(bubble, dom.$('.mcp-prompt', undefined, turn.prompt));
			}
			if (turn.images.length) {
				const chips = dom.append(bubble, dom.$('.mcp-attachments'));
				for (const n of turn.images) {
					chips.appendChild(this._imageChip(n));
				}
			}
		}
		const reply = dom.append(element, dom.$('.mcp-reply'));
		dom.append(reply, dom.$('span.mcp-avatar'));
		const body = dom.append(reply, dom.$('.mcp-body'));
		let steps: Extract<ClaudeItem, { kind: 'step' }>[] = [];
		const flushSteps = (open = false) => {
			if (steps.length) {
				body.appendChild(this._renderSteps(steps, open));
				steps = [];
			}
		};
		for (const item of turn.items) {
			if (item.kind === 'step') {
				steps.push(item);
				continue;
			}
			flushSteps();
			if (item.kind === 'user') {
				const user = dom.append(body, dom.$('.mcp-user.mcp-midturn'));
				this._promptElements.push(user);
				const bubble = dom.append(user, dom.$('.mcp-bubble'));
				if (item.text) {
					dom.append(bubble, dom.$('.mcp-prompt', undefined, item.text));
				}
				if (item.images.length) {
					const chips = dom.append(bubble, dom.$('.mcp-attachments'));
					for (const n of item.images) {
						chips.appendChild(this._imageChip(n));
					}
				}
			} else if (item.kind === 'interrupted') {
				dom.append(body, dom.$('.mcp-interrupted', undefined, dom.$('i'), dom.$('span', undefined, localize('maut.claude.interrupted', "Interrupted by you. Claude stopped here and is waiting for what to do instead."))));
			} else if (item.kind === 'text') {
				const rendered = this._renderDisposables.add(renderMarkdown(new MarkdownString(item.text), {
					// Links open where they belong: web pages in your browser, files in the editor.
					actionHandler: link => this._openerService.open(link, { fromUserGesture: true, allowCommands: false }),
				}));
				rendered.element.classList.add('mcp-prose');
				body.appendChild(rendered.element);
			} else {
				body.appendChild(this._renderEdit(item));
			}
		}
		// The steps Claude is on right now stay open, so you see each command as it runs.
		flushSteps(live);
		if (changedFiles.length) {
			body.appendChild(this._renderChangedFiles(changedFiles));
		}
		if (live) {
			dom.append(body, dom.$('.mcp-working', undefined, localize('maut.claude.workingLine', "Working…")));
		} else if (turn.end > turn.time) {
			dom.append(body, dom.$('.mcp-foot', undefined, localize('maut.claude.workedFor', "Worked for {0}", duration(turn.end - turn.time))));
		}
		if (!body.childElementCount) {
			reply.remove();
		}
		return element;
	}

	/** Files Claude changed in a turn, however it changed them (its shell commands included). */
	private _renderChangedFiles(files: readonly IChangedFile[]): HTMLElement {
		const box = dom.$('.mcp-changed');
		dom.append(box, dom.$('.mcp-changed-head', undefined, files.length === 1 ? localize('maut.claude.changedOne', "Changed 1 file") : localize('maut.claude.changedMany', "Changed {0} files", files.length)));
		for (const file of files.slice(0, 30)) {
			const row = dom.append(box, dom.$('.mcp-changed-row'));
			const name = dom.append(row, dom.$('button.mcp-changed-file', { type: 'button' }, file.label));
			name.dataset.file = file.path;
			this._renderDisposables.add(this._hoverService.setupDelayedHover(name, { content: localize('maut.claude.openFile', "Open {0}", file.label) }));
			if (file.isNew) {
				dom.append(row, dom.$('span.mcp-changed-new', undefined, localize('maut.claude.newFile', "new")));
			} else {
				const diff = dom.append(row, dom.$('button.mcp-changed-diff', { type: 'button' }, localize('maut.claude.diff', "Diff")));
				diff.dataset.diff = file.path;
			}
		}
		if (files.length > 30) {
			dom.append(box, dom.$('.mcp-changed-more', undefined, localize('maut.claude.changedMore', "and {0} more", files.length - 30)));
		}
		return box;
	}

	private _renderSteps(steps: Extract<ClaudeItem, { kind: 'step' }>[], open: boolean): HTMLElement {
		const box = dom.$('.mcp-steps');
		box.classList.toggle('open', open);
		const head = dom.append(box, dom.$('button.mcp-steps-head', { type: 'button' }));
		// allow-any-unicode-next-line
		dom.append(head, dom.$('span.mcp-chevron', undefined, '›'));
		dom.append(head, dom.$('span', undefined, summarizeSteps(steps)));
		// What the latest step was, in Claude's own words ("Commit the release changes").
		const latest = steps.at(-1)?.target;
		if (latest) {
			dom.append(head, dom.$('span.mcp-steps-latest', undefined, latest));
		}
		dom.append(head, dom.$('span.mcp-count', undefined, steps.length === 1 ? localize('maut.claude.oneStep', "1 step") : localize('maut.claude.steps', "{0} steps", steps.length)));
		const list = dom.append(box, dom.$('.mcp-steps-list'));
		for (const step of steps) {
			const row = dom.append(list, dom.$('.mcp-step'));
			dom.append(row, dom.$('span.mcp-verb', undefined, step.verb));
			const target = dom.append(row, dom.$('span.mcp-target', undefined, step.target));
			if (step.file) {
				target.classList.add('mcp-file');
				target.dataset.file = step.file;
			}
		}
		head.addEventListener('click', () => box.classList.toggle('open'));

		// Images Claude read: shown as thumbnails right away, however the steps are folded.
		const images = steps.filter(step => step.file && imageFileRegex.test(step.file));
		if (!images.length) {
			return box;
		}
		const wrapper = dom.$('.mcp-steps-wrap');
		wrapper.appendChild(box);
		const strip = dom.append(wrapper, dom.$('.mcp-read-images'));
		for (const step of images) {
			const src = FileAccess.uriToBrowserUri(URI.file(step.file!)).toString(true);
			const thumb = dom.append(strip, dom.$<HTMLImageElement>('img.mcp-read-image'));
			thumb.src = src;
			thumb.alt = step.target;
			thumb.dataset.file = step.file;
			this._renderDisposables.add(this._hoverService.setupDelayedHover(thumb, () => {
				const preview = dom.$('.maut-claude-image-hover');
				const large = dom.append(preview, dom.$<HTMLImageElement>('img'));
				large.src = src;
				large.alt = '';
				dom.append(preview, dom.$('.maut-claude-image-caption', undefined, localize('maut.claude.readImage', "{0} · click to open", step.target)));
				return { content: preview };
			}));
		}
		return wrapper;
	}

	private _renderEdit(edit: Extract<ClaudeItem, { kind: 'edit' }>): HTMLElement {
		const card = dom.$('.mcp-edit');
		const head = dom.append(card, dom.$('.mcp-edit-head'));
		dom.append(head, dom.$('span.mcp-edit-file', undefined, edit.file));
		dom.append(head, dom.$('span.mcp-add', undefined, `+${edit.added}`));
		if (edit.removed) {
			// allow-any-unicode-next-line
			dom.append(head, dom.$('span.mcp-del', undefined, `−${edit.removed}`));
		}
		const open = dom.append(head, dom.$<HTMLButtonElement>('button.mcp-mini', { type: 'button' }, localize('maut.claude.open', "Open")));
		open.dataset.file = edit.file;
		const pre = dom.append(card, dom.$('.mcp-diff'));
		for (const [kind, line] of edit.lines) {
			dom.append(pre, dom.$(`div.${kind}`, undefined, `${kind === 'a' ? '+' : '-'} ${line}`));
		}
		return card;
	}

	private _imageChip(n: number): HTMLElement {
		const chip = dom.$('span.mcp-chip', undefined, `[Image #${n}]`);
		const show = (path: string | undefined) => {
			if (!path) {
				return;
			}
			const thumb = dom.$<HTMLImageElement>('img');
			thumb.src = FileAccess.uriToBrowserUri(URI.file(path)).toString(true);
			thumb.alt = '';
			chip.prepend(thumb);
			chip.dataset.file = path;
		};
		if (this._imagePaths.has(n)) {
			show(this._imagePaths.get(n));
		} else {
			this._commandService.executeCommand<string | undefined>(resolveImageCommandId, this._instance?.processId, n).then(path => {
				this._imagePaths.set(n, path);
				show(path);
			}, () => { /* the extension isn't running yet */ });
		}
		return chip;
	}

	private async _onReaderClick(e: MouseEvent): Promise<void> {
		const diff = (e.target as HTMLElement).closest<HTMLElement>('[data-diff]')?.dataset.diff;
		if (diff) {
			e.preventDefault();
			// The Git extension's diff of the file against its last commit.
			this._commandService.executeCommand('git.openChange', URI.file(diff));
			return;
		}
		const target = (e.target as HTMLElement).closest<HTMLElement>('[data-file]');
		const file = target?.dataset.file;
		if (!file) {
			return;
		}
		e.preventDefault();
		this._openFile(file);
	}

	/** Opens a file Claude named: absolute, or relative to Claude's folder. */
	private async _openFile(file: string): Promise<void> {
		let resource: URI;
		if (isAbsolute(file)) {
			resource = URI.file(file);
		} else {
			const cwd = await this._instance?.getCwdResource();
			const base = cwd ?? this._workspaceContextService.getWorkspace().folders[0]?.uri;
			if (!base) {
				return;
			}
			resource = URI.joinPath(base, file);
		}
		this._editorService.openEditor({ resource, options: { pinned: false } });
	}
}

/**
 * "Editing x.ts", "Running npm test": what a tool call is doing, from Claude's screen (`Bash(npm
 * test)`, `Update(src/x.ts)`) or a transcript step (`Ran`, `Read`).
 */
function describeActivity(tool: string, target: string, file?: string): { label: string; file?: string } {
	const short = target.length > 60 ? `${target.slice(0, 57)}...` : target;
	const isPath = /[\\/]|\.\w{1,6}$/.test(target) && !/\s/.test(target);
	const path = file ?? (isPath ? target : undefined);
	const name = path ? basename(path) : short;
	switch (tool) {
		case 'Bash':
		case 'Ran': return { label: localize('maut.claude.nowRunning', "Running {0}", short) };
		case 'Read': return { label: localize('maut.claude.nowReading', "Reading {0}", name), file: path };
		case 'Update':
		case 'Edit':
		case 'MultiEdit': return { label: localize('maut.claude.nowEditingFile', "Editing {0}", name), file: path };
		case 'Write':
		case 'Create': return { label: localize('maut.claude.nowWritingFile', "Writing {0}", name), file: path };
		case 'Search':
		case 'Grep':
		case 'Glob':
		case 'Searched':
		case 'Listed': return { label: localize('maut.claude.nowSearching', "Searching {0}", short) };
		case 'Fetch':
		case 'WebFetch':
		case 'Fetched': return { label: localize('maut.claude.nowFetching', "Fetching {0}", short) };
		case 'WebSearch':
		case 'Searched the web': return { label: localize('maut.claude.nowSearchingWeb', "Searching the web for {0}", short) };
		case 'Agent':
		case 'Task': return { label: localize('maut.claude.nowAgent', "Agent: {0}", short) };
		default: return { label: short ? `${tool}: ${short}` : tool };
	}
}

/** 48.4k, 846k, 1m: the way Claude's /context writes token counts. */
function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${+(tokens / 1_000_000).toFixed(2)}m`;
	}
	return tokens >= 100_000 ? `${Math.round(tokens / 1000)}k` : tokens >= 1000 ? `${+(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function modelLabel(model: string): string {
	const match = /claude-(?<family>opus|sonnet|haiku|fable)-(?<major>\d+)-(?<minor>\d+)/i.exec(model);
	if (!match?.groups) {
		return model;
	}
	const family = match.groups.family[0].toUpperCase() + match.groups.family.slice(1);
	return `${family} ${match.groups.major}.${match.groups.minor}`;
}

function summarizeSteps(steps: { verb: string }[]): string {
	const counts = new Map<string, number>();
	for (const step of steps) {
		counts.set(step.verb, (counts.get(step.verb) ?? 0) + 1);
	}
	const summary = [...counts].map(([verb, count]) => {
		switch (verb) {
			case 'Read': return count === 1 ? localize('maut.claude.readOne', "Read 1 file") : localize('maut.claude.readMany', "Read {0} files", count);
			case 'Ran': return count === 1 ? localize('maut.claude.ranOne', "ran 1 command") : localize('maut.claude.ranMany', "ran {0} commands", count);
			case 'Searched': return count === 1 ? localize('maut.claude.searchedOne', "searched once") : localize('maut.claude.searchedMany', "searched {0} times", count);
			default: return count === 1 ? verb : `${verb} ×${count}`;
		}
	}).join(' · ');
	return summary.charAt(0).toUpperCase() + summary.slice(1);
}

function duration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return localize('maut.claude.seconds', "{0}s", seconds);
	}
	const minutes = Math.floor(seconds / 60);
	return minutes < 60
		? localize('maut.claude.minutes', "{0}m {1}s", minutes, seconds % 60)
		: localize('maut.claude.hours', "{0}h {1}m", Math.floor(minutes / 60), minutes % 60);
}
