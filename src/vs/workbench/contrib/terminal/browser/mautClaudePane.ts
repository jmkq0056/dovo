/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DataTransfers } from '../../../../base/browser/dnd.js';
import * as dom from '../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { toAction } from '../../../../base/common/actions.js';
import { IntervalTimer, RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { matchesFuzzy } from '../../../../base/common/filters.js';
import { basename, isAbsolute } from '../../../../base/common/path.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { CodeDataTransfers, containsDragType } from '../../../../platform/dnd/browser/dnd.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService, MODAL_GROUP } from '../../../services/editor/common/editorService.js';
import { GroupDirection, GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IMautClaudeService, MautClaudeView } from './mautClaude.js';
import type { ITerminalInstance } from './terminal.js';
import { getFileResourcesFromDragEvent } from './terminalUri.js';
import type { IXtermCore } from './xterm-private.js';
import type { IBuffer, IBufferCell, Terminal as XtermTerminal } from '@xterm/xterm';
import { IScreenMenu, IScreenState, readScreen } from './mautClaudeScreen.js';
import './media/mautClaudePane.css';

/** Contributed by the built-in `maut-claude-images` extension: the conversation in a terminal. */
const sessionCommandId = '_maut.claude.session';
const resolveImageCommandId = '_maut.claudeImages.resolve';
/** Two rows: who and how (name, view, layout, hide), then what's happening (Now, context, tasks). */
const headerHeight = 72;
/** The slim bar shown instead of the header once Claude has left the terminal. */
const goneHeaderHeight = 44;
/** How long Claude's UI and session can both be missing before the pane decides Claude has exited. */
const goneAfter = 4000;
/** The internal command that returns the command line Dovo starts Claude with. */
const launchCommandId = '_maut.claude.launchCommand';
const refreshInterval = 1500;
const imageFileRegex = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
/** Widest the terminal gets while Claude runs: a comfortable reading column. */
const maxColumnWidth = 1120;
const sidePadding = 24;
/** The live terminal strip under the Reader, framed like a chat composer. */
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
	/** The same block as the terminal draws it: colours, bold, dim and all. */
	readonly lines: readonly ILiveLine[];
	readonly queued: string[];
	readonly status: string;
}

/** A stretch of a live line with one look (inline CSS built from the terminal cell's attributes). */
interface ILiveRun {
	readonly text: string;
	readonly style: string;
}

/** One visual line of Claude's live output; `background` fills the whole line, as diffs do. */
interface ILiveLine {
	readonly runs: readonly ILiveRun[];
	readonly background: string;
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
/** Contributed by the built-in `maut-claude-images` extension: a thumbnail picture of a file. */
const fileThumbnailCommandId = '_maut.files.thumbnail';

/** A relative file path in inline code: folders and a file name with an extension, no spaces. */
const relativePathRegex = /^(?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]{1,8}$/;

/** Files that open in a popup to glance at; everything else opens beside Claude, in the files group. */
const popupExtensionRegex = /\.(?:pdf|png|jpe?g|gif|webp|heic|bmp|svg|ico|tiff?|avif|mp4|mov|webm)$/i;
const terminalEditorTypeId = 'workbench.editors.terminal';

/** Each terminal's latest Remote Control session, kept after its link leaves the screen. */
const remoteControlSessions = new WeakMap<ITerminalInstance, string>();

/** A file path in your message: a file:// link, or an absolute path (spaces escaped) with an extension. */
const attachedPathRegex = /file:\/\/[^\s'"]+|(?<=^|\s)(?:\/|[A-Za-z]:\\)(?:\\ |[^\s'"])+\.[A-Za-z0-9]{1,8}\b/g;

function attachedPathResource(text: string): URI | undefined {
	try {
		if (text.startsWith('file://')) {
			return URI.parse(text);
		}
		return URI.file(text.replace(/\\ /g, ' '));
	} catch {
		return undefined;
	}
}

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
	/** Above the input: a preview of each file whose path is in what you're writing. */
	private readonly _inputFiles: HTMLElement;
	private _inputFilesKey = '';
	private readonly _inputFileDisposables = this._register(new DisposableStore());
	/** Thumbnails by file path, made once by the extension. */
	private readonly _thumbnails = new Map<string, Promise<string | undefined>>();
	private _session: IClaudeSessionView | undefined;
	private _renderedKey = '';
	/** Claude's in-progress output, mirrored from its screen until the transcript has it. */
	private readonly _live = dom.$('.mcp-live');
	private _liveText = '';
	private _liveStructure = '';
	/** Claude's live state as last read from its screen, for the header's "Now" line. */
	private _lastLive: ILiveState | undefined;
	/** The live output opened full screen, if it is: it keeps streaming there. */
	private _liveFull: { readonly element: HTMLElement; readonly text: HTMLElement; readonly status: HTMLElement; readonly verb: HTMLElement } | undefined;
	private readonly _liveFullStore = this._register(new MutableDisposable<DisposableStore>());
	/** The live output follows its newest line until you scroll up in it. */
	private _liveFollow = true;
	/** Live updates are paced so the card changes calmly instead of on every redraw. */
	private _liveLastApply = 0;
	private _livePending: ILiveState | undefined;
	private readonly _livePace = this._register(new MutableDisposable());
	/** The live card's own listeners: they live as long as the card, not one conversation render. */
	private readonly _liveDisposables = this._register(new DisposableStore());
	/** The live card only grows while Claude works on a step, so it doesn't jump up and down. */
	private _liveMinHeight = 0;
	/** The "Now" line: one element for the pane's life, so hovering it holds and it never jumps. */
	private readonly _now: HTMLButtonElement;
	private readonly _nowLabel: HTMLElement;
	/** Claude's own word for what it's doing ("Booping\u2026"), in its orange shimmer. */
	private readonly _nowVerb: HTMLElement;
	/** Shows a new activity once it has held, even if the screen doesn't change again meanwhile. */
	private readonly _nowRecheck = this._register(new RunOnceScheduler(() => this._updateNow(), 650));
	private readonly _nowElapsed: HTMLElement;
	private _nowFile: string | undefined;
	private _nowFull = '';
	/** A new activity shows once it has held for a moment, so quick switches don't flicker. */
	private _nowPending: { label: string; since: number } | undefined;
	private _headerKey = '';
	/** When Claude's UI or session was last seen in this terminal. */
	private _claudeSeenAt = 0;
	/** Marked running, but Claude has exited (or never came back after a restore): plain terminal, with a Start Claude bar. */
	private _claudeGone = false;
	private _wasActive = false;
	/** The last session lookup found a live Claude process under this terminal's shell. */
	private _sessionLive = false;
	private readonly _headerDisposables = this._register(new DisposableStore());
	/** The line under the input: Claude's latest notice ("Update installed"), else a hint. */
	private readonly _liveNoteText: HTMLElement;
	/** Redraws the terminal from scratch: its GPU glyph cache can go blank after a resize or font change. */
	private readonly _repaint = this._register(new RunOnceScheduler(() => {
		const xterm = this._instance?.xterm;
		if (xterm && this.active) {
			xterm.forceRedraw();
			xterm.raw.refresh(0, xterm.raw.rows - 1);
		}
	}, 120));
	private _liveBlock: HTMLElement | undefined;
	private _wasReader = false;
	/** The Activity panel: Claude's background shells and agents. */
	private readonly _activity: HTMLElement;
	private _activityOpen = false;
	/** The agent whose conversation the panel shows, if any. */
	private _activityAgent: IClaudeTask | undefined;
	private _activityKey = '';
	private _activityBody: HTMLElement | undefined;
	private readonly _activityDisposables = this._register(new DisposableStore());
	/** The Reader follows new output, like a chat, until you scroll up to read. */
	private _followBottom = true;
	/** Set while the Reader scrolls itself, so that scroll isn't taken as yours. */
	private _autoScrolling = false;
	private readonly _jumpToLatest: HTMLButtonElement;
	private _visible = false;
	/** Resolved image files, by number and the time of the message that pasted it. */
	private readonly _imagePaths = new Map<string, string | undefined>();
	/** Rows at the bottom of Claude's screen the composer shows: its prompt box (or a question). */
	private _composerRows = 6;
	/** Rows of Claude's screen below the frame's last shown row: the frame shows a slice, not just the bottom. */
	private _composerShift = 0;
	/** When Claude's prompt box last went missing from its screen, while it stays missing. */
	private _noPromptSince: number | undefined;
	/** A new frame size waits until Claude's screen has held it for a moment, so redraws don't make the input jump. */
	private _pendingFrame: { readonly rows: number; readonly shift: number; readonly since: number } | undefined;
	private readonly _settleFrame = this._register(new RunOnceScheduler(() => this._measureComposer(), 90));
	/** Claude's menus and questions, drawn as HTML above the input instead of inside the frame. */
	private readonly _menuPop: HTMLElement;
	private readonly _askCard: HTMLElement;
	private _overlayKey = '';
	private _menu: IScreenMenu | undefined;
	private readonly _renderWatch = this._register(new MutableDisposable<DisposableStore>());
	/** The terminal currently rendered with Claude's larger reading font. */
	private _fontApplied: ITerminalInstance | undefined;

	/** Set on mouse down: the click that follows is a Cmd+click. */
	private _linkToDefaultBrowser = false;
	/** Where the Reader was scrolled, and when you last scrolled it by hand. */
	private _lastScrollTop = 0;
	private _handScrollAt = 0;

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
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
	) {
		super();
		this._root.classList.add('maut-claude-host');
		this._header = dom.$('.mcp-header');
		this._reader = dom.$('.mcp-reader');
		this._column = dom.append(this._reader, dom.$('.mcp-column'));
		this._root.insertBefore(this._reader, this._terminalHost);
		this._root.insertBefore(this._header, this._reader);
		this._inputFiles = dom.$('.mcp-input-files');
		this._root.insertBefore(this._inputFiles, this._terminalHost);
		this._liveNoteText = dom.$('span.mcp-live-note-text', undefined, defaultLiveNote());
		this._liveNote = dom.$('.mcp-live-note', undefined, dom.$('i'), this._liveNoteText);
		this._root.appendChild(this._liveNote);
		this._activity = dom.append(this._root, dom.$('.mcp-activity'));
		this._menuPop = dom.append(this._root, dom.$('.mcp-menu-pop'));
		this._askCard = dom.append(this._root, dom.$('.mcp-ask'));
		this._register(dom.addDisposableListener(this._menuPop, dom.EventType.MOUSE_DOWN, e => e.preventDefault()));
		this._register(dom.addDisposableListener(this._askCard, dom.EventType.MOUSE_DOWN, e => e.preventDefault()));
		this._now = dom.$<HTMLButtonElement>('button.mcp-now', { type: 'button' });
		dom.append(this._now, dom.$('i'));
		this._nowVerb = dom.append(this._now, dom.$('span.mcp-spinner-word.mcp-now-verb'));
		this._nowLabel = dom.append(this._now, dom.$('span.mcp-now-label'));
		this._nowElapsed = dom.append(this._now, dom.$('span.mcp-now-time'));
		this._register(dom.addDisposableListener(this._now, dom.EventType.CLICK, () => this._onNowClick()));
		this._register(this._hoverService.setupDelayedHover(this._now, () => ({ content: this._nowFull })));
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
		// Scrolling by hand: the wheel, a drag of the bar, the keyboard.
		for (const type of ['wheel', dom.EventType.POINTER_DOWN, dom.EventType.KEY_DOWN, 'touchstart']) {
			this._register(dom.addDisposableListener(this._reader, type, () => this._handScrollAt = Date.now(), { passive: true }));
		}
		this._register(dom.addDisposableListener(this._reader, 'scroll', () => {
			if (!this._reader.clientHeight || this._restoreAfterReset()) {
				return;
			}
			this._lastScrollTop = this._reader.scrollTop;
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
		const resizeObserver = this._register(new dom.DisposableResizeObserver('mautClaudeReader', () => {
			this._restoreAfterReset();
			this._scrollToEnd();
		}, dom.getWindow(this._root)));
		this._register(resizeObserver.observe(this._column));
		this._register(resizeObserver.observe(this._reader));
		this._register(dom.addDisposableListener(this._promptNav, 'focusout', e => {
			if (!dom.isAncestor(e.relatedTarget as Node | null, this._promptNav)) {
				this._promptNav.classList.remove('open');
			}
		}));
		// Whether the link being clicked was Cmd+clicked: that one goes to your default browser.
		this._register(dom.addDisposableListener(this._root, dom.EventType.MOUSE_DOWN, e => {
			this._linkToDefaultBrowser = isMacintosh ? e.metaKey : e.ctrlKey;
		}, true));
		this._register(dom.addDisposableListener(this._reader, dom.EventType.KEY_DOWN, e => {
			if ((isMacintosh ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && this._selectedText()) {
				// Copy what you marked, before the terminal's own copy binding can take the key.
				e.preventDefault();
				e.stopPropagation();
				this._clipboardService.writeText(this._selectedText());
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
				// In the Reader this searches your prompts; the file finder keeps the key everywhere else.
				e.preventDefault();
				e.stopPropagation();
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
		this._register(dom.addDisposableListener(this._reader, dom.EventType.CONTEXT_MENU, e => this._onReaderContextMenu(e)));
		this._registerFileDrop();
		this._register(dom.addDisposableListener(this._terminalHost, dom.EventType.KEY_DOWN, e => this._onComposerKey(e), true));
		// Coming back to the input, or to the window, draws it fresh.
		this._register(dom.addDisposableListener(this._terminalHost, dom.EventType.FOCUS_IN, () => this._repaint.schedule()));
		this._register(dom.addDisposableListener(dom.getWindow(this._root), dom.EventType.FOCUS, () => this._repaint.schedule()));
		this._update();
	}

	/** True while the terminal shown runs Claude, so the pane's header and Reader are in use. */
	get active(): boolean {
		return !!this._instance && this._claudeService.isClaude(this._instance);
	}

	/** The Reader is shown: Claude runs here, is really on screen, and the Reader view is picked. */
	private get _readerShown(): boolean {
		return this.active && !this._claudeGone && !!this._instance && this._claudeService.viewOf(this._instance) === 'reader';
	}

	private get _headerHeight(): number {
		return this._claudeGone ? goneHeaderHeight : headerHeight;
	}

	/**
	 * Whether Claude is still in this terminal. Being marked running isn't proof: a restored tab
	 * replays old output and its command can look started but never finish. Claude's own UI on
	 * screen, or a live Claude process under the shell, is; missing both for a while means gone.
	 */
	private _noteClaude(seen: boolean): void {
		const now = Date.now();
		if (seen) {
			this._claudeSeenAt = now;
		}
		const gone = !seen && now - this._claudeSeenAt > goneAfter;
		if (gone === this._claudeGone) {
			return;
		}
		this._claudeGone = gone;
		if (gone && this._instance) {
			this._claudeService.setWorking(this._instance, false);
		}
		this._headerKey = '';
		this._update();
	}

	/** Start Claude again in this terminal, the way Dovo starts it. */
	private async _startClaude(): Promise<void> {
		const instance = this._instance;
		if (!instance) {
			return;
		}
		let command: string | undefined;
		try {
			command = await this._commandService.executeCommand<string>(launchCommandId);
		} catch {
			// The extension isn't up: plain claude still works.
		}
		this._claudeSeenAt = Date.now();
		this._noteClaude(true);
		instance.sendText(command || 'claude', true);
		instance.focus();
	}

	setInstance(instance: ITerminalInstance | undefined): void {
		if (instance === this._instance) {
			return;
		}
		this._resetFont();
		this._instance = instance;
		this._followBottom = true;
		this._claudeGone = false;
		this._sessionLive = false;
		this._claudeSeenAt = Date.now();
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
					const measureSoon = () => {
						if (!scheduled) {
							scheduled = true;
							dom.getWindow(this._root).requestAnimationFrame(() => {
								scheduled = false;
								this._measureComposer();
							});
						}
					};
					store.add(xterm.raw.onRender(measureSoon));
					// A resize moves Claude's prompt; measure again even if nothing redraws afterwards.
					store.add(xterm.raw.onResize(measureSoon));
					// And keep checking while the Reader shows, so a measurement taken mid-draw (at
					// startup, say) can never stick and leave the input on the wrong rows.
					const timer = new IntervalTimer();
					timer.cancelAndSet(() => {
						if (this._readerShown) {
							measureSoon();
						}
					}, 400, dom.getWindow(this._root));
					store.add(timer);
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
		const line = (row: number) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '';
		// The footer says "esc to interrupt" while Claude works; a narrow pane cuts it short.
		for (let row = raw.rows - 1; row >= Math.max(0, raw.rows - 4); row--) {
			if (/esc to (?:i|\u2026)/.test(line(row))) {
				return true;
			}
		}
		// Or its spinner line, "\u273b Booping\u2026 (1m 12s \u00b7 ...)", is on screen above the prompt.
		for (let row = raw.rows - 1; row >= Math.max(0, raw.rows - 30); row--) {
			if (/^\S\s\S[^()]*\u2026\s*\(\d/.test(line(row))) {
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
		const state: { block: string[]; rows: number[]; queued: string[]; status: string } = { block: [], rows: [], queued: [], status: '' };
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
				state.rows.push(row);
			}
		}
		while (state.block.length && !state.block.at(-1)!.trim()) {
			state.block.pop();
			state.rows.pop();
		}
		let block = state.block.join('\n').trim();
		// Already in the transcript? Then the Reader shows it properly. The transcript has Markdown
		// (**bold**, `code`) where the screen shows it formatted: compare both without it.
		const first = plainText(block.split('\n')[0].replace(/^\u23fa\s*/, '')).slice(0, 40);
		const said = (this._session?.turns.at(-1)?.items ?? []).filter(item => item.kind === 'text').map(item => plainText(item.text)).join(' ');
		if (first && said.includes(first)) {
			block = '';
		}
		const lines = block ? readRichLines(buffer, state.rows, raw.cols) : [];
		return { block: block.replace(/^\u23fa\s*/, ''), lines, queued: state.queued, status: state.status };
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
		this._live.classList.toggle('visible', !!live && !!(live.block || live.queued.length));
		this._updateLiveFull(live);
		if (!live) {
			this._liveDisposables.clear();
			dom.clearNode(this._live);
			return;
		}
		// Only text changed (the spinner's timer, more output): update in place, no rebuild, no blink.
		if (sameStructure && this._live.childElementCount) {
			this._applyLiveText(live);
		} else {
			this._livePace.clear();
			this._liveDisposables.clear();
			dom.clearNode(this._live);
			this._liveBlock = live.block ? this._createLiveBlock(live) : undefined;
			for (const queued of live.queued) {
				const user = dom.append(this._live, dom.$('.mcp-user.mcp-queued'));
				const bubble = dom.append(user, dom.$('.mcp-bubble'));
				dom.append(bubble, dom.$('.mcp-prompt', undefined, queued));
				dom.append(bubble, dom.$('.mcp-queued-note', undefined, localize('maut.claude.queuedNote', "Queued. Claude reads it after this step, or press Ctrl+Enter to send it now.")));
			}
			// Claude's spinner word and figures show once, in the header's Now line, not again here.
		}
		this._scrollToEnd();
	}

	/** Claude's streaming output: scrollable, following the newest line, with a way to open it full screen. */
	private _createLiveBlock(live: ILiveState): HTMLElement {
		const block = dom.append(this._live, dom.$('.mcp-live-block.working'));
		// A slow amber sweep along the top edge says Claude is still at it, without anything blinking.
		dom.append(block, dom.$('span.mcp-live-sweep'));
		const body = dom.append(block, dom.$('.mcp-live-text'));
		this._renderLiveLines(body, live.lines);
		const label = localize('maut.claude.liveFullScreen', "Open Full Screen");
		const expand = dom.append(block, dom.$<HTMLButtonElement>(`button.mcp-live-expand${ThemeIcon.asCSSSelector(Codicon.screenFull)}`, { type: 'button' }));
		expand.setAttribute('aria-label', label);
		this._liveDisposables.add(this._hoverService.setupDelayedHover(expand, { content: label }));
		this._liveDisposables.add(dom.addDisposableListener(expand, dom.EventType.CLICK, () => this._openLiveFull()));
		this._liveDisposables.add(dom.addDisposableListener(body, 'scroll', () => {
			this._liveFollow = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
			block.classList.toggle('scrolled', body.scrollTop > 4);
		}));
		this._liveFollow = true;
		this._liveMinHeight = 0;
		this._liveLastApply = Date.now();
		dom.getWindow(body).requestAnimationFrame(() => this._followLive());
		return body;
	}

	/** Applies new live text at most every 220ms; the latest text always lands. */
	private _applyLiveText(live: ILiveState): void {
		const wait = 220 - (Date.now() - this._liveLastApply);
		if (wait > 0) {
			this._livePending = live;
			if (!this._livePace.value) {
				const targetWindow = dom.getWindow(this._root);
				const timer = targetWindow.setTimeout(() => {
					this._livePace.clear();
					if (this._livePending) {
						this._applyLiveText(this._livePending);
					}
				}, wait);
				this._livePace.value = toDisposable(() => targetWindow.clearTimeout(timer));
			}
			return;
		}
		this._livePending = undefined;
		this._liveLastApply = Date.now();
		if (this._liveBlock && this._renderLiveLines(this._liveBlock, live.lines)) {
			this._followLive();
		}
	}

	/**
	 * Shows live lines in `container`, reusing the elements of lines that didn't change so nothing
	 * flickers; new or changed lines fade in. Image references get their thumbnails. Returns whether
	 * anything changed.
	 */
	private _renderLiveLines(container: HTMLElement, lines: readonly ILiveLine[]): boolean {
		let changed = false;
		// Each picture once: your message's "[Image #12]" shows on Claude's screen more than once
		// (the echo, the line under it), but it gets one thumbnail, on its first line.
		const seen = new Set<number>();
		lines.forEach((line, index) => {
			const text = line.runs.map(run => run.text).join('');
			const images = [...text.matchAll(/\[Image #(?<n>\d+)\]/g)].map(match => Number(match.groups?.n)).filter(n => !seen.has(n));
			images.forEach(n => seen.add(n));
			const key = JSON.stringify([line, images]);
			const existing = container.children.item(index) as HTMLElement | null;
			if (existing?.dataset.key === key) {
				return;
			}
			changed = true;
			const element = dom.$('.mcp-live-line.fresh');
			element.dataset.key = key;
			if (line.background) {
				element.style.backgroundColor = line.background;
			}
			for (const run of line.runs) {
				const span = dom.append(element, dom.$('span', undefined, run.text));
				if (run.style) {
					span.style.cssText = run.style;
				}
			}
			if (images.length) {
				const row = dom.append(element, dom.$('.mcp-live-images'));
				for (const n of new Set(images)) {
					row.appendChild(this._imageChip(n));
				}
			}
			if (existing) {
				existing.replaceWith(element);
			} else {
				container.appendChild(element);
			}
		});
		while (container.children.length > lines.length) {
			container.lastElementChild?.remove();
			changed = true;
		}
		return changed;
	}

	private _followLive(): void {
		const body = this._liveBlock;
		if (!body) {
			return;
		}
		const height = Math.min(body.scrollHeight, 240);
		if (height > this._liveMinHeight) {
			this._liveMinHeight = height;
			body.style.minHeight = `${height}px`;
		}
		if (this._liveFollow) {
			body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
			body.parentElement?.classList.toggle('scrolled', body.scrollHeight > body.clientHeight + 4);
		}
	}

	/** The live output in a full-screen view over the Reader; it keeps streaming until you close it. */
	private _openLiveFull(): void {
		if (this._liveFull) {
			return;
		}
		const store = this._liveFullStore.value = new DisposableStore();
		const element = dom.append(this._root, dom.$('.mcp-live-full'));
		store.add(toDisposable(() => {
			element.remove();
			this._liveFull = undefined;
		}));
		element.tabIndex = -1;
		this._root.classList.add('mcp-live-full-open');
		store.add(toDisposable(() => this._root.classList.remove('mcp-live-full-open')));
		element.setAttribute('role', 'dialog');
		element.setAttribute('aria-label', localize('maut.claude.liveFullLabel', "What Claude is doing"));
		const bar = dom.append(element, dom.$('.mcp-live-full-bar'));
		dom.append(bar, dom.$('span.mcp-live-orbit'));
		const verb = dom.append(bar, dom.$('span.mcp-spinner-word.mcp-live-full-verb'));
		const status = dom.append(bar, dom.$('span.mcp-live-full-status'));
		const close = dom.append(bar, dom.$<HTMLButtonElement>(`button.mcp-live-full-close${ThemeIcon.asCSSSelector(Codicon.close)}`, { type: 'button' }));
		const closeLabel = localize('maut.claude.liveFullClose', "Close (Escape)");
		close.setAttribute('aria-label', closeLabel);
		store.add(this._hoverService.setupDelayedHover(close, { content: closeLabel }));
		dom.append(element, dom.$('span.mcp-live-sweep'));
		const text = dom.append(element, dom.$('.mcp-live-full-text'));
		// Images Claude shows open like in the Reader.
		store.add(dom.addDisposableListener(text, dom.EventType.CLICK, e => {
			const file = (e.target as HTMLElement).closest<HTMLElement>('[data-file]')?.dataset.file;
			if (file) {
				e.preventDefault();
				this._openFile(file);
			}
		}));
		const dispose = () => this._liveFullStore.clear();
		store.add(dom.addDisposableListener(close, dom.EventType.CLICK, dispose));
		store.add(dom.addDisposableListener(element, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				dispose();
			}
		}));
		this._liveFull = { element, text, status, verb };
		this._updateLiveFull(this._lastLive);
		text.scrollTop = text.scrollHeight;
		element.focus();
	}

	private _updateLiveFull(live: ILiveState | undefined): void {
		const full = this._liveFull;
		if (!full) {
			return;
		}
		const follow = full.text.scrollTop + full.text.clientHeight >= full.text.scrollHeight - 8;
		if (live?.lines.length) {
			this._renderLiveLines(full.text, live.lines);
		}
		const done = !live?.block && !live?.status;
		full.element.classList.toggle('done', done);
		const { verb, rest } = spinnerParts(live?.status ?? '');
		const figures = rest.replace(/^\(|\)$/g, '').trim();
		if (full.verb.textContent !== verb) {
			full.verb.textContent = done ? '' : verb;
		}
		const status = done
			? localize('maut.claude.liveFullDone', "Claude finished this step. The reply is in the Reader.")
			: figures || localize('maut.claude.liveFullWorking', "Claude is working");
		if (full.status.textContent !== status) {
			full.status.textContent = status;
		}
		if (follow) {
			full.text.scrollTop = full.text.scrollHeight;
		}
	}

	private _isAtBottom(): boolean {
		return this._reader.scrollTop + this._reader.clientHeight >= this._reader.scrollHeight - 48;
	}

	/** Show the latest, instantly: a smooth scroll would read as "you scrolled up" mid-way. */
	/**
	 * Moving Claude's group (the first file opening beside it, a layout change) re-attaches the
	 * Reader, which puts it back at the very top. That isn't you scrolling: return to where it
	 * was, or to the latest while it was following. Returns whether it did.
	 */
	private _restoreAfterReset(): boolean {
		const reset = this._reader.scrollTop === 0 && this._lastScrollTop > 0 && Date.now() - this._handScrollAt > 800;
		if (!reset || !this._reader.clientHeight) {
			return false;
		}
		this._autoScrolling = true;
		this._reader.scrollTo({ top: this._followBottom ? this._reader.scrollHeight : this._lastScrollTop, behavior: 'instant' });
		dom.getWindow(this._root).requestAnimationFrame(() => this._autoScrolling = false);
		return true;
	}

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
		if (visible) {
			this._repaint.schedule();
		}
		this._updatePolling();
	}

	/** Lay out header and Reader; returns the size the terminal itself should take. */
	layout(dimension: dom.Dimension): dom.Dimension {
		const host = this._terminalHost.style;
		const reader = this._readerShown;
		this._terminalHost.classList.toggle('mcp-composer', reader);
		if (!this.active) {
			host.height = host.width = host.margin = host.padding = '';
			return dimension;
		}
		this._header.classList.toggle('mcp-compact', dimension.width < 900);
		this._header.classList.toggle('mcp-narrow', dimension.width < 700);
		this._header.classList.toggle('mcp-tiny', dimension.width < 460);
		const body = Math.max(0, dimension.height - this._headerHeight);
		// A centered reading column instead of edge-to-edge text.
		const width = Math.max(0, Math.min(dimension.width - sidePadding * 2, maxColumnWidth));
		host.width = `${width}px`;
		host.margin = '0 auto';
		// Both views give the terminal the very same size, so switching between them never resizes
		// it: a resize makes Claude redraw under leftovers of its old frame (a jumbled screen).
		const terminalWidth = Math.max(0, width - composerPaddingX * 2 - 2);
		if (!reader) {
			this._activity.style.bottom = '0px';
			this._reader.style.height = '0px';
			host.height = `${body}px`;
			host.padding = `10px ${composerPaddingX + 1}px 0`;
			return new dom.Dimension(terminalWidth, body - 10);
		}
		// Reader: the conversation above; below it the live terminal framed as a composer. The
		// terminal keeps a full-height screen so Claude lays out normally, but the frame shows only
		// its bottom rows: the prompt box, or a question Claude is asking.
		const cell = this._cellHeight();
		const terminalRows = Math.max(1, Math.floor((body - 10) / cell));
		// The input shows only Claude's prompt box: it grows with what you type (Claude's menus and
		// questions have their own cards), never with the conversation above it.
		const visibleRows = Math.min(this._composerRows, terminalRows);
		const composer = Math.round(visibleRows * cell) + composerPaddingY * 2 + 2;
		const composerWidth = width;
		const readerHeight = Math.max(0, body - composer - composerMarginTop - liveNoteHeight);
		this._reader.style.height = `${readerHeight}px`;
		this._jumpToLatest.style.bottom = `${composer + composerMarginTop + liveNoteHeight + 14}px`;
		// The Activity panel ends above the input, so both stay in view.
		this._activity.style.bottom = `${composer + composerMarginTop + liveNoteHeight}px`;
		this._rail.style.top = `${this._headerHeight + 8}px`;
		this._rail.style.height = `${Math.max(0, readerHeight - 16)}px`;
		this._promptNav.style.top = `${this._headerHeight + 8}px`;
		this._promptNav.style.maxHeight = `${Math.max(0, readerHeight - 16)}px`;
		dom.getWindow(this._root).requestAnimationFrame(() => this._renderRail());
		host.width = `${composerWidth}px`;
		host.height = `${composer}px`;
		host.margin = `${composerMarginTop}px auto 0`;
		host.padding = `${composerPaddingY}px ${composerPaddingX}px`;
		this._liveNote.style.width = `${composerWidth}px`;
		// Menus and questions sit right above the input, as wide as it.
		for (const overlay of [this._menuPop, this._askCard]) {
			overlay.style.width = `${composerWidth}px`;
			overlay.style.bottom = `${composer + liveNoteHeight + 6}px`;
			// Never taller than the room between the header and the input; it scrolls inside instead.
			overlay.style.maxHeight = `${Math.max(0, readerHeight - 12)}px`;
		}
		// Which slice of Claude's screen the frame shows: its bottom rows unless told otherwise.
		this._terminalHost.style.setProperty('--mcp-shift', `${Math.round(this._composerShift * cell)}px`);
		// Border (1px each side) and padding come out of the terminal's own width.
		return new dom.Dimension(terminalWidth, body - 10);
	}

	private _update(): void {
		this._updateFont();
		const active = this.active;
		if (active && !this._wasActive) {
			// Just started: give Claude a moment to draw before judging whether it's there.
			this._claudeSeenAt = Date.now();
			this._claudeGone = false;
		}
		this._wasActive = active;
		const reader = this._readerShown;
		if (reader !== this._wasReader) {
			this._repaint.schedule();
		}
		if (reader && !this._wasReader) {
			// Back to the Reader (from Terminal, or a new Claude): show the latest once laid out.
			dom.getWindow(this._root).requestAnimationFrame(() => this._scrollToEnd(true));
		}
		this._wasReader = reader;
		this._root.classList.toggle('maut-claude-active', active);
		this._root.classList.toggle('maut-claude-reader', reader);
		this._root.classList.toggle('mcp-gone', active && this._claudeGone);
		this._header.classList.toggle('mcp-gone', active && this._claudeGone);
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
		const screen = raw && this.active ? readScreen(raw) : undefined;
		if (screen) {
			this._noteClaude(screen.claude || this._sessionLive);
		}
		if (!raw || !screen || !this._readerShown) {
			this._showOverlays(undefined);
			return;
		}
		this._setNotice(screen.notice ?? '', screen.footer ?? '');
		this._updateLive(screen.liveTop);
		this._showOverlays(screen);
		if (screen.claude) {
			this._updateInputFiles(raw, screen);
		}
		// The frame shows exactly the rows that matter, never more: the prompt box and its footer, or
		// the one hint line under a question. A long prompt grows it, up to most of the height.
		if (!screen.claude) {
			// Mid-redraw, Claude's prompt box can be missing for a frame: keep the input as it is.
			// Missing for longer means Claude shows something else (a picker like /resume): show it.
			const now = Date.now();
			this._noPromptSince ??= now;
			if (now - this._noPromptSince < 400) {
				this._settleFrame.schedule(450);
				return;
			}
		} else {
			this._noPromptSince = undefined;
		}
		const cap = Math.floor(raw.rows * 0.8);
		const from = Math.max(screen.frame.from, screen.frame.to - cap + 1);
		const rows = Math.max(1, screen.frame.to - from + 1);
		const shift = raw.rows - 1 - screen.frame.to;
		if (rows === this._composerRows && shift === this._composerShift) {
			this._pendingFrame = undefined;
			return;
		}
		// Which rows the frame shows must always match the screen: a stale position shows the wrong
		// rows (a rule and the footer instead of your prompt). So the position and any growth apply
		// at once; only shrinking waits a moment, since a redraw can shrink the box for a frame and
		// grow it right back, and that flicker is what made the input jump.
		if (shift === this._composerShift && rows < this._composerRows) {
			const now = Date.now();
			const pending = this._pendingFrame;
			if (!pending || pending.rows !== rows || pending.shift !== shift) {
				this._pendingFrame = { rows, shift, since: now };
				this._settleFrame.schedule(260);
				return;
			}
			const wait = 260 - (now - pending.since);
			if (wait > 0) {
				this._settleFrame.schedule(wait);
				return;
			}
		}
		this._pendingFrame = undefined;
		this._composerRows = rows;
		this._composerShift = shift;
		this._relayout();
		this._repaint.schedule();
	}

	/** Claude's / and @ menus as a list above the input, and its questions as a card with buttons. */
	private _showOverlays(screen: IScreenState | undefined): void {
		const menu = screen?.menu;
		const dialog = screen?.dialog;
		const key = JSON.stringify([menu, dialog]);
		if (key === this._overlayKey) {
			return;
		}
		this._overlayKey = key;
		this._menu = menu;
		const hadOverlay = this._menuPop.classList.contains('visible') || this._askCard.classList.contains('visible');
		this._menuPop.classList.toggle('visible', !!menu?.items.length);
		this._menuPop.classList.toggle('mcp-menu-files', menu?.kind === 'file');
		this._askCard.classList.toggle('visible', !!dialog);
		this._root.classList.toggle('mcp-asking', !!dialog);
		if (hadOverlay !== (!!menu?.items.length || !!dialog)) {
			this._relayout();
		}
		dom.clearNode(this._menuPop);
		if (menu?.items.length) {
			const head = dom.append(this._menuPop, dom.$('.mcp-menu-head'));
			dom.append(head, dom.$('span', undefined, menu.kind === 'file' ? localize('maut.claude.menuFiles', "Files") : localize('maut.claude.menuCommands', "Commands")));
			dom.append(head, dom.$('span.mcp-menu-keys', undefined, menu.kind === 'file'
				? localize('maut.claude.menuFileKeys', "\u2191\u2193 move \u00b7 tab insert \u00b7 esc close")
				: localize('maut.claude.menuCommandKeys', "\u2191\u2193 move \u00b7 \u21b5 run \u00b7 tab complete \u00b7 esc close")));
			const list = dom.append(this._menuPop, dom.$('.mcp-menu-list'));
			let selectedRow: HTMLElement | undefined;
			menu.items.forEach((item, index) => {
				const row = dom.append(list, dom.$<HTMLButtonElement>(`button.mcp-menu-item${item.selected ? '.selected' : ''}`, { type: 'button' }));
				if (item.selected) {
					selectedRow = row;
				}
				dom.append(row, dom.$('span.mcp-menu-name', undefined, item.name));
				if (item.detail) {
					dom.append(row, dom.$('span.mcp-menu-detail', undefined, item.detail));
				}
				row.addEventListener('click', () => this._pickMenuItem(index));
			});
			selectedRow?.scrollIntoView({ block: 'nearest' });
		}
		dom.clearNode(this._askCard);
		if (dialog) {
			dom.append(this._askCard, dom.$('.mcp-ask-question', undefined, dom.$('i'), dom.$('span', undefined, dialog.question)));
			if (dialog.details.length) {
				dom.append(this._askCard, dom.$('pre.mcp-ask-details', undefined, dialog.details.join('\n')));
			}
			const options = dom.append(this._askCard, dom.$('.mcp-ask-options'));
			for (const option of dialog.options) {
				const button = dom.append(options, dom.$<HTMLButtonElement>(`button.mcp-ask-option${option.selected ? '.selected' : ''}`, { type: 'button' }));
				dom.append(button, dom.$('kbd', undefined, option.key));
				dom.append(button, dom.$('span', undefined, option.text));
				button.addEventListener('click', () => {
					this._instance?.sendText(option.key, false);
					this._instance?.focus();
				});
			}
			if (dialog.hint) {
				dom.append(this._askCard, dom.$('.mcp-ask-hint', undefined, dialog.hint));
			}
		}
	}

	/** A click on a menu row moves Claude's selection there and completes it, as Tab would. */
	private _pickMenuItem(index: number): void {
		const menu = this._menu;
		const instance = this._instance;
		if (!menu || !instance) {
			return;
		}
		const from = Math.max(0, menu.items.findIndex(item => item.selected));
		const steps = index - from;
		const key = steps > 0 ? '\x1b[B' : '\x1b[A';
		instance.sendText(key.repeat(Math.abs(steps)) + '\t', false);
		instance.focus();
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
				this._repaint.schedule();
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
		this._sessionLive = !!session;
		const raw = instance.xterm?.raw;
		this._noteClaude(!!session || (!!raw && readScreen(raw).claude));
		if (!this.active || this._claudeGone) {
			return;
		}
		if (!session) {
			if (this._renderedKey !== 'none') {
				this._renderedKey = 'none';
				dom.clearNode(this._column);
				dom.append(this._column, dom.$('.mcp-empty', undefined, localize('maut.claude.noSession', "The conversation appears here once Claude has saved it. Type below to start.")));
				// Claude's work on your first message shows live even before anything is saved.
				this._column.appendChild(this._live);
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
		const working = this.active && this._isWorking();
		if (this._instance) {
			this._claudeService.setWorking(this._instance, working);
		}
		const activity = working ? this._currentActivity() : undefined;
		this._now.classList.add('visible');
		this._now.classList.toggle('idle', !activity);
		const verb = working ? spinnerParts(this._lastLive?.status ?? '').verb : '';
		if (this._nowVerb.textContent !== verb) {
			this._nowVerb.textContent = verb;
		}
		if (!activity) {
			this._nowPending = undefined;
			this._nowElapsed.textContent = '';
			const ready = localize('maut.claude.nowReady', "Ready for your next message");
			if (this._nowLabel.textContent !== ready) {
				this._nowLabel.textContent = ready;
				this._nowFile = undefined;
				this._nowFull = ready;
			}
			return;
		}
		// The time ticks in place; the activity itself changes only once it has held for 600ms.
		// The figures from Claude's spinner line ("1m 12s \u00b7 \u2193 4.2k tokens") sit after the activity.
		const figures = spinnerParts(this._lastLive?.status ?? '').rest.replace(/^\(|\)$/g, '').trim() || activity.elapsed;
		this._nowElapsed.textContent = figures ? `\u00b7 ${figures}` : '';
		const shown = this._nowLabel.textContent;
		if (activity.label !== shown) {
			const now = Date.now();
			if (this._nowPending?.label !== activity.label) {
				this._nowPending = { label: activity.label, since: now };
			}
			if (shown && now - this._nowPending.since < 600) {
				this._nowRecheck.schedule();
				return;
			}
			this._nowLabel.textContent = activity.label;
			this._nowFile = activity.file;
			this._nowFull = activity.file
				? localize('maut.claude.nowOpen', "{0}. Click to open the file.", activity.label)
				: localize('maut.claude.nowJump', "{0}. Click to see the latest.", activity.label);
		}
		this._nowPending = undefined;
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

	/** The line under the input: Claude's notice if it has one, else its footer (the permission mode). */
	private _setNotice(notice: string, footer = ''): void {
		const text = notice || footer || defaultLiveNote();
		if (this._liveNoteText.textContent !== text) {
			this._liveNoteText.textContent = text;
			this._liveNote.classList.toggle('mcp-notice', !!notice);
			this._liveNote.classList.toggle('mcp-footer', !notice && !!footer);
		}
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
							actionHandler: link => this._openLink(link),
						}));
						rendered.element.classList.add('mcp-prose');
						this._linkPaths(rendered.element, this._activityDisposables);
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
		if (this._claudeGone) {
			this._renderGoneHeader();
			return;
		}
		const session = this._session;
		const project = session?.project || this._workspaceContextService.getWorkspace().folders[0]?.name || localize('maut.claude.title', "Claude");
		const meta = session?.model ? modelLabel(session.model) : '';

		// Rebuild only when something shown changed: a rebuild drops hovers and focus.
		const running = session?.tasks?.filter(task => task.status === 'running').length ?? 0;
		const key = JSON.stringify([project, meta, session?.contextTokens, session?.contextWindow, running, this._activityOpen, this._instance ? this._claudeService.viewOf(this._instance) : 'reader', this._claudeService.layoutMode]);
		this._updateNow();
		if (key === this._headerKey && this._header.childElementCount) {
			return;
		}
		this._headerKey = key;
		this._headerDisposables.clear();
		dom.clearNode(this._header);

		const top = dom.append(this._header, dom.$('.mcp-hrow.mcp-hrow-top'));
		dom.append(top, dom.$('span.mcp-avatar'));
		dom.append(top, dom.$('span.mcp-name', undefined, project));
		dom.append(top, dom.$('span.mcp-meta', undefined, meta));
		dom.append(top, dom.$('span.mcp-grow'));
		top.appendChild(this._segment<MautClaudeView>(localize('maut.claude.viewLabel', "View"), [
			['reader', localize('maut.claude.reader', "Reader"), undefined, Codicon.commentDiscussion],
			['terminal', localize('maut.claude.terminal', "Terminal"), undefined, Codicon.terminal],
		], this._instance ? this._claudeService.viewOf(this._instance) : 'reader', view => this._instance && this._claudeService.setView(this._instance, view)));
		top.appendChild(this._iconButton(Codicon.linkExternal,
			localize('maut.claude.remoteControl', "Open this session in the Claude app (Remote Control)"),
			() => void this._openRemoteControl()));
		const ide = this._claudeService.layoutMode === 'ide';
		top.appendChild(this._iconButton(ide ? Codicon.screenFull : Codicon.layoutSidebarLeft,
			ide ? localize('maut.claude.toFocus', "Focus layout: Claude takes the window (\u2318B)") : localize('maut.claude.toIde', "IDE layout: files beside Claude (\u2318B)"),
			() => this._claudeService.requestLayoutMode(ide ? 'focus' : 'ide')));
		top.appendChild(this._iconButton(Codicon.layoutSidebarRightOff,
			isMacintosh ? localize('maut.claude.hideMac', "Hide Claude (\u21e7\u2318J)") : localize('maut.claude.hideOther', "Hide Claude (Ctrl+Shift+J)"),
			() => this._claudeService.requestToggleHidden()));

		const bottom = dom.append(this._header, dom.$('.mcp-hrow.mcp-hrow-bottom'));
		bottom.appendChild(this._now);
		bottom.appendChild(this._contextButton(session));
		bottom.appendChild(this._activityButton(session));
	}

	/** Claude has left this terminal: say so, and offer to start it again. The terminal shows as is. */
	private _renderGoneHeader(): void {
		if (this._headerKey === 'gone' && this._header.childElementCount) {
			return;
		}
		this._headerKey = 'gone';
		this._headerDisposables.clear();
		dom.clearNode(this._header);
		const row = dom.append(this._header, dom.$('.mcp-hrow.mcp-gone-row'));
		dom.append(row, dom.$('span.mcp-avatar'));
		dom.append(row, dom.$('span.mcp-gone-text', undefined, localize('maut.claude.notRunning', "Claude isn't running in this terminal")));
		dom.append(row, dom.$('span.mcp-grow'));
		const start = dom.append(row, dom.$<HTMLButtonElement>('button.mcp-start-claude', { type: 'button' }, localize('maut.claude.startClaude', "Start Claude")));
		this._headerDisposables.add(dom.addDisposableListener(start, dom.EventType.CLICK, () => this._startClaude()));
	}

	/**
	 * The latest Remote Control link this Claude printed (`/remote-control` prints a claude.ai
	 * session link), read from the terminal's history so the newest one wins, and remembered per
	 * terminal so it still opens after the link has scrolled away or the screen was cleared.
	 */
	private _remoteControlSession(instance: ITerminalInstance): string | undefined {
		const buffer = instance.xterm?.raw.buffer.active;
		if (buffer) {
			let text = '';
			for (let row = Math.max(0, buffer.length - 5000); row < buffer.length; row++) {
				const line = buffer.getLine(row);
				if (line) {
					// Soft-wrapped rows join up, so a link split across the width still matches.
					text += (line.isWrapped ? '' : '\n') + line.translateToString(true);
				}
			}
			for (const match of text.matchAll(/claude\.ai\/code\/(?<session>session_[A-Za-z0-9]+)/g)) {
				if (match.groups?.session) {
					remoteControlSessions.set(instance, match.groups.session);
				}
			}
		}
		return remoteControlSessions.get(instance);
	}

	/**
	 * Opens the session in the Claude app. With Remote Control off (no link yet), turns it on
	 * behind a cover over the input, answers "continue" if Claude asks, then opens it.
	 */
	private async _openRemoteControl(): Promise<void> {
		const instance = this._instance;
		if (!instance) {
			return;
		}
		let session = this._remoteControlSession(instance);
		if (!session) {
			const cover = dom.append(this._terminalHost, dom.$('.mcp-rc-cover', undefined, localize('maut.claude.rcStarting', "Turning on Remote Control\u2026")));
			try {
				await instance.sendText('/remote-control', true);
				let answered = false;
				for (let attempt = 0; attempt < 24 && !session; attempt++) {
					await timeout(400);
					session = this._remoteControlSession(instance);
					const raw = instance.xterm?.raw;
					const dialog = !session && !answered && raw ? readScreen(raw).dialog : undefined;
					const keep = dialog?.options.find(option => /continue|keep|stay/i.test(option.text));
					if (keep) {
						// Already on, but its link is gone from the screen: keep it on, which shows the link.
						answered = true;
						await instance.sendText(keep.selected ? '\r' : keep.key, false);
					}
				}
			} finally {
				cover.remove();
			}
		}
		if (!session) {
			return;
		}
		const opened = await this._openerService.open(URI.parse(`claude://claude.ai/code/${session}`), { openExternal: true });
		if (!opened) {
			await this._openerService.open(URI.parse(`https://claude.ai/code/${session}`), { openExternal: true, allowContributedOpeners: false });
		}
	}

	private _iconButton(icon: ThemeIcon, label: string, run: () => void): HTMLElement {
		const button = dom.$<HTMLButtonElement>(`button.mcp-icon-button${ThemeIcon.asCSSSelector(icon)}`, { type: 'button' });
		button.setAttribute('aria-label', label);
		this._headerDisposables.add(this._hoverService.setupDelayedHover(button, { content: label }));
		this._headerDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, run));
		return button;
	}

	private _contextButton(session: IClaudeSessionView | undefined): HTMLElement {
		const element = dom.$('span.mcp-context');
		const tokens = session?.contextTokens;
		const window = session?.contextWindow;
		if (tokens === undefined || !window) {
			return element;
		}
		const percent = Math.min(100, Math.round(tokens / window * 100));
		const meter = dom.append(element, dom.$('span.mcp-context-meter'));
		const fill = dom.append(meter, dom.$('b'));
		fill.style.width = `${percent}%`;
		element.classList.toggle('high', percent >= 80);
		dom.append(element, dom.$('span', undefined, localize('maut.claude.contextShort', "{0}%", percent)));
		this._headerDisposables.add(this._hoverService.setupDelayedHover(element, { content: localize('maut.claude.contextHover', "{0} of {1} tokens in Claude's context. Run /context in Claude for the breakdown.", formatTokens(tokens), formatTokens(window)) }));
		return element;
	}

	private _segment<T extends string>(label: string, options: [T, string, string | undefined, ThemeIcon?][], current: T, pick: (value: T) => void): HTMLElement {
		const group = dom.$('.mcp-seg');
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', label);
		for (const [value, text, hint, icon] of options) {
			const button = dom.append(group, dom.$<HTMLButtonElement>('button.mcp-seg-button', { type: 'button' }));
			if (icon) {
				dom.append(button, dom.$(`span.mcp-seg-icon${ThemeIcon.asCSSSelector(icon)}`));
			}
			dom.append(button, dom.$('span.mcp-seg-label', undefined, text));
			button.setAttribute('aria-label', text);
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
				bubble.appendChild(this._promptText(turn.prompt));
				this._appendFileChips(bubble, turn.prompt, this._renderDisposables);
			}
			if (turn.images.length) {
				const chips = dom.append(bubble, dom.$('.mcp-attachments'));
				for (const n of turn.images) {
					chips.appendChild(this._imageChip(n, turn.time));
				}
			}
		}
		const reply = dom.append(element, dom.$('.mcp-reply'));
		dom.append(reply, dom.$('span.mcp-avatar'));
		const body = dom.append(reply, dom.$('.mcp-body'));
		const replyText = turnReplyText(turn);
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
					bubble.appendChild(this._promptText(item.text));
					this._appendFileChips(bubble, item.text, this._renderDisposables);
				}
				if (item.images.length) {
					const chips = dom.append(bubble, dom.$('.mcp-attachments'));
					for (const n of item.images) {
						// Sent while Claude worked: no time of its own, but within this turn.
						chips.appendChild(this._imageChip(n, turn.end));
					}
				}
			} else if (item.kind === 'interrupted') {
				dom.append(body, dom.$('.mcp-interrupted', undefined, dom.$('i'), dom.$('span', undefined, localize('maut.claude.interrupted', "Interrupted by you. Claude stopped here and is waiting for what to do instead."))));
			} else if (item.kind === 'text') {
				const rendered = this._renderDisposables.add(renderMarkdown(new MarkdownString(item.text), {
					// Links open where they belong: web pages in Dovo's browser, files in the editor.
					actionHandler: link => this._openLink(link),
				}));
				rendered.element.classList.add('mcp-prose');
				this._linkPaths(rendered.element, this._renderDisposables);
				body.appendChild(rendered.element);
			} else {
				body.appendChild(this._renderEdit(item));
			}
		}
		// The steps Claude is on right now stay open, so you see each command as it runs.
		flushSteps(live);
		if (changedFiles.length) {
			body.appendChild(this._renderChangedFiles(changedFiles, turn));
		}
		if (live) {
			dom.append(body, dom.$('.mcp-working', undefined, localize('maut.claude.workingLine', "Working…")));
		} else if (turn.end > turn.time || replyText) {
			const foot = dom.append(body, dom.$('.mcp-foot'));
			if (replyText) {
				foot.appendChild(this._copyButton(replyText));
			}
			if (turn.end > turn.time) {
				dom.append(foot, dom.$('span', undefined, localize('maut.claude.workedFor', "Worked for {0}", duration(turn.end - turn.time))));
			}
		}
		if (!body.childElementCount) {
			reply.remove();
		}
		return element;
	}

	/** Files Claude changed in a turn, however it changed them (its shell commands included). */
	private _renderChangedFiles(files: readonly IChangedFile[], turn: IClaudeTurn): HTMLElement {
		// Lines added and removed per file, from the turn's edits (a file changed only by a shell
		// command has none to count).
		const counts = new Map<string, { added: number; removed: number }>();
		for (const item of turn.items) {
			if (item.kind === 'edit') {
				const count = counts.get(item.file) ?? { added: 0, removed: 0 };
				count.added += item.added;
				count.removed += item.removed;
				counts.set(item.file, count);
			}
		}
		const countOf = (file: IChangedFile) => counts.get(file.path) ?? [...counts].find(([path]) => path.endsWith(`/${file.label}`) || file.path.endsWith(path))?.[1];
		const box = dom.$('.mcp-changed');
		dom.append(box, dom.$('.mcp-changed-head', undefined, files.length === 1 ? localize('maut.claude.changedOne', "Changed 1 file") : localize('maut.claude.changedMany', "Changed {0} files", files.length)));
		for (const file of files.slice(0, 30)) {
			const row = dom.append(box, dom.$('.mcp-changed-row'));
			const name = dom.append(row, dom.$('button.mcp-changed-file', { type: 'button' }, file.label));
			name.dataset.file = file.path;
			this._renderDisposables.add(this._hoverService.setupDelayedHover(name, { content: localize('maut.claude.openFile', "Open {0}", file.label) }));
			const count = countOf(file);
			if (count && (count.added || count.removed)) {
				const figures = dom.append(row, dom.$('span.mcp-changed-count'));
				if (count.added) {
					dom.append(figures, dom.$('span.mcp-changed-added', undefined, `+${count.added}`));
				}
				if (count.removed) {
					dom.append(figures, dom.$('span.mcp-changed-removed', undefined, `\u2212${count.removed}`));
				}
			}
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
		// The same file read twice (a screenshot Claude retook) shows once.
		const seen = new Set<string>();
		for (const step of images) {
			if (seen.has(step.file!)) {
				continue;
			}
			seen.add(step.file!);
			const thumb = dom.append(strip, dom.$<HTMLImageElement>('img.mcp-read-image'));
			thumb.alt = '';
			thumb.dataset.file = step.file;
			loadImage(thumb, step.file!, () => {
				// Still unreadable: a plain chip that opens the file, not a broken image.
				const chip = dom.$<HTMLButtonElement>('button.mcp-read-image-missing', { type: 'button' }, basename(step.file!));
				chip.dataset.file = step.file;
				thumb.replaceWith(chip);
			});
			this._renderDisposables.add(this._hoverService.setupDelayedHover(thumb, () => {
				const preview = dom.$('.maut-claude-image-hover');
				const large = dom.append(preview, dom.$<HTMLImageElement>('img'));
				large.src = thumb.src;
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

	/**
	 * Opens a file someone named: a picture or a PDF in a popup over the window, to glance at;
	 * code and every other file in the files group (on the right in Focus, the left in IDE),
	 * never as a tab beside Claude.
	 */
	private async _openResource(resource: URI): Promise<void> {
		if (popupExtensionRegex.test(resource.path)) {
			await this._editorService.openEditor({ resource, options: { pinned: true } }, MODAL_GROUP);
			return;
		}
		const main = this._editorGroupsService.mainPart;
		const isFiles = (group: IEditorGroup) => !group.editors.some(editor => editor.typeId === terminalEditorTypeId);
		const files = isFiles(main.activeGroup) ? main.activeGroup : main.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE).find(isFiles);
		await this._editorService.openEditor({ resource, options: { pinned: true } }, files ?? main.addGroup(main.activeGroup, GroupDirection.RIGHT));
	}

	/**
	 * File paths in Claude's text become links that open the file, like the paths in your own
	 * messages: absolute paths anywhere (code blocks included), and relative ones that make up a
	 * whole piece of inline code. Links stay as they are.
	 */
	private _linkPaths(element: HTMLElement, store: DisposableStore): void {
		const link = (label: string, title: string, open: () => void) => {
			const button = dom.$<HTMLButtonElement>('button.mcp-path-link', { type: 'button' }, label);
			button.title = localize('maut.claude.openAttached', "Open {0}", title);
			store.add(dom.addDisposableListener(button, dom.EventType.CLICK, e => {
				e.stopPropagation();
				open();
			}));
			return button;
		};
		const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.parentElement && !node.parentElement.closest('a')) {
				nodes.push(node as Text);
			}
		}
		for (const node of nodes) {
			const text = node.data;
			// Inline code that is a whole relative path (`docs/brief/plan.pdf`): from Claude's folder.
			const inlineCode = node.parentElement?.tagName === 'CODE' && !node.parentElement.closest('pre');
			const relative = text.trim();
			if (inlineCode && relativePathRegex.test(relative)) {
				node.replaceWith(link(text, relative, () => void this._openFile(relative)));
				continue;
			}
			// Absolute paths and file:// links anywhere, code blocks included.
			const matches = [...text.matchAll(attachedPathRegex)];
			if (!matches.length) {
				continue;
			}
			const fragment = element.ownerDocument.createDocumentFragment();
			let at = 0;
			for (const match of matches) {
				const resource = attachedPathResource(match[0]);
				if (!resource) {
					continue;
				}
				fragment.append(text.slice(at, match.index), link(match[0], resource.fsPath, () => void this._openResource(resource)));
				at = match.index + match[0].length;
			}
			fragment.append(text.slice(at));
			node.replaceWith(fragment);
		}
	}

	/**
	 * Your message as you wrote it, with every attached file path (a pasted path or file:// link)
	 * kept as text but clickable: it opens the file in a popup over the window.
	 */
	private _promptText(text: string): HTMLElement {
		const element = dom.$('.mcp-prompt');
		let at = 0;
		for (const match of text.matchAll(attachedPathRegex)) {
			const resource = attachedPathResource(match[0]);
			if (!resource) {
				continue;
			}
			element.append(text.slice(at, match.index));
			const link = dom.append(element, dom.$<HTMLButtonElement>('button.mcp-path-link', { type: 'button' }, match[0]));
			link.title = localize('maut.claude.openAttached', "Open {0}", resource.fsPath);
			this._renderDisposables.add(dom.addDisposableListener(link, dom.EventType.CLICK, e => {
				e.stopPropagation();
				void this._openResource(resource);
			}));
			at = match.index + match[0].length;
		}
		element.append(text.slice(at));
		return element;
	}

	/** The files whose paths are in `text`, as they'd open: each only once. */
	private _attachedFiles(text: string): URI[] {
		const files = new Map<string, URI>();
		for (const match of text.matchAll(attachedPathRegex)) {
			const resource = attachedPathResource(match[0]);
			if (resource) {
				files.set(resource.toString(), resource);
			}
		}
		return [...files.values()];
	}

	/** Thumbnail chips under a message for the files it names. */
	private _appendFileChips(bubble: HTMLElement, text: string, store: DisposableStore): void {
		const files = this._attachedFiles(text);
		if (files.length) {
			const chips = dom.append(bubble, dom.$('.mcp-attachments.mcp-file-chips'));
			for (const resource of files) {
				chips.appendChild(this._fileChip(resource, store));
			}
		}
	}

	/** What you're writing, read off Claude's input box: its rows without the box's borders. */
	private _updateInputFiles(raw: XtermTerminal, screen: IScreenState): void {
		const buffer = raw.buffer.active;
		let text = '';
		let previousFull = false;
		for (let row = screen.frame.from; row <= screen.frame.to; row++) {
			const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '';
			const content = line.replace(/^[\s\u2502>\u276f]+|[\s\u2502]+$/g, '');
			// Claude wraps a long line itself: only a row that filled the box continues on the next
			// one (a path cut mid-way); any other row break separates, so "[Image #1]" on one row and
			// a path on the next stay two words.
			text += (text ? (previousFull ? '' : '\n') : '') + content;
			previousFull = line.replace(/[\s\u2502]+$/, '').length >= raw.cols - 6;
		}
		const files = this._attachedFiles(text);
		// The previews float just above the input, over the conversation: never in the input's
		// way, so the input keeps its place and size however many files there are.
		this._inputFiles.style.bottom = `${Math.max(0, this._root.clientHeight - this._terminalHost.offsetTop)}px`;
		const key = files.map(file => file.toString()).join('|');
		if (key === this._inputFilesKey) {
			return;
		}
		this._inputFilesKey = key;
		this._inputFileDisposables.clear();
		dom.clearNode(this._inputFiles);
		this._inputFiles.classList.toggle('shown', files.length > 0);
		for (const resource of files) {
			this._inputFiles.appendChild(this._fileChip(resource, this._inputFileDisposables));
		}
		this._relayout();
	}

	/** A file's chip: its thumbnail (a PDF's first page, the image) or icon, and its name. Opens it. */
	private _fileChip(resource: URI, store: DisposableStore): HTMLElement {
		const chip = dom.$<HTMLButtonElement>('button.mcp-file-chip', { type: 'button' });
		const preview = dom.append(chip, dom.$('span.mcp-file-thumb'));
		dom.append(preview, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.file)}`));
		dom.append(chip, dom.$('span.mcp-file-name', undefined, basename(resource.fsPath)));
		chip.title = resource.fsPath;
		const path = resource.fsPath;
		let thumbnail = this._thumbnails.get(path);
		if (!thumbnail) {
			thumbnail = Promise.resolve(this._commandService.executeCommand<string | undefined>(fileThumbnailCommandId, path)).catch(() => undefined);
			this._thumbnails.set(path, thumbnail);
		}
		void thumbnail.then(file => {
			if (file) {
				const image = dom.$<HTMLImageElement>('img');
				image.alt = '';
				loadImage(image, file, () => image.remove());
				dom.clearNode(preview);
				preview.appendChild(image);
			}
		});
		store.add(dom.addDisposableListener(chip, dom.EventType.CLICK, e => {
			e.stopPropagation();
			e.preventDefault();
			void this._openResource(resource);
		}));
		// Keep the click from moving focus out of the input.
		store.add(dom.addDisposableListener(chip, dom.EventType.MOUSE_DOWN, e => e.preventDefault()));
		return chip;
	}

	/** `[Image #n]` with its thumbnail; `time` picks the right one when Claude reused the number. */
	private _imageChip(n: number, time?: number): HTMLElement {
		const key = `${n}@${time ?? 'latest'}`;
		const chip = dom.$('span.mcp-chip', undefined, `[Image #${n}]`);
		const show = (path: string | undefined) => {
			if (!path) {
				return;
			}
			const thumb = dom.$<HTMLImageElement>('img');
			thumb.alt = '';
			loadImage(thumb, path, () => thumb.remove());
			chip.prepend(thumb);
			chip.dataset.file = path;
		};
		if (this._imagePaths.has(key)) {
			show(this._imagePaths.get(key));
		} else {
			this._commandService.executeCommand<string | undefined>(resolveImageCommandId, this._instance?.processId, n, time).then(path => {
				this._imagePaths.set(key, path);
				show(path);
			}, () => { /* the extension isn't running yet */ });
		}
		return chip;
	}

	/** Copies one reply of Claude's, as the Markdown Claude wrote. */
	private _copyButton(text: string): HTMLElement {
		const label = localize('maut.claude.copyResponse', "Copy Response");
		const button = dom.$<HTMLButtonElement>(`button.mcp-copy${ThemeIcon.asCSSSelector(Codicon.copy)}`, { type: 'button' });
		button.setAttribute('aria-label', label);
		this._renderDisposables.add(this._hoverService.setupDelayedHover(button, { content: label }));
		this._renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, async () => {
			await this._clipboardService.writeText(text);
			button.classList.replace(ThemeIcon.asClassName(Codicon.copy), ThemeIcon.asClassName(Codicon.check));
			button.classList.add('copied');
			const timer = dom.getWindow(button).setTimeout(() => {
				button.classList.replace(ThemeIcon.asClassName(Codicon.check), ThemeIcon.asClassName(Codicon.copy));
				button.classList.remove('copied');
			}, 1400);
			this._renderDisposables.add(toDisposable(() => dom.getWindow(button).clearTimeout(timer)));
		}));
		return button;
	}

	/** The text you marked in the Reader, if any. */
	/**
	 * Web pages open in Dovo's browser tab (Cmd+click: your default browser), files and other
	 * links where they belong.
	 */
	private _openLink(link: string): Promise<boolean> {
		const toDefaultBrowser = this._linkToDefaultBrowser;
		this._linkToDefaultBrowser = false;
		if (/^https?:\/\//i.test(link)) {
			return toDefaultBrowser
				? this._openerService.open(link, { openExternal: true, fromUserGesture: true, allowContributedOpeners: false })
				: this._openerService.open(link, { fromUserGesture: true, allowCommands: false, allowContributedOpeners: true });
		}
		return this._openerService.open(link, { fromUserGesture: true, allowCommands: false });
	}

	private _selectedText(): string {
		const selection = dom.getWindow(this._reader).getSelection();
		if (!selection || selection.isCollapsed || !selection.rangeCount || !dom.isAncestor(selection.getRangeAt(0).commonAncestorContainer, this._reader)) {
			return '';
		}
		return selection.toString();
	}

	/** Right-click in the Reader: copy what you marked, the reply you clicked, or the whole conversation. */
	private _onReaderContextMenu(e: MouseEvent): void {
		const session = this._session;
		if (!session) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const selected = this._selectedText();
		const turnElement = (e.target as HTMLElement).closest('.mcp-turn');
		const index = turnElement ? [...this._column.children].filter(child => child.classList.contains('mcp-turn')).indexOf(turnElement) : -1;
		const turn = index >= 0 ? session.turns[index] : undefined;
		const reply = turn ? turnReplyText(turn) : '';
		this._contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => [
				toAction({ id: 'maut.claude.copySelection', label: localize('maut.claude.copySelection', "Copy"), enabled: !!selected, run: () => this._clipboardService.writeText(selected) }),
				toAction({ id: 'maut.claude.copyResponse', label: localize('maut.claude.copyResponse', "Copy Response"), enabled: !!reply, run: () => this._clipboardService.writeText(reply) }),
				toAction({ id: 'maut.claude.copyConversation', label: localize('maut.claude.copyConversation', "Copy Conversation"), enabled: session.turns.length > 0, run: () => this._clipboardService.writeText(conversationText(session.turns)) }),
			],
		});
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
		await this._openResource(resource);
	}
}

/** Text as the terminal shows it: Markdown's symbols gone, every run of white space one space. */
function plainText(text: string): string {
	return text.replace(/\[(?<label>[^\]]*)\]\([^)]*\)/g, '$<label>').replace(/[*_`#>~]/g, '').replace(/\s+/g, ' ').trim();
}

/** What Claude wrote in a turn, as Markdown: its prose, without the tool steps. */
function turnReplyText(turn: IClaudeTurn): string {
	return turn.items.flatMap(item => item.kind === 'text' && item.text.trim() ? [item.text.trim()] : []).join('\n\n');
}

/** The whole conversation as Markdown: your prompts and Claude's replies, in order. */
function conversationText(turns: readonly IClaudeTurn[]): string {
	const you = localize('maut.claude.copyYou', "You");
	const claude = localize('maut.claude.copyClaude', "Claude");
	const parts: string[] = [];
	for (const turn of turns) {
		if (turn.prompt) {
			parts.push(`**${you}:** ${turn.prompt.trim()}`);
		}
		for (const item of turn.items) {
			if (item.kind === 'user' && item.text) {
				parts.push(`**${you}:** ${item.text.trim()}`);
			} else if (item.kind === 'text' && item.text.trim()) {
				parts.push(`**${claude}:** ${item.text.trim()}`);
			}
		}
	}
	return parts.join('\n\n');
}

/** The terminal's 16 theme colours, by palette index. */
const ansiColors = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White', 'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite']
	.map(name => `var(--vscode-terminal-ansi${name})`);

/** A palette index (xterm's 256 colours) as CSS. */
function paletteColor(index: number): string {
	if (index < 16) {
		return ansiColors[index];
	}
	if (index < 232) {
		const levels = [0, 95, 135, 175, 215, 255];
		const n = index - 16;
		return `rgb(${levels[Math.floor(n / 36)]}, ${levels[Math.floor(n / 6) % 6]}, ${levels[n % 6]})`;
	}
	const gray = 8 + (index - 232) * 10;
	return `rgb(${gray}, ${gray}, ${gray})`;
}

function cellColor(rgb: boolean, palette: boolean, value: number): string {
	if (rgb) {
		return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
	}
	return palette ? paletteColor(value) : '';
}

/** One terminal cell's look as inline CSS: colours, bold, dim, italic, underline. */
function cellLook(cell: IBufferCell): { style: string; background: string } {
	let color = cellColor(!!cell.isFgRGB(), !!cell.isFgPalette(), cell.getFgColor());
	let background = cellColor(!!cell.isBgRGB(), !!cell.isBgPalette(), cell.getBgColor());
	if (cell.isInverse()) {
		[color, background] = [background || 'var(--vscode-terminal-background, var(--vscode-editor-background))', color || 'var(--vscode-terminal-foreground, var(--vscode-foreground))'];
	}
	const parts: string[] = [];
	if (color) {
		parts.push(`color: ${color}`);
	}
	if (background) {
		parts.push(`background-color: ${background}`);
	}
	if (cell.isBold()) {
		parts.push('font-weight: 600');
	}
	if (cell.isDim()) {
		parts.push('opacity: .6');
	}
	if (cell.isItalic()) {
		parts.push('font-style: italic');
	}
	if (cell.isUnderline()) {
		parts.push('text-decoration: underline');
	}
	return { style: parts.join('; '), background };
}

/**
 * Claude's live output exactly as the terminal shows it: each row's cells grouped into runs that
 * look the same. Rows the terminal wrapped continue the line before them; a background that runs
 * to the edge (a diff line) fills the whole line.
 */
function readRichLines(buffer: IBuffer, rows: readonly number[], cols: number): ILiveLine[] {
	const lines: { runs: ILiveRun[]; background: string }[] = [];
	const cell = buffer.getNullCell();
	for (const row of rows) {
		const line = buffer.getLine(buffer.viewportY + row);
		if (!line) {
			continue;
		}
		// The last cell worth showing: text, or a background colour (diff lines are filled to the edge).
		let end = Math.min(cols, line.length) - 1;
		for (; end >= 0; end--) {
			line.getCell(end, cell);
			if (cell.getChars().trim() || !cell.isBgDefault()) {
				break;
			}
		}
		const runs: ILiveRun[] = [];
		let lineBackground = '';
		for (let x = 0; x <= end; x++) {
			line.getCell(x, cell);
			if (cell.getWidth() === 0) {
				continue; // the second half of a wide character
			}
			const look = cellLook(cell);
			const text = cell.getChars() || ' ';
			const previous = runs.at(-1);
			if (previous && previous.style === look.style) {
				runs[runs.length - 1] = { text: previous.text + text, style: look.style };
			} else {
				runs.push({ text, style: look.style });
			}
			if (x === end && look.background && end >= cols - 2) {
				lineBackground = look.background;
			}
		}
		const previousLine = lines.at(-1);
		if (line.isWrapped && previousLine) {
			previousLine.runs.push(...runs);
			previousLine.background ||= lineBackground;
		} else {
			lines.push({ runs, background: lineBackground });
		}
	}
	// The block's own bullet is drawn by the Reader.
	const firstRun = lines[0]?.runs[0];
	if (firstRun && /^\u23fa/.test(firstRun.text)) {
		const text = firstRun.text.replace(/^\u23fa\s*/, '');
		if (text) {
			lines[0].runs[0] = { text, style: firstRun.style };
		} else {
			lines[0].runs.shift();
			const next = lines[0].runs[0];
			if (next) {
				lines[0].runs[0] = { text: next.text.replace(/^\s+/, ''), style: next.style };
			}
		}
	}
	return lines;
}

/**
 * Claude's spinner line, "Booping\u2026 (2m 14s \u00b7 \u2193 1.2k tokens)", split into its word and the rest, so the
 * word can carry Claude's orange shimmer and the figures stay quiet.
 */
function spinnerParts(status: string): { verb: string; rest: string } {
	const match = /^(?<verb>[^()]*?\u2026)\s*(?<rest>.*)$/.exec(status.trim());
	return match?.groups ? { verb: match.groups.verb.trim(), rest: match.groups.rest } : { verb: '', rest: status.trim() };
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

/**
 * Shows an image file. A failed load is cached by the browser under that address, and Claude's
 * screenshots are often rewritten in place, so a half-written file would stay broken: retry once
 * with a fresh address, then give up.
 */
function loadImage(img: HTMLImageElement, path: string, onFail: () => void): void {
	const src = FileAccess.uriToBrowserUri(URI.file(path));
	let retried = false;
	img.addEventListener('error', () => {
		if (retried) {
			onFail();
			return;
		}
		retried = true;
		dom.getWindow(img).setTimeout(() => img.src = src.with({ query: `t=${Date.now()}` }).toString(true), 500);
	});
	img.src = src.toString(true);
}

function defaultLiveNote(): string {
	return localize('maut.claude.liveNote', "Live Claude terminal. What you type goes straight to Claude.");
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
