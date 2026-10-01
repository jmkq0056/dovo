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
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
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
/** How long a lookup result is trusted; a miss is retried sooner as the prompt may get sent. */
const resolvedTtl = 30_000;
const unresolvedTtl = 2_000;
/** Thumbnails are this many rows tall when the cells below are free, otherwise one row. */
const thumbnailRows = 2;
const thumbnailMaxAspect = 3;
/** Cells a thumbnail may cover: blanks and box-drawing borders. */
const freeCellsRegex = /^[\s\u2500-\u257f]*$/;

interface IImageReference {
	readonly index: number;
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
 * Previews for the `[Image #N]` references Claude Code prints. Claude's fullscreen TUI tracks the
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
	private readonly _thumbnailStores = this._register(new DisposableMap<number, DisposableStore>());
	private readonly _thumbnails = new Map<number, IThumbnail>();
	private readonly _resolved = new Map<number, IResolvedImage>();
	private readonly _pending = new Set<number>();
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

		const occurrences = new Map<number, number>();
		const liveHitBoxes = new Set<string>();
		for (const reference of references) {
			const occurrence = occurrences.get(reference.index) ?? 0;
			occurrences.set(reference.index, occurrence + 1);
			const key = `${reference.index}:${occurrence}`;
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
		const liveThumbnails = new Set<number>();
		for (const reference of references) {
			if (liveThumbnails.has(reference.index)) {
				continue;
			}
			const path = this._getImagePath(reference.index);
			if (!path) {
				continue;
			}
			const thumbnail = this._thumbnails.get(reference.index) ?? this._createThumbnail(reference.index);
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
			liveThumbnails.add(reference.index);
			occupied.push(placement);
			image.style.left = `${placement.column * cell.width}px`;
			image.style.top = `${placement.row * cell.height}px`;
			image.style.height = `${placement.rowsTall * cell.height}px`;
			image.style.width = `${placement.columns * cell.width}px`;
			badge.style.left = image.style.left;
			badge.style.top = image.style.top;
			image.style.display = badge.style.display = '';
		}
		for (const index of [...this._thumbnails.keys()]) {
			if (!liveThumbnails.has(index) && !references.some(r => r.index === index)) {
				this._thumbnails.delete(index);
				this._thumbnailStores.deleteAndDispose(index);
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
		const highest = Math.max(this._highestIndex ?? 0, ...references.map(r => r.index));
		if (this._highestIndex === undefined) {
			// What's on screen when we start watching was pasted earlier, maybe in another session.
			this._highestIndex = highest;
			return;
		}
		const cursorLine = xterm.buffer.active.baseY + xterm.buffer.active.cursorY;
		for (const reference of references) {
			if (reference.index > this._highestIndex && Math.abs(reference.line - cursorLine) <= 4) {
				this._capture(reference.index);
			}
		}
		this._highestIndex = highest;
	}

	private async _capture(index: number): Promise<void> {
		this._pending.add(index);
		let path: string | undefined;
		try {
			path = await this._commandService.executeCommand<string | undefined>(captureClipboardCommandId, this._ctx.instance.processId, index);
		} catch {
			// The extension isn't running (yet); the normal lookup takes over after sending.
		} finally {
			this._pending.delete(index);
		}
		this._resolved.set(index, { path, time: Date.now() });
		this._scheduleUpdate();
	}

	private _findReferences(xterm: RawXtermTerminal): IImageReference[] {
		const buffer = xterm.buffer.active;
		const references: IImageReference[] = [];
		for (let row = 0; row < xterm.rows; row++) {
			const lineIndex = buffer.viewportY + row;
			const line = buffer.getLine(lineIndex);
			// Cheap check first; mapping string offsets to columns walks every cell.
			if (!line || !line.translateToString(true).includes('[Image #')) {
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
				references.push({
					index: Number(match.groups?.index),
					line: lineIndex,
					startColumn: columns[start],
					endColumn: columns[end] + 1,
				});
			}
		}
		return references;
	}

	private _createHitBox(key: string, reference: IImageReference): IHitBox {
		const store = new DisposableStore();
		const element = dom.append(this._overlay!, dom.$('.maut-claude-image-hit'));
		store.add(toDisposable(() => element.remove()));
		const hitBox: IHitBox = { element, reference };
		this._wireInteractions(store, element, () => hitBox.reference.index, false);
		this._hitBoxStores.set(key, store);
		this._hitBoxes.set(key, hitBox);
		return hitBox;
	}

	private _createThumbnail(index: number): IThumbnail {
		const store = new DisposableStore();
		const image = dom.append(this._overlay!, dom.$<HTMLImageElement>('img.maut-claude-image-thumbnail'));
		image.alt = '';
		image.draggable = false;
		const badge = dom.append(this._overlay!, dom.$('span.maut-claude-image-badge'));
		badge.textContent = `#${index}`;
		store.add(toDisposable(() => {
			image.remove();
			badge.remove();
		}));
		// Width depends on the image's aspect ratio, known once it loads.
		store.add(dom.addDisposableListener(image, 'load', () => this._scheduleUpdate()));
		this._wireInteractions(store, image, () => index, true);
		const thumbnail: IThumbnail = { image, badge };
		this._thumbnailStores.set(index, store);
		this._thumbnails.set(index, thumbnail);
		return thumbnail;
	}

	private _wireInteractions(store: DisposableStore, element: HTMLElement, getIndex: () => number, isThumbnail: boolean): void {
		// Keep pointer events away from xterm: in fullscreen TUI they would go to Claude, which
		// repaints, and xterm's own link hover would stack on ours.
		for (const type of [dom.EventType.MOUSE_DOWN, dom.EventType.MOUSE_UP, dom.EventType.MOUSE_MOVE, dom.EventType.CLICK, dom.EventType.DBLCLICK]) {
			store.add(dom.addDisposableListener(element, type, e => e.stopPropagation()));
		}
		store.add(dom.addDisposableListener(element, dom.EventType.CLICK, e => {
			if (isThumbnail || this._isOpenModifierDown(e)) {
				e.preventDefault();
				this._open(getIndex());
			}
		}));
		store.add(this._hoverService.setupDelayedHover(element, () => ({
			content: this._createHoverContent(getIndex()),
			additionalClasses: ['xterm-hover'],
		})));
	}

	private _getImagePath(index: number): string | undefined {
		const resolved = this._resolved.get(index);
		const age = resolved ? Date.now() - resolved.time : Infinity;
		if (age > (resolved?.path ? resolvedTtl : unresolvedTtl)) {
			this._resolve(index);
		}
		return resolved?.path;
	}

	private async _resolve(index: number): Promise<void> {
		if (this._pending.has(index)) {
			return;
		}
		this._pending.add(index);
		let path: string | undefined;
		try {
			path = await this._commandService.executeCommand<string | undefined>(resolveImageCommandId, this._ctx.instance.processId, index);
		} catch {
			// The extension isn't running (yet); treat as not found and retry later.
		} finally {
			this._pending.delete(index);
		}
		const previous = this._resolved.get(index);
		this._resolved.set(index, { path, time: Date.now() });
		if (previous?.path !== path) {
			this._scheduleUpdate();
		}
	}

	private _createHoverContent(index: number): HTMLElement | string {
		const path = this._resolved.get(index)?.path;
		if (!path) {
			this._resolve(index);
			return localize('maut.claudeImage.notSaved', "Image #{0} isn't saved yet. Claude Code stores it once the prompt is sent.", index);
		}
		const container = dom.$('.maut-claude-image-hover');
		const image = dom.append(container, dom.$<HTMLImageElement>('img'));
		image.src = FileAccess.uriToBrowserUri(URI.file(path)).toString(true);
		image.alt = localize('maut.claudeImage.alt', "Image #{0}", index);
		const caption = dom.append(container, dom.$('.maut-claude-image-caption'));
		caption.textContent = isUnsentSnapshot(path)
			? localize('maut.claudeImage.unsentCaption', "Image #{0} · not sent yet · {1} to open", index, this._getOpenModifierLabel())
			: localize('maut.claudeImage.caption', "Image #{0} · {1} · {2} to open", index, basename(path), this._getOpenModifierLabel());
		return container;
	}

	private _open(index: number): void {
		const path = this._resolved.get(index)?.path;
		if (path) {
			this._editorService.openEditor({ resource: URI.file(path), options: { pinned: true } });
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
