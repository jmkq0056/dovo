/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { timeout } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition, OverlayWidgetPositionPreference } from '../../../../editor/browser/editorBrowser.js';
import { applyFontInfo } from '../../../../editor/browser/config/domFontInfo.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { ScrollType } from '../../../../editor/common/editorCommon.js';
import { Range } from '../../../../editor/common/core/range.js';
import { linesDiffComputers } from '../../../../editor/common/diff/linesDiffComputers.js';
import { MinimapPosition, OverviewRulerLane } from '../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ITextFileEditorModel, ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IMautClaudeService } from '../../terminal/browser/mautClaude.js';
import './media/mautChangeHighlight.css';

/** Contributed by the built-in `maut-claude-images` extension: a file as it is in the last commit. */
const gitOriginalCommandId = '_maut.git.original';
const maxRemovedLinesShown = 12;
const maxChanges = 300;

/** One changed place: the new lines (empty for a pure deletion) and the lines that were there. */
interface IChange {
	/** First changed line in the file now. */
	readonly line: number;
	/** How many lines are new or changed (0: something was only removed here). */
	readonly count: number;
	readonly removed: readonly string[];
}

interface IChangeSet {
	readonly changes: readonly IChange[];
	/** Changed live on disk (by Claude, usually) rather than compared with the last commit. */
	readonly live: boolean;
	readonly byClaude: boolean;
}

const addedLine = ModelDecorationOptions.register({
	description: 'maut-change-added',
	isWholeLine: true,
	className: 'maut-change-line',
	linesDecorationsClassName: 'maut-change-gutter',
	overviewRuler: { color: 'rgba(116, 211, 148, 0.9)', position: OverviewRulerLane.Full },
	minimap: { color: 'rgba(116, 211, 148, 0.85)', position: MinimapPosition.Gutter },
});

const removedMarker = ModelDecorationOptions.register({
	description: 'maut-change-removed-marker',
	isWholeLine: true,
	linesDecorationsClassName: 'maut-change-gutter-removed',
	overviewRuler: { color: 'rgba(232, 70, 95, 0.9)', position: OverviewRulerLane.Full },
	minimap: { color: 'rgba(232, 70, 95, 0.85)', position: MinimapPosition.Gutter },
});

/**
 * Shows what changed in a file the way Claude does: new and changed lines highlighted, removed
 * lines inline in red, and the editor scrolled to the change. Live, when a file you have open
 * changes on disk (Claude editing it); and when you open a file with uncommitted changes, against
 * its last commit. A small bar steps through the changes; Done clears them.
 */
class MautChangeHighlight extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.mautcode.changeHighlight';

	/** Each file's text as last seen, so a change on disk can be compared with what was there. */
	private readonly _snapshots = new Map<string, string>();
	private readonly _changes = new Map<string, IChangeSet>();
	/** Files already compared with their last commit. */
	private readonly _checked = new Set<string>();
	private readonly _editors = this._register(new DisposableMap<ICodeEditor, EditorChanges>());
	private readonly _editorListeners = this._register(new DisposableMap<ICodeEditor, DisposableStore>());

	constructor(
		@ITextFileService textFileService: ITextFileService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@ICommandService private readonly _commandService: ICommandService,
		@IMautClaudeService private readonly _claudeService: IMautClaudeService,
	) {
		super();
		this._register(textFileService.files.onDidResolve(e => this._onResolve(e.model)));
		this._register(textFileService.files.onDidSave(e => this._remember(e.model)));
		for (const editor of this._codeEditorService.listCodeEditors()) {
			this._watch(editor);
		}
		this._register(this._codeEditorService.onCodeEditorAdd(editor => this._watch(editor)));
		this._register(this._codeEditorService.onCodeEditorRemove(editor => {
			this._editors.deleteAndDispose(editor);
			this._editorListeners.deleteAndDispose(editor);
		}));
	}

	private _remember(model: ITextFileEditorModel): void {
		const text = model.textEditorModel?.getValue();
		if (text !== undefined) {
			this._snapshots.set(model.resource.toString(), text);
		}
	}

	private async _onResolve(model: ITextFileEditorModel): Promise<void> {
		const text = model.textEditorModel?.getValue();
		if (text === undefined || model.resource.scheme !== Schemas.file) {
			return;
		}
		const key = model.resource.toString();
		const before = this._snapshots.get(key);
		this._snapshots.set(key, text);
		if (before !== undefined) {
			if (before !== text) {
				// Changed on disk while open: show exactly what this edit changed, and go there.
				this._show(key, { changes: diff(before, text), live: true, byClaude: this._claudeService.hasClaude }, true);
			}
			return;
		}
		await this._compareWithCommit(model.resource, text);
	}

	/** The first time a file shows: what's different from its last commit, if anything. */
	private async _compareWithCommit(resource: URI, text: string): Promise<void> {
		const key = resource.toString();
		if (this._checked.has(key)) {
			return;
		}
		this._checked.add(key);
		let original: string | undefined;
		// The extension that reads git starts once the window is up: until then, try again shortly.
		for (let attempt = 0; attempt < 8; attempt++) {
			try {
				original = await this._commandService.executeCommand<string | undefined>(gitOriginalCommandId, resource.fsPath);
				break;
			} catch {
				await timeout(1000);
			}
		}
		if (original === undefined || original === text || this._changes.has(key) || this._snapshots.get(key) !== text) {
			return;
		}
		this._show(key, { changes: diff(original, text), live: false, byClaude: false }, true);
	}

	private _show(key: string, set: IChangeSet, reveal: boolean): void {
		if (!set.changes.length || set.changes.length > maxChanges) {
			this._changes.delete(key);
			return;
		}
		this._changes.set(key, set);
		for (const editor of this._codeEditorService.listCodeEditors()) {
			if (editor.getModel()?.uri.toString() === key) {
				this._apply(editor, reveal);
			}
		}
	}

	private _watch(editor: ICodeEditor): void {
		if (this._editorListeners.has(editor)) {
			return;
		}
		const store = new DisposableStore();
		store.add(editor.onDidChangeModel(() => this._apply(editor, true)));
		// Your own typing means you've moved on: the highlights step aside.
		store.add(editor.onDidChangeModelContent(e => {
			if (!e.isFlush && this._editors.has(editor) && editor.hasTextFocus()) {
				this._clear(editor.getModel()?.uri.toString());
			}
		}));
		this._editorListeners.set(editor, store);
		this._apply(editor, false);
	}

	private _apply(editor: ICodeEditor, reveal: boolean): void {
		this._editors.deleteAndDispose(editor);
		const model = editor.getModel();
		const key = model?.uri.toString();
		if (model && key && model.uri.scheme === Schemas.file) {
			// Already loaded before we were watching: remember it and compare it with its last commit.
			if (!this._snapshots.has(key)) {
				this._snapshots.set(key, model.getValue());
			}
			this._compareWithCommit(model.uri, model.getValue());
		}
		const set = key ? this._changes.get(key) : undefined;
		if (!set) {
			return;
		}
		this._editors.set(editor, new EditorChanges(editor, set, reveal, () => this._clear(key)));
	}

	private _clear(key: string | undefined): void {
		if (!key) {
			return;
		}
		this._changes.delete(key);
		for (const [editor] of [...this._editorListeners]) {
			if (editor.getModel()?.uri.toString() === key) {
				this._editors.deleteAndDispose(editor);
			}
		}
	}
}

/** The highlights, removed lines and change bar in one editor. */
class EditorChanges extends Disposable {

	private _index = -1;
	private readonly _counter: HTMLElement;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _set: IChangeSet,
		reveal: boolean,
		done: () => void,
	) {
		super();
		const model = _editor.getModel();
		if (!model) {
			this._counter = dom.$('span');
			return;
		}
		const lineCount = model.getLineCount();
		const decorations = _editor.createDecorationsCollection(_set.changes.map(change => {
			const start = Math.min(Math.max(1, change.line), lineCount);
			const end = Math.min(lineCount, change.count ? change.line + change.count - 1 : start);
			return { range: new Range(start, 1, end, 1), options: change.count ? addedLine : removedMarker };
		}));
		this._register(toDisposable(() => decorations.clear()));

		// Removed lines, shown in place, in red, like Claude's diff.
		const zones: string[] = [];
		_editor.changeViewZones(accessor => {
			for (const change of _set.changes) {
				if (!change.removed.length) {
					continue;
				}
				const shown = change.removed.slice(0, maxRemovedLinesShown);
				const node = dom.$('.maut-change-removed');
				// The editor's own font and line height, so removed lines sit exactly like real ones.
				applyFontInfo(node, _editor.getOption(EditorOption.fontInfo));
				const lineHeight = `${_editor.getOption(EditorOption.lineHeight)}px`;
				for (const line of shown) {
					const row = dom.append(node, dom.$('.maut-change-removed-line', undefined, line || ' '));
					row.style.height = row.style.lineHeight = lineHeight;
				}
				if (change.removed.length > shown.length) {
					dom.append(node, dom.$('.maut-change-removed-more', undefined, localize('maut.change.moreRemoved', "{0} more removed lines", change.removed.length - shown.length)));
				}
				zones.push(accessor.addZone({
					afterLineNumber: Math.min(Math.max(0, change.line - 1), lineCount),
					heightInLines: shown.length + (change.removed.length > shown.length ? 1 : 0),
					domNode: node,
				}));
			}
		});
		this._register(toDisposable(() => _editor.changeViewZones(accessor => zones.forEach(zone => accessor.removeZone(zone)))));

		// The bar: how many places changed, step through them, done.
		const bar = dom.$('.maut-change-bar');
		dom.append(bar, dom.$('span.maut-change-dot'));
		const places = _set.changes.length;
		const what = _set.live
			? (_set.byClaude
				? (places === 1 ? localize('maut.change.claudeOne', "Claude changed 1 place") : localize('maut.change.claudeMany', "Claude changed {0} places", places))
				: (places === 1 ? localize('maut.change.diskOne', "Changed on disk: 1 place") : localize('maut.change.diskMany', "Changed on disk: {0} places", places)))
			: (places === 1 ? localize('maut.change.commitOne', "1 change since the last commit") : localize('maut.change.commitMany', "{0} changes since the last commit", places));
		dom.append(bar, dom.$('span.maut-change-what', undefined, what));
		this._counter = dom.append(bar, dom.$('span.maut-change-counter'));
		const button = (label: string, title: string, run: () => void) => {
			const element = dom.append(bar, dom.$<HTMLButtonElement>('button', { type: 'button' }, label));
			element.title = title;
			this._register(dom.addDisposableListener(element, dom.EventType.CLICK, e => {
				e.preventDefault();
				run();
			}));
		};
		// allow-any-unicode-next-line
		button('↑', localize('maut.change.previous', "Previous change"), () => this._go(-1));
		// allow-any-unicode-next-line
		button('↓', localize('maut.change.next', "Next change"), () => this._go(1));
		button(localize('maut.change.done', "Done"), localize('maut.change.doneTitle', "Clear these highlights"), done);
		const widget: IOverlayWidget = {
			getId: () => 'maut.changeBar',
			getDomNode: () => bar,
			// Bottom right: at the top, sticky scroll (the function you're in) covers it as soon as you scroll.
			getPosition: (): IOverlayWidgetPosition => ({ preference: OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER }),
		};
		_editor.addOverlayWidget(widget);
		this._register(toDisposable(() => _editor.removeOverlayWidget(widget)));
		if (reveal) {
			this._go(1);
		} else {
			this._renderCounter();
		}
	}

	private _go(direction: 1 | -1): void {
		const count = this._set.changes.length;
		this._index = this._index < 0 ? 0 : (this._index + direction + count) % count;
		const change = this._set.changes[this._index];
		this._editor.revealLineInCenter(Math.max(1, change.line), ScrollType.Smooth);
		this._renderCounter();
	}

	private _renderCounter(): void {
		this._counter.textContent = this._index < 0 ? '' : `${this._index + 1}/${this._set.changes.length}`;
	}
}

/** What changed from `before` to `after`: each place with its new lines and the removed ones. */
function diff(before: string, after: string): IChange[] {
	const original = before.split(/\r?\n/);
	const modified = after.split(/\r?\n/);
	const result = linesDiffComputers.getDefault().computeDiff(original, modified, { ignoreTrimWhitespace: false, maxComputationTimeMs: 400, computeMoves: false });
	if (result.hitTimeout) {
		return [];
	}
	return result.changes.map(change => ({
		line: change.modified.startLineNumber,
		count: change.modified.endLineNumberExclusive - change.modified.startLineNumber,
		removed: original.slice(change.original.startLineNumber - 1, change.original.endLineNumberExclusive - 1),
	}));
}

registerWorkbenchContribution2(MautChangeHighlight.ID, MautChangeHighlight, WorkbenchPhase.AfterRestored);
