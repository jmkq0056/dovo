/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalInstance } from './terminal.js';

export type MautClaudeLayoutMode = 'focus' | 'ide';
export type MautClaudeView = 'reader' | 'terminal';

export const IMautClaudeService = createDecorator<IMautClaudeService>('mautClaudeService');

/**
 * Which terminals are running Claude Code, and how Claude is shown: the layout (Focus: Claude has
 * the window; IDE: tree, files on top, Claude below) and the view (Reader: the conversation as a
 * chat over a live prompt strip; Terminal: the plain terminal).
 */
export interface IMautClaudeService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;
	/** Fired when the user picks a layout; the layout contribution applies it and calls {@link setLayoutMode}. */
	readonly onDidRequestLayoutMode: Event<MautClaudeLayoutMode>;

	readonly layoutMode: MautClaudeLayoutMode;
	/** Claude's group is hidden (the slim strip shows instead); Claude keeps running. */
	readonly hidden: boolean;
	/** Fired when the user asks to hide or show Claude; the layout contribution applies it. */
	readonly onDidRequestToggleHidden: Event<void>;
	/** True while any Claude in this window is working. */
	readonly working: boolean;
	/** True while a Claude runs in this window. */
	readonly hasClaude: boolean;
	/** True once the window's opening layout (Claude placed, parts restored) has stopped moving. */
	readonly layoutSettled: boolean;
	/** Fired once, when {@link layoutSettled} becomes true; the splash waits for it. */
	readonly onDidSettleLayout: Event<void>;

	isClaude(instance: ITerminalInstance): boolean;
	setClaude(instance: ITerminalInstance, running: boolean): void;
	requestLayoutMode(mode: MautClaudeLayoutMode): void;
	setLayoutMode(mode: MautClaudeLayoutMode): void;
	/** Reader or Terminal, chosen per terminal: switching one never changes another. New ones start in the Reader. */
	viewOf(instance: ITerminalInstance): MautClaudeView;
	setView(instance: ITerminalInstance, view: MautClaudeView): void;
	requestToggleHidden(): void;
	setHidden(hidden: boolean): void;
	setWorking(instance: ITerminalInstance, working: boolean): void;
	/** Called by the layout contribution when the opening layout has settled. */
	settleLayout(): void;
}

class MautClaudeService extends Disposable implements IMautClaudeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidRequestLayoutMode = this._register(new Emitter<MautClaudeLayoutMode>());
	readonly onDidRequestLayoutMode = this._onDidRequestLayoutMode.event;

	private readonly _onDidRequestToggleHidden = this._register(new Emitter<void>());
	readonly onDidRequestToggleHidden = this._onDidRequestToggleHidden.event;

	private readonly _onDidSettleLayout = this._register(new Emitter<void>());
	readonly onDidSettleLayout = this._onDidSettleLayout.event;
	private _layoutSettled = false;

	private readonly _running = new Set<ITerminalInstance>();
	private readonly _working = new Set<ITerminalInstance>();
	private _hidden = false;
	private _layoutMode: MautClaudeLayoutMode = 'focus';
	private readonly _views = new WeakMap<ITerminalInstance, MautClaudeView>();

	get layoutMode(): MautClaudeLayoutMode { return this._layoutMode; }
	get hidden(): boolean { return this._hidden; }
	get working(): boolean { return this._working.size > 0; }
	get hasClaude(): boolean { return this._running.size > 0; }
	get layoutSettled(): boolean { return this._layoutSettled; }

	settleLayout(): void {
		if (!this._layoutSettled) {
			this._layoutSettled = true;
			this._onDidSettleLayout.fire();
		}
	}

	isClaude(instance: ITerminalInstance): boolean {
		return this._running.has(instance);
	}

	setClaude(instance: ITerminalInstance, running: boolean): void {
		if (running === this._running.has(instance)) {
			return;
		}
		if (running) {
			this._running.add(instance);
		} else {
			this._running.delete(instance);
			this._working.delete(instance);
		}
		this._onDidChange.fire();
	}

	requestLayoutMode(mode: MautClaudeLayoutMode): void {
		this._onDidRequestLayoutMode.fire(mode);
	}

	setLayoutMode(mode: MautClaudeLayoutMode): void {
		if (mode !== this._layoutMode) {
			this._layoutMode = mode;
			this._onDidChange.fire();
		}
	}

	requestToggleHidden(): void {
		this._onDidRequestToggleHidden.fire();
	}

	setHidden(hidden: boolean): void {
		if (hidden !== this._hidden) {
			this._hidden = hidden;
			this._onDidChange.fire();
		}
	}

	setWorking(instance: ITerminalInstance, working: boolean): void {
		if (working === this._working.has(instance) || (working && !this._running.has(instance))) {
			return;
		}
		if (working) {
			this._working.add(instance);
		} else {
			this._working.delete(instance);
		}
		this._onDidChange.fire();
	}

	viewOf(instance: ITerminalInstance): MautClaudeView {
		return this._views.get(instance) ?? 'reader';
	}

	setView(instance: ITerminalInstance, view: MautClaudeView): void {
		if (view !== this.viewOf(instance)) {
			this._views.set(instance, view);
			this._onDidChange.fire();
		}
	}
}

registerSingleton(IMautClaudeService, MautClaudeService, InstantiationType.Delayed);
