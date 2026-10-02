/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IBufferCell, Terminal as RawXtermTerminal } from '@xterm/xterm';
import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/path.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import type { IXtermCore } from '../../../terminal/browser/xterm-private.js';
import './media/claudeImages.css';

/**
 * Command contributed by the built-in `maut-claude-images` extension. It maps the terminal's
 * shell pid and an image number to the image file Claude Code stored for that session.
 */
const resolveImageCommandId = '_maut.claudeImages.resolve';
/** Same extension: snapshots the clipboard as image N of the terminal's session. */
const captureClipboardCommandId = '_maut.claudeImages.captureClipboard';
const imageReferenceRegex = /\[Image #(?<index>\d+)\]/g;
/** An image file path Claude printed, e.g. `Read(/Users/me/site/img/burger.jpg)` or `img/logo.png`. */
// Not preceded by a slash rule, so `file:///…/shot.png` links match too; web addresses yield
// paths that don't exist on disk and so never get a preview.
const imagePathRegex = /(?<![\w@.~-])(?<path>(?:~\/|\/|\.{1,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.(?:png|jpe?g|gif|webp|bmp))(?![\w.])/gi;
const imageExtensionRegex = /\.(?:png|jpe?g|gif|webp|bmp)\b/i;
/** How long a lookup result is trusted; a miss is retried sooner as the prompt may get sent. */
const resolvedTtl = 30_000;
const unresolvedTtl = 2_000;
/** Thumbnails are this many rows tall when the cells below are free, otherwise one row. */
const thumbnailRows = 2;
const thumbnailMaxAspect = 3;
/** Cells a thumbnail may cover: blanks and box-drawing borders. */
const freeCellsRegex = /^[\s\u2500-\u257f]*$/;

interface IImageReference {
	/** `#N` for a pasted image, `file:<path as printed>` for an image file path. */
	readonly key: string;
	/** Set for `[Image #N]`. */
	readonly index?: number;
	/** Set for an image file path, exactly as printed. */
	readonly path?: string;
	/** Absolute buffer line. */
	readonly line: number;
	readonly startColumn: number;
	/** Exclusive. */
	readonly endColumn: number;
}

interface IResolvedImage {
	readonly path: string | undefined;
	readonly time: number;
}

interface IHitBox {
	readonly element: HTMLElement;
	reference: IImageReference;
}

interface IThumbnail {
	readonly image: HTMLImageElement;
	readonly badge: HTMLElement;
}

interface IThumbnailPlacement {
	readonly row: number;
	readonly column: number;
	readonly rowsTall: number;
	readonly columns: number;
}

/**
 * Previews for the images Claude Code shows: `[Image #N]` references and image file paths (for
 * example a `Read(…/burger.jpg)` line). Claude's fullscreen TUI tracks the
 * mouse and repaints constantly, which tears down xterm's link hovers and swallows clicks, so this
 * draws its own layer above the terminal: a hit box over each reference (hover shows the image,
 * cmd/ctrl+click opens it) and one numbered thumbnail per image right above or below its
 * reference. Both are DOM
 * elements outside xterm's cells, so repaints only move them.
 */
class TerminalClaudeImagesContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.maut.claudeImages';

	/** Keyed by image number and occurrence, so a box follows its text as the transcript moves. */
	private readonly _hitBoxStores = this._register(new DisposableMap<string, DisposableStore>());
	private readonly _hitBoxes = new Map<string, IHitBox>();
	private readonly _thumbnailStores = this._register(new DisposableMap<string, DisposableStore>());
	private readonly _thumbnails = new Map<string, IThumbnail>();
	private readonly _resolved = new Map<string, IResolvedImage>();
	private readonly _pending = new Set<string>();
	private readonly _scheduledUpdate = this._register(new MutableDisposable());
	private _overlay: HTMLElement | undefined;
	private _xterm: RawXtermTerminal | undefined;
	private _cell: IBufferCell | undefined;
	/** Highest image number seen; anything above it that shows up is a fresh paste. */
	private _highestIndex: number | undefined;

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	xtermOpen(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		// xterm doesn't expose its screen element; the overlay must live inside it to share its coordinates.
		// eslint-disable-next-line no-restricted-syntax
		const screen = xterm.raw.element?.querySelector<HTMLElement>('.xterm-screen');
		if (!screen) {
			return;
		}
		this._xterm = xterm.raw;
		this._overlay = dom.append(screen, dom.$('.maut-claude-images'));
		this._register(toDisposable(() => this._overlay?.remove()));
		this._register(xterm.raw.onRender(() => this._scheduleUpdate()));
		this._register(xterm.raw.onScroll(() => this._scheduleUpdate()));
		this._register(xterm.raw.onResize(() => this._scheduleUpdate()));
		this._scheduleUpdate();
	}

	private _scheduleUpdate(): void {
		if (this._scheduledUpdate.value || !this._overlay) {
			return;
		}
		this._scheduledUpdate.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(this._overlay), () => {
			this._scheduledUpdate.clear();
			this._update();
		});
	}

	private _update(): void {
		const xterm = this._xterm;
		if (!xterm || !this._overlay) {
			return;
		}
		const cell = (xterm as RawXtermTerminal & { _core: IXtermCore })._core._renderService.dimensions.css.cell;
		if (!cell.width || !cell.height) {
			return;
		}
		const viewportY = xterm.buffer.active.viewportY;
		const references = this._findReferences(xterm);
		this._captureNewPastes(xterm, references);

		const occurrences = new Map<string, number>();
		const liveHitBoxes = new Set<string>();
		for (const reference of references) {
			const occurrence = occurrences.get(reference.key) ?? 0;
			occurrences.set(reference.key, occurrence + 1);
			const key = `${reference.key}:${occurrence}`;
			liveHitBoxes.add(key);
			const hitBox = this._hitBoxes.get(key) ?? this._createHitBox(key, reference);
			hitBox.reference = reference;
			const style = hitBox.element.style;
			style.left = `${reference.startColumn * cell.width}px`;
			style.top = `${(reference.line - viewportY) * cell.height}px`;
			style.width = `${(reference.endColumn - reference.startColumn) * cell.width}px`;
			style.height = `${cell.height}px`;
		}
		for (const key of [...this._hitBoxes.keys()]) {
			if (!liveHitBoxes.has(key)) {
				this._hitBoxes.delete(key);
				this._hitBoxStores.deleteAndDispose(key);
			}
		}

		// One thumbnail per image, on free cells right above or below its first reference so it is
		// clear which image it shows even when references sit side by side.
		const occupied: IThumbnailPlacement[] = [];
		const liveThumbnails = new Set<string>();
		for (const reference of references) {
			if (liveThumbnails.has(reference.key)) {
				continue;
			}
			const path = this._getImagePath(reference);
			if (!path) {
				continue;
			}
			const thumbnail = this._thumbnails.get(reference.key) ?? this._createThumbnail(reference);
			const { image, badge } = thumbnail;
			const src = FileAccess.uriToBrowserUri(URI.file(path)).toString(true);
			if (image.getAttribute('src') !== src) {
				image.src = src;
			}
			const aspect = image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1.6;
			const placement = this._placeThumbnail(xterm, reference, reference.line - viewportY, aspect, cell, occupied);
			if (!placement) {
				image.style.display = badge.style.display = 'none';
				continue;
			}
			liveThumbnails.add(reference.key);
			occupied.push(placement);
			image.style.left = `${placement.column * cell.width}px`;
			image.style.top = `${placement.row * cell.height}px`;
			image.style.height = `${placement.rowsTall * cell.height}px`;
			image.style.width = `${placement.columns * cell.width}px`;
			badge.style.left = image.style.left;
			badge.style.top = image.style.top;
			image.style.display = '';
			badge.style.display = reference.index === undefined ? 'none' : '';
		}
		for (const key of [...this._thumbnails.keys()]) {
			if (!liveThumbnails.has(key) && !references.some(r => r.key === key)) {
				this._thumbnails.delete(key);
				this._thumbnailStores.deleteAndDispose(key);
			}
		}
	}

	/**
	 * Find free cells for a thumbnail, preferring right above the reference, then right below it,
	 * two rows tall before one. Blank cells and box-drawing borders (the lines around Claude's
	 * prompt) count as free; text is never covered.
	 */
	private _placeThumbnail(xterm: RawXtermTerminal, reference: IImageReference, row: number, aspect: number, cell: { width: number; height: number }, occupied: IThumbnailPlacement[]): IThumbnailPlacement | undefined {
		const referenceColumns = reference.endColumn - reference.startColumn;
		for (const rowsTall of [thumbnailRows, 1]) {
			const height = rowsTall * cell.height;
			const columns = Math.min(referenceColumns, Math.ceil(Math.min(height * aspect, height * thumbnailMaxAspect) / cell.width));
			for (const top of [row - rowsTall, row + 1]) {
				const placement: IThumbnailPlacement = { row: top, column: reference.startColumn, rowsTall, columns };
				if (this._isFree(xterm, placement, occupied)) {
					return placement;
				}
			}
		}
		return undefined;
	}

	private _isFree(xterm: RawXtermTerminal, placement: IThumbnailPlacement, occupied: IThumbnailPlacement[]): boolean {
		const { row, column, rowsTall, columns } = placement;
		if (row < 0 || row + rowsTall > xterm.rows || column + columns > xterm.cols) {
			return false;
		}
		const overlaps = occupied.some(o => o.row < row + rowsTall && row < o.row + o.rowsTall && o.column < column + columns && column < o.column + o.columns);
		if (overlaps) {
			return false;
		}
		const buffer = xterm.buffer.active;
		for (let r = row; r < row + rowsTall; r++) {
			const text = buffer.getLine(buffer.viewportY + r)?.translateToString(false, column, column + columns) ?? '';
			if (!freeCellsRegex.test(text)) {
				return false;
			}
		}
		return true;
	}

	/**
	 * A new `[Image #N]` at the prompt means Claude just read that image from the clipboard and
	 * holds it only in memory; snapshot the clipboard now so the unsent image can be previewed.
	 */
	private _captureNewPastes(xterm: RawXtermTerminal, references: IImageReference[]): void {
		const pasted = references.filter(r => r.index !== undefined);
		const highest = Math.max(this._highestIndex ?? 0, ...pasted.map(r => r.index!));
		if (this._highestIndex === undefined) {
			// What's on screen when we start watching was pasted earlier, maybe in another session.
			this._highestIndex = highest;
			return;
		}
		const cursorLine = xterm.buffer.active.baseY + xterm.buffer.active.cursorY;
		for (const reference of pasted) {
			if (reference.index! > this._highestIndex && Math.abs(reference.line - cursorLine) <= 4) {
				this._capture(reference);
			}
		}
		this._highestIndex = highest;
	}

	private async _capture(reference: IImageReference): Promise<void> {
		this._pending.add(reference.key);
		let path: string | undefined;
		try {
			path = await this._commandService.executeCommand<string | undefined>(captureClipboardCommandId, this._ctx.instance.processId, reference.index);
		} catch {
			// The extension isn't running (yet); the normal lookup takes over after sending.
		} finally {
			this._pending.delete(reference.key);
		}
		this._resolved.set(reference.key, { path, time: Date.now() });
		this._scheduleUpdate();
	}

	private _findReferences(xterm: RawXtermTerminal): IImageReference[] {
		const buffer = xterm.buffer.active;
		const references: IImageReference[] = [];
		for (let row = 0; row < xterm.rows; row++) {
			const lineIndex = buffer.viewportY + row;
			const line = buffer.getLine(lineIndex);
			// Cheap check first; mapping string offsets to columns walks every cell.
			const plain = line?.translateToString(true);
			if (!line || !plain || (!plain.includes('[Image #') && !imageExtensionRegex.test(plain))) {
				continue;
			}
			let text = '';
			const columns: number[] = [];
			for (let x = 0; x < line.length; x++) {
				this._cell = line.getCell(x, this._cell);
				if (!this._cell || this._cell.getWidth() === 0) {
					continue;
				}
				const chars = this._cell.getChars() || ' ';
				for (let i = 0; i < chars.length; i++) {
					columns.push(x);
				}
				text += chars;
			}
			for (const match of text.matchAll(imageReferenceRegex)) {
				const start = match.index;
				const end = start + match[0].length - 1;
				const index = Number(match.groups?.index);
				references.push({ key: `#${index}`, index, line: lineIndex, startColumn: columns[start], endColumn: columns[end] + 1 });
			}
			for (const match of text.matchAll(imagePathRegex)) {
				const path = match.groups!.path;
				const start = match.index + match[0].indexOf(path);
				const end = start + path.length - 1;
				references.push({ key: `file:${path}`, path, line: lineIndex, startColumn: columns[start], endColumn: columns[end] + 1 });
			}
		}
		return references;
	}

	private _createHitBox(key: string, reference: IImageReference): IHitBox {
		const store = new DisposableStore();
		const element = dom.append(this._overlay!, dom.$('.maut-claude-image-hit'));
		store.add(toDisposable(() => element.remove()));
		const hitBox: IHitBox = { element, reference };
		this._wireInteractions(store, element, () => hitBox.reference, false);
		this._hitBoxStores.set(key, store);
		this._hitBoxes.set(key, hitBox);
		return hitBox;
	}

	private _createThumbnail(reference: IImageReference): IThumbnail {
		const store = new DisposableStore();
		const image = dom.append(this._overlay!, dom.$<HTMLImageElement>('img.maut-claude-image-thumbnail'));
		image.alt = '';
		image.draggable = false;
		const badge = dom.append(this._overlay!, dom.$('span.maut-claude-image-badge'));
		badge.textContent = reference.index === undefined ? '' : `#${reference.index}`;
		store.add(toDisposable(() => {
			image.remove();
			badge.remove();
		}));
		// Width depends on the image's aspect ratio, known once it loads.
		store.add(dom.addDisposableListener(image, 'load', () => this._scheduleUpdate()));
		this._wireInteractions(store, image, () => reference, true);
		const thumbnail: IThumbnail = { image, badge };
		this._thumbnailStores.set(reference.key, store);
		this._thumbnails.set(reference.key, thumbnail);
		return thumbnail;
	}

	private _wireInteractions(store: DisposableStore, element: HTMLElement, getReference: () => IImageReference, isThumbnail: boolean): void {
		// Keep pointer events away from xterm: in fullscreen TUI they would go to Claude, which
		// repaints, and xterm's own link hover would stack on ours.
		for (const type of [dom.EventType.MOUSE_DOWN, dom.EventType.MOUSE_UP, dom.EventType.MOUSE_MOVE, dom.EventType.CLICK, dom.EventType.DBLCLICK]) {
			store.add(dom.addDisposableListener(element, type, e => e.stopPropagation()));
		}
		store.add(dom.addDisposableListener(element, dom.EventType.CLICK, e => {
			if (isThumbnail || this._isOpenModifierDown(e)) {
				e.preventDefault();
				this._open(getReference());
			}
		}));
		store.add(this._hoverService.setupDelayedHover(element, () => ({
			content: this._createHoverContent(getReference()),
			additionalClasses: ['xterm-hover'],
		})));
	}

	private _getImagePath(reference: IImageReference): string | undefined {
		const resolved = this._resolved.get(reference.key);
		const age = resolved ? Date.now() - resolved.time : Infinity;
		if (age > (resolved?.path ? resolvedTtl : unresolvedTtl)) {
			this._resolve(reference);
		}
		return resolved?.path;
	}

	private async _resolve(reference: IImageReference): Promise<void> {
		if (this._pending.has(reference.key)) {
			return;
		}
		this._pending.add(reference.key);
		let path: string | undefined;
		try {
			path = reference.path !== undefined
				? await this._resolveFilePath(reference.path)
				: await this._commandService.executeCommand<string | undefined>(resolveImageCommandId, this._ctx.instance.processId, reference.index);
		} catch {
			// The extension isn't running (yet), or the file can't be read; retry later.
		} finally {
			this._pending.delete(reference.key);
		}
		const previous = this._resolved.get(reference.key);
		this._resolved.set(reference.key, { path, time: Date.now() });
		if (previous?.path !== path) {
			this._scheduleUpdate();
		}
	}

	/**
	 * An image path as Claude printed it: absolute, `~/`-relative, or relative to the terminal's
	 * current folder or a workspace folder. Only a file that exists counts.
	 */
	private async _resolveFilePath(printed: string): Promise<string | undefined> {
		const candidates: URI[] = [];
		if (printed.startsWith('/')) {
			candidates.push(URI.file(printed));
		} else if (printed.startsWith('~/')) {
			candidates.push(URI.joinPath(await this._pathService.userHome({ preferLocal: true }), printed.slice(2)));
		} else {
			const cwd = await this._ctx.instance.getCwdResource();
			if (cwd) {
				candidates.push(URI.joinPath(cwd, printed));
			}
			for (const folder of this._workspaceContextService.getWorkspace().folders) {
				candidates.push(URI.joinPath(folder.uri, printed));
			}
		}
		for (const candidate of candidates) {
			if (candidate.scheme === 'file' && await this._fileService.exists(candidate)) {
				return candidate.fsPath;
			}
		}
		return undefined;
	}

	private _createHoverContent(reference: IImageReference): HTMLElement | string {
		const path = this._resolved.get(reference.key)?.path;
		const modifier = this._getOpenModifierLabel();
		if (!path) {
			this._resolve(reference);
			return reference.index === undefined
				? localize('maut.claudeImage.missingFile', "{0} wasn't found.", reference.path)
				: localize('maut.claudeImage.notSaved', "Image #{0} isn't saved yet. Claude Code stores it once the prompt is sent.", reference.index);
		}
		const container = dom.$('.maut-claude-image-hover');
		const image = dom.append(container, dom.$<HTMLImageElement>('img'));
		image.src = FileAccess.uriToBrowserUri(URI.file(path)).toString(true);
		image.alt = reference.index === undefined ? basename(path) : localize('maut.claudeImage.alt', "Image #{0}", reference.index);
		const caption = dom.append(container, dom.$('.maut-claude-image-caption'));
		if (reference.index === undefined) {
			caption.textContent = localize('maut.claudeImage.fileCaption', "{0} · {1} to open", basename(path), modifier);
		} else if (isUnsentSnapshot(path)) {
			caption.textContent = localize('maut.claudeImage.unsentCaption', "Image #{0} · not sent yet · {1} to open", reference.index, modifier);
		} else {
			caption.textContent = localize('maut.claudeImage.caption', "Image #{0} · {1} · {2} to open", reference.index, basename(path), modifier);
		}
		return container;
	}

	private _open(reference: IImageReference): void {
		const path = this._resolved.get(reference.key)?.path;
		if (path) {
			// A preview (temporary) tab: the next image opened replaces it instead of piling up.
			this._editorService.openEditor({ resource: URI.file(path), options: { pinned: false } });
		}
	}

	private _isOpenModifierDown(event: MouseEvent): boolean {
		if (this._configurationService.getValue<'ctrlCmd' | 'alt'>('editor.multiCursorModifier') === 'ctrlCmd') {
			return event.altKey;
		}
		return isMacintosh ? event.metaKey : event.ctrlKey;
	}

	private _getOpenModifierLabel(): string {
		if (this._configurationService.getValue<'ctrlCmd' | 'alt'>('editor.multiCursorModifier') === 'ctrlCmd') {
			return isMacintosh ? localize('maut.claudeImage.optionClick', "option + click") : localize('maut.claudeImage.altClick', "alt + click");
		}
		return isMacintosh ? localize('maut.claudeImage.cmdClick', "cmd + click") : localize('maut.claudeImage.ctrlClick', "ctrl + click");
	}
}

/** Clipboard snapshots of unsent images live in an `unsent` folder of the extension's cache. */
function isUnsentSnapshot(path: string): boolean {
	return /[\\/]unsent[\\/]\d+\.png$/.test(path);
}

registerTerminalContribution(TerminalClaudeImagesContribution.ID, TerminalClaudeImagesContribution);
