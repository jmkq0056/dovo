/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
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
	readonly view: MautClaudeView;

	isClaude(instance: ITerminalInstance): boolean;
	setClaude(instance: ITerminalInstance, running: boolean): void;
	requestLayoutMode(mode: MautClaudeLayoutMode): void;
	setLayoutMode(mode: MautClaudeLayoutMode): void;
	setView(view: MautClaudeView): void;
}

const viewStorageKey = 'maut.claude.view';

class MautClaudeService extends Disposable implements IMautClaudeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidRequestLayoutMode = this._register(new Emitter<MautClaudeLayoutMode>());
	readonly onDidRequestLayoutMode = this._onDidRequestLayoutMode.event;

	private readonly _running = new Set<ITerminalInstance>();
	private _layoutMode: MautClaudeLayoutMode = 'focus';
	private _view: MautClaudeView;

	constructor(@IStorageService private readonly _storageService: IStorageService) {
		super();
		this._view = this._storageService.get(viewStorageKey, StorageScope.PROFILE) === 'terminal' ? 'terminal' : 'reader';
	}

	get layoutMode(): MautClaudeLayoutMode { return this._layoutMode; }
	get view(): MautClaudeView { return this._view; }

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

	setView(view: MautClaudeView): void {
		if (view !== this._view) {
			this._view = view;
			this._storageService.store(viewStorageKey, view, StorageScope.PROFILE, StorageTarget.USER);
			this._onDidChange.fire();
		}
	}
}

registerSingleton(IMautClaudeService, MautClaudeService, InstantiationType.Delayed);
