/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ICommandDetectionCapability, TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { GroupDirection, GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IMautClaudeService, MautClaudeLayoutMode } from '../../../terminal/browser/mautClaude.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../terminal/browser/terminalEditorInput.js';

const enabledSetting = 'maut.claudeLayout.enabled';
const claudeCommandRegex = /^\s*(?:claude|clsp)(?:\s|$)/;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'maut.claudeLayout',
	title: localize('maut.claudeLayout.title', "Maut Claude layout"),
	type: 'object',
	properties: {
		[enabledSetting]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('maut.claudeLayout.enabled', "When Claude Code starts in a terminal, show it as the Claude pane and give it the whole window (Focus). Files you open appear beside it. Switch to IDE (`⌘B`, the Explorer icon or the pane's IDE button) for the tree, files on top and Claude below. Everything returns to normal when Claude exits."),
		},
	},
});

/** Layout to give back when the last Claude session ends. */
interface IRestoreState {
	readonly sidebarVisible: boolean;
	readonly panelVisible: boolean;
}

/**
 * Claude-first layout. When `claude` starts in a terminal, the terminal moves into the editor area
 * as its own locked group, where the terminal editor shows it as the Claude pane (header, Reader).
 * It stays there in both modes so the pane always looks the same:
 *
 * - **Focus**: side bar and panel hidden. With no files open Claude's group is maximized; with
 *   files open they sit to its right. Because the group is locked, a newly opened file always lands
 *   beside Claude, which also lifts the maximized state.
 * - **IDE**: side bar shown, the files group above and Claude below.
 *
 * Switching only rearranges editor groups, so the Claude process keeps running.
 */
class MautClaudeLayout extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.maut.claudeLayout';

	private readonly _watchers = this._register(new DisposableMap<ITerminalInstance, DisposableStore>());
	/** Terminals currently running Claude, in the order they started. */
	private readonly _sessions: ITerminalInstance[] = [];
	private _mode: MautClaudeLayoutMode = 'focus';
	private _restore: IRestoreState | undefined;
	/** Set while this class itself changes the layout, so it doesn't react to its own changes. */
	private _applying = 0;
	/**
	 * Until this time, side bar changes aren't taken as the user switching modes: right after a
	 * window opens the workbench is still restoring parts, which would otherwise flip Focus to IDE.
	 */
	private _settleUntil = 0;
	/** Groups this class created empty for the IDE layout, removed again when no longer needed. */
	private readonly _createdGroups = new Set<IEditorGroup>();

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IMautClaudeService private readonly _claudeService: IMautClaudeService,
	) {
		super();
		for (const instance of this._terminalService.instances) {
			this._watch(instance);
		}
		this._register(this._terminalService.onDidCreateInstance(instance => this._watch(instance)));
		this._register(this._claudeService.onDidRequestLayoutMode(mode => this._setMode(mode)));
		// allow-any-unicode-next-line
		// ⌘B and the Explorer icon toggle the side bar; with Claude running that means Focus ⇄ IDE.
		this._register(this._layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.SIDEBAR_PART && !this._applying && this._sessions.length && Date.now() > this._settleUntil) {
				this._setMode(e.visible ? 'ide' : 'focus');
			}
		}));
	}

	private _watch(instance: ITerminalInstance): void {
		if (this._watchers.has(instance)) {
			return;
		}
		const store = new DisposableStore();
		const attach = (detection: ICommandDetectionCapability) => {
			store.add(detection.onCommandExecuted(command => {
				if (claudeCommandRegex.test(command.command)) {
					this._start(instance);
				}
			}));
			store.add(detection.onCommandFinished(command => {
				if (claudeCommandRegex.test(command.command)) {
					this._end(instance);
				}
			}));
		};
		const detection = instance.capabilities.get(TerminalCapability.CommandDetection);
		if (detection) {
			attach(detection);
		}
		store.add(instance.capabilities.onDidAddCommandDetectionCapability(attach));
		store.add(instance.onDisposed(() => {
			this._watchers.deleteAndDispose(instance);
			this._end(instance);
		}));
		this._watchers.set(instance, store);
	}

	private async _start(instance: ITerminalInstance): Promise<void> {
		if (this._sessions.includes(instance) || !this._configurationService.getValue<boolean>(enabledSetting)) {
			return;
		}
		if (!this._sessions.length) {
			this._restore = {
				sidebarVisible: this._layoutService.isVisible(Parts.SIDEBAR_PART),
				panelVisible: this._layoutService.isVisible(Parts.PANEL_PART),
			};
			this._mode = 'focus';
			this._claudeService.setLayoutMode('focus');
		}
		this._sessions.push(instance);
		this._claudeService.setClaude(instance, true);
		const group = await this._placeInEditorArea(instance);
		if (group && this._sessions.includes(instance)) {
			await this._arrange();
			instance.focus();
		}
	}

	private async _end(instance: ITerminalInstance): Promise<void> {
		const index = this._sessions.indexOf(instance);
		if (index === -1) {
			return;
		}
		this._sessions.splice(index, 1);
		this._claudeService.setClaude(instance, false);
		await this._applying$(async () => {
			const group = this._groupOf(instance);
			if (group) {
				this._unmaximize(group);
				group.lock(false);
			}
			if (!instance.isDisposed && instance.target === TerminalLocation.Editor) {
				await this._terminalService.moveToTerminalView(instance);
			}
			if (this._sessions.length) {
				return;
			}
			// Last Claude ended: give the user their layout back.
			this._removeCreatedGroups();
			const restore = this._restore;
			this._restore = undefined;
			this._layoutService.setPartHidden(false, Parts.PANEL_PART);
			this._layoutService.setPartHidden(!restore?.sidebarVisible, Parts.SIDEBAR_PART);
		});
		if (!instance.isDisposed && !this._sessions.length) {
			instance.focus();
		}
	}

	private async _setMode(mode: MautClaudeLayoutMode): Promise<void> {
		if (!this._sessions.length) {
			return;
		}
		this._mode = mode;
		this._claudeService.setLayoutMode(mode);
		await this._arrange();
		this._sessions.at(-1)?.focus();
	}

	/** Arrange groups and parts for the current mode around the Claude group. */
	private async _arrange(): Promise<void> {
		const claude = this._claudeGroup();
		if (!claude) {
			return;
		}
		this._settleUntil = Date.now() + 1500;
		await this._applying$(async () => {
			claude.lock(true);
			this._layoutService.setPartHidden(true, Parts.PANEL_PART);
			const others = this._otherGroups(claude);
			if (this._mode === 'ide') {
				this._layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
				this._unmaximize(claude);
				let files = others.find(group => !group.isEmpty) ?? others[0];
				if (!files) {
					files = this._editorGroupsService.addGroup(claude, GroupDirection.UP);
					this._createdGroups.add(files);
				} else {
					this._editorGroupsService.moveGroup(claude, files, GroupDirection.DOWN);
				}
			} else {
				this._layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
				this._removeCreatedGroups();
				const files = this._otherGroups(claude).find(group => !group.isEmpty);
				if (files) {
					// Files open: Claude on the left, files on the right.
					this._unmaximize(claude);
					this._editorGroupsService.moveGroup(claude, files, GroupDirection.LEFT);
				} else if (this._editorGroupsService.count > 1 && !this._editorGroupsService.getPart(claude).hasMaximizedGroup()) {
					this._editorGroupsService.toggleMaximizeGroup(claude);
				}
			}
			// Moving a group can recreate it; make sure the Claude group stays locked.
			this._claudeGroup()?.lock(true);
		});
	}

	/** Move Claude's terminal into the editor area, in the Claude group or a fresh group of its own. */
	private async _placeInEditorArea(instance: ITerminalInstance): Promise<IEditorGroup | undefined> {
		this._removeStaleClaudeGroups();
		if (instance.target !== TerminalLocation.Editor) {
			const existing = this._claudeGroup(instance);
			const active = this._editorGroupsService.activeGroup;
			const target = existing ?? (active.isEmpty ? active : this._editorGroupsService.addGroup(active, GroupDirection.LEFT));
			await this._applying$(async () => this._terminalService.moveToEditor(instance, target.id));
		}
		for (let attempt = 0; attempt < 20; attempt++) {
			const group = this._groupOf(instance);
			if (group) {
				group.lock(true);
				return group;
			}
			await timeout(50);
		}
		return undefined;
	}

	private _claudeGroup(except?: ITerminalInstance): IEditorGroup | undefined {
		for (const instance of this._sessions) {
			if (instance !== except) {
				const group = this._groupOf(instance);
				if (group) {
					return group;
				}
			}
		}
		return undefined;
	}

	private _otherGroups(claude: IEditorGroup): IEditorGroup[] {
		return this._editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE).filter(group => group !== claude);
	}

	/**
	 * A window closed while Claude ran reopens with Claude's group restored empty but still
	 * locked; left alone it would sit there as an extra column. Remove (or at least unlock) those.
	 */
	private _removeStaleClaudeGroups(): void {
		const claude = this._claudeGroup();
		for (const group of [...this._editorGroupsService.groups]) {
			if (group.isLocked && group.isEmpty && group !== claude) {
				if (this._editorGroupsService.count > 1) {
					this._editorGroupsService.removeGroup(group);
				} else {
					group.lock(false);
				}
			}
		}
	}

	private _removeCreatedGroups(): void {
		for (const group of this._createdGroups) {
			if (group.isEmpty && this._editorGroupsService.count > 1 && this._editorGroupsService.getGroup(group.id)) {
				this._editorGroupsService.removeGroup(group);
			}
		}
		this._createdGroups.clear();
	}

	private _unmaximize(group: IEditorGroup): void {
		if (this._editorGroupsService.getPart(group).hasMaximizedGroup()) {
			this._editorGroupsService.toggleMaximizeGroup(group);
		}
	}

	private async _applying$(change: () => Promise<void> | void): Promise<void> {
		this._applying++;
		try {
			await change();
		} finally {
			this._applying--;
		}
	}

	private _groupOf(instance: ITerminalInstance): IEditorGroup | undefined {
		return this._editorGroupsService.groups.find(group => group.editors.some(editor => editor instanceof TerminalEditorInput && editor.terminalInstance === instance));
	}
}

registerWorkbenchContribution2(MautClaudeLayout.ID, MautClaudeLayout, WorkbenchPhase.AfterRestored);
