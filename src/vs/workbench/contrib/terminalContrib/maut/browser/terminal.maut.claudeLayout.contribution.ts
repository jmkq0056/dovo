/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { disposableTimeout, RunOnceScheduler, timeout } from '../../../../../base/common/async.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandDetectionCapability, TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { GroupDirection, GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IMautClaudeService, MautClaudeLayoutMode } from '../../../terminal/browser/mautClaude.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../terminal/browser/terminalEditorInput.js';
import './media/claudeLayout.css';

const enabledSetting = 'maut.claudeLayout.enabled';
/** `claude`, `clsp`, or Claude started by its path (`~/.local/bin/claude --continue`). */
const claudeCommandRegex = /^\s*(?:\S*\/)?(?:claude|clsp)(?:\s|$)/;
/** One-off runs of claude that print and exit (no session to show): `claude -p ...`, `claude --version`, `claude mcp list`. */
const claudeOneOffRegex = /^\s*(?:\S*\/)?claude\s+(?:-p\b|--print\b|-v\b|--version\b|-h\b|--help\b|update\b|mcp\b|config\b|doctor\b|install\b|setup-token\b|migrate-installer\b)/;
/** Per window: the layout Claude was in, its width in IDE mode, and whether it was hidden. */
/** The browser's activity bar entry (contrib/mautcode) and the Explorer. */
const browserContainerId = 'workbench.view.dovoBrowser';
const explorerContainerId = 'workbench.view.explorer';
/** The layout veil's fade in and out, as in claudeLayout.css. */
const veilInDuration = 110;
const veilOutDuration = 260;
const modeKey = 'maut.claude.layout.mode';
const widthKey = 'maut.claude.layout.ideWidth';
/** In IDE mode the file tree is pinned (the side bar shows) or not (the slim rail and the finder instead). */
const pinnedKey = 'maut.claude.layout.treePinned';
const toggleHiddenCommandId = 'maut.claude.toggleHidden';
/** Narrower than this, Claude's column stops being readable. */
const minimumClaudeWidth = 360;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'maut.claudeLayout',
	title: localize('maut.claudeLayout.title', "Dovo Claude layout"),
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
 * - **IDE**: side bar shown, the files on the left and Claude full height on the right, at the
 *   width you last gave it.
 * - **Hidden** (either mode, Cmd+Shift+J or Ctrl+Cmd+J): the files take the editor area and a slim strip on the
 *   right shows Claude's status; a click or the shortcut brings Claude back.
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
	/** True while the window is still restoring its parts (and a while after): see `_settleUntil`. */
	private _opening = true;
	/** Groups this class created empty for the IDE layout, removed again when no longer needed. */
	private readonly _createdGroups = new Set<IEditorGroup>();
	private _hidden = false;
	private _treePinned = false;
	/** The strip on the right edge of the editor area while Claude is hidden. */
	private readonly _strip: HTMLElement;
	private readonly _stripStatus: HTMLElement;
	private readonly _saveWidth = this._register(new RunOnceScheduler(() => this._rememberWidth(), 400));
	/** The opening layout counts as settled once nothing has moved for a moment (see `_noteMovement`). */
	private readonly _settle = this._register(new RunOnceScheduler(() => this._finishOpening(), 650));
	/** The cover over the workbench while the layout changes, so panes never visibly jump. */
	private _veil: HTMLElement | undefined;
	private readonly _veilRemoval = this._register(new MutableDisposable());
	/** A new group (a terminal or tab opened beside) is folded back in shortly after it appears. */
	private readonly _arrangeSoon = this._register(new RunOnceScheduler(() => this._sessions.length ? this._arrange() : this._keepTwoColumns(), 300));

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IMautClaudeService private readonly _claudeService: IMautClaudeService,
		@IStorageService private readonly _storageService: IStorageService,
		@IPaneCompositePartService private readonly _paneCompositeService: IPaneCompositePartService,
	) {
		super();
		this._strip = dom.$<HTMLButtonElement>('button.maut-claude-strip', { type: 'button' });
		dom.append(this._strip, dom.$('span.mcp-avatar'));
		this._stripStatus = dom.append(this._strip, dom.$('span.maut-claude-strip-status'));
		dom.append(this._strip, dom.$('span.maut-claude-strip-label', undefined, localize('maut.claude.strip', "Claude")));
		this._strip.title = localize('maut.claude.stripTitle', "Show Claude");
		this._register(dom.addDisposableListener(this._strip, dom.EventType.CLICK, () => this._setHidden(false)));
		this._register({ dispose: () => this._strip.remove() });
		this._register(this._claudeService.onDidRequestToggleHidden(() => this._setHidden(!this._hidden)));
		this._register(this._claudeService.onDidChange(() => this._strip.classList.toggle('working', this._claudeService.working)));
		// Remember the width you give Claude in IDE mode.
		this._register(this._editorGroupsService.mainPart.onDidLayout(() => {
			this._noteMovement();
			if (this._mode === 'ide' && !this._hidden && !this._applying && this._sessions.length) {
				this._keepMinimumWidth();
				this._saveWidth.schedule();
			}
		}));
		for (const instance of this._terminalService.instances) {
			this._watch(instance);
		}
		this._register(this._terminalService.onDidCreateInstance(instance => this._watch(instance)));
		// Never a third column: whatever opens in a group of its own joins the files (or Claude's).
		this._register(this._editorGroupsService.mainPart.onDidAddGroup(() => {
			this._noteMovement();
			if (!this._applying && !this._hidden) {
				this._arrangeSoon.schedule();
			}
		}));
		// A window can also come back with three columns from last time.
		this._arrangeSoon.schedule();
		// And with terminals from last time: a fresh shell with old output replayed and nothing
		// running. Close those, in the editor area and the panel; Dovo starts its own Agent tab.
		this._register(disposableTimeout(() => this._closeRestoredShells(), 2500));
		this._register(this._claudeService.onDidRequestLayoutMode(mode => this._setMode(mode)));
		// allow-any-unicode-next-line
		// ⌘B and the Explorer icon toggle the side bar. In Focus that means "go to IDE, with the tree";
		// in IDE it pins or unpins the tree, and you stay in IDE.
		// The splash covers the window until its layout has settled; if Claude never starts here
		// (it isn't installed, or auto launch is off), it settles anyway.
		void this._layoutService.whenRestored.then(() => this._register(disposableTimeout(() => this._finishOpening(), 6000)));
		// The browser's activity bar icon only opens the browser tab; it isn't a side bar to keep open.
		this._register(this._paneCompositeService.onDidPaneCompositeOpen(e => {
			if (e.viewContainerLocation === ViewContainerLocation.Sidebar && e.composite.getId() === browserContainerId && this._sessions.length && !this._applying) {
				void this._applying$(async () => {
					if (this._mode === 'ide' && this._treePinned) {
						await this._paneCompositeService.openPaneComposite(explorerContainerId, ViewContainerLocation.Sidebar);
					} else {
						this._layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
					}
				});
			}
		}));
		this._register(this._layoutService.onDidChangePartVisibility(e => {
			this._noteMovement();
			if (e.partId !== Parts.SIDEBAR_PART || this._applying || !this._sessions.length) {
				return;
			}
			// The side bar a window had last time comes back late, after Claude started: that is
			// the window restoring, not you asking for IDE. Keep the layout Claude opened in.
			if (this._opening) {
				if (e.visible) {
					this._arrangeSoon.schedule();
				}
				return;
			}
			if (Date.now() <= this._settleUntil) {
				return;
			}
			if (e.visible && this._paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() === browserContainerId) {
				return;
			}
			this._setTreePinned(e.visible);
			if (e.visible && this._mode === 'focus') {
				this._setMode('ide');
			} else if (this._mode === 'ide') {
				// The tree took or gave back room: put Claude back at its width.
				this._arrange();
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
				if (claudeCommandRegex.test(command.command) && !claudeOneOffRegex.test(command.command)) {
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
			// Claude starts in Focus: Claude on the left, files and the browser on the right. Cmd+B
			// switches to IDE when you want it.
			this._mode = 'focus';
			// Starting Claude always shows it; only the layout and width are remembered.
			this._hidden = false;
			this._treePinned = this._storageService.getBoolean(pinnedKey, StorageScope.WORKSPACE, false);
			this._claudeService.setLayoutMode(this._mode);
			this._claudeService.setHidden(this._hidden);
		}
		this._sessions.push(instance);
		this._claudeService.setClaude(instance, true);
		await this._veiled(async () => {
			const group = await this._placeInEditorArea(instance);
			if (group && this._sessions.includes(instance)) {
				await this._arrange();
			}
		});
		if (this._sessions.includes(instance)) {
			instance.focus();
		}
		this._noteMovement();
	}

	private async _end(instance: ITerminalInstance): Promise<void> {
		const index = this._sessions.indexOf(instance);
		if (index === -1) {
			return;
		}
		this._sessions.splice(index, 1);
		this._claudeService.setClaude(instance, false);
		await this._veiled(() => this._applying$(async () => {
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
			this._showStrip(false);
			this._hidden = false;
			this._claudeService.setHidden(false);
			this._removeCreatedGroups();
			const restore = this._restore;
			this._restore = undefined;
			this._layoutService.setPartHidden(false, Parts.PANEL_PART);
			this._layoutService.setPartHidden(!restore?.sidebarVisible, Parts.SIDEBAR_PART);
		}));
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
		this._storageService.store(modeKey, mode, StorageScope.WORKSPACE, StorageTarget.USER);
		await this._veiled(() => this._arrange());
		this._sessions.at(-1)?.focus();
	}

	private async _setHidden(hidden: boolean): Promise<void> {
		if (!this._sessions.length || hidden === this._hidden) {
			return;
		}
		this._hidden = hidden;
		this._claudeService.setHidden(hidden);
		await this._veiled(() => this._arrange());
		if (!hidden) {
			this._sessions.at(-1)?.focus();
		}
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
			// The tree shows in IDE mode only when pinned; otherwise the rail and the finder stand in.
			this._layoutService.setPartHidden(this._mode !== 'ide' || !this._treePinned, Parts.SIDEBAR_PART);
			if (this._hidden) {
				// The files take the editor area; Claude's group stays, out of sight, still running.
				let files = this._otherGroups(claude).find(group => !group.isEmpty) ?? this._otherGroups(claude)[0];
				if (!files) {
					files = this._editorGroupsService.addGroup(claude, GroupDirection.LEFT);
					this._createdGroups.add(files);
				}
				const part = this._editorGroupsService.getPart(files);
				if (part.hasMaximizedGroup() && part.activeGroup !== files) {
					this._editorGroupsService.toggleMaximizeGroup(claude);
				}
				if (!part.hasMaximizedGroup()) {
					this._editorGroupsService.toggleMaximizeGroup(files);
				}
				files.focus();
				this._showStrip(true);
				return;
			}
			this._showStrip(false);
			for (const group of this._editorGroupsService.groups) {
				this._unmaximize(group);
			}
			this._mergeIntoTwoGroups(claude);
			const others = this._otherGroups(claude);
			if (this._mode === 'ide') {
				// Files on the left, Claude full height on the right.
				let files = others.find(group => !group.isEmpty) ?? others[0];
				if (!files) {
					files = this._editorGroupsService.addGroup(claude, GroupDirection.LEFT);
					this._createdGroups.add(files);
				} else {
					this._editorGroupsService.moveGroup(claude, files, GroupDirection.RIGHT);
				}
				const moved = this._claudeGroup() ?? claude;
				const total = this._layoutService.getContainer(mainWindow, Parts.EDITOR_PART)?.clientWidth ?? 1200;
				const saved = this._storageService.getNumber(widthKey, StorageScope.WORKSPACE, 0);
				const width = Math.round(Math.min(Math.max(saved || total * 0.42, 380), total - 320));
				this._editorGroupsService.setSize(moved, { width, height: this._editorGroupsService.getSize(moved).height });
			} else {
				this._removeCreatedGroups();
				const files = this._otherGroups(claude).find(group => !group.isEmpty);
				if (files) {
					// Files open: Claude on the left, files on the right.
					this._editorGroupsService.moveGroup(claude, files, GroupDirection.LEFT);
				} else if (this._editorGroupsService.count > 1 && !this._editorGroupsService.getPart(claude).hasMaximizedGroup()) {
					this._editorGroupsService.toggleMaximizeGroup(claude);
				}
			}
			// Moving a group can recreate it; make sure the Claude group stays locked.
			this._claudeGroup()?.lock(true);
		});
	}

	/** A smaller window shrinks every group; Claude's column stays readable while there's room. */
	private _keepMinimumWidth(): void {
		const claude = this._claudeGroup();
		const total = this._layoutService.getContainer(mainWindow, Parts.EDITOR_PART)?.clientWidth ?? 0;
		if (!claude || !total) {
			return;
		}
		const size = this._editorGroupsService.getSize(claude);
		const minimum = Math.min(minimumClaudeWidth, total - 260);
		if (size.width < minimum - 2) {
			this._applying++;
			try {
				this._editorGroupsService.setSize(claude, { width: minimum, height: size.height });
			} finally {
				this._applying--;
			}
		}
	}

	private _setTreePinned(pinned: boolean): void {
		this._treePinned = pinned;
		this._storageService.store(pinnedKey, pinned, StorageScope.WORKSPACE, StorageTarget.USER);
	}

	private _rememberWidth(): void {
		const claude = this._claudeGroup();
		if (claude && this._mode === 'ide' && !this._hidden) {
			this._storageService.store(widthKey, this._editorGroupsService.getSize(claude).width, StorageScope.WORKSPACE, StorageTarget.USER);
		}
	}

	/** The slim strip on the right edge of the editor area that brings Claude back. */
	private _showStrip(show: boolean): void {
		const editorArea = this._layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		if (show && editorArea) {
			if (this._strip.parentElement !== editorArea) {
				editorArea.appendChild(this._strip);
			}
			this._strip.classList.toggle('working', this._claudeService.working);
			this._stripStatus.title = this._claudeService.working ? localize('maut.claude.stripWorking', "Claude is working") : localize('maut.claude.stripReady', "Claude is ready");
		} else {
			this._strip.remove();
		}
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

	/**
	 * Two columns, never three: terminals (other agents, a shell you opened) sit beside Claude as
	 * tabs in its group, and everything else (files, the Firefox tab) shares one files group.
	 */
	private _mergeIntoTwoGroups(claude: IEditorGroup): void {
		const isTerminal = (group: IEditorGroup) => group.editors.length > 0 && group.editors.every(editor => editor instanceof TerminalEditorInput);
		const others = this._otherGroups(claude);
		const files = others.find(group => !group.isEmpty && !isTerminal(group)) ?? others.find(group => !isTerminal(group));
		const wasLocked = claude.isLocked;
		claude.lock(false);
		for (const group of others) {
			if (!this._editorGroupsService.getGroup(group.id)) {
				continue;
			}
			// Terminals go beside Claude, whichever group they were in.
			for (const editor of [...group.editors]) {
				if (editor instanceof TerminalEditorInput) {
					group.moveEditor(editor, claude, { preserveFocus: true, inactive: true });
				}
			}
			if (group === files || !this._editorGroupsService.getGroup(group.id)) {
				continue;
			}
			if (group.isEmpty) {
				this._editorGroupsService.removeGroup(group);
			} else if (files) {
				this._editorGroupsService.mergeGroup(group, files);
			}
		}
		claude.lock(wasLocked);
	}

	/** Terminals restored from last time with nothing running in them, wherever they are: just old output. */
	private _closeRestoredShells(): void {
		for (const instance of [...this._terminalService.instances]) {
			const restored = !!instance.shellLaunchConfig.attachPersistentProcess;
			// "Running" is a command shell integration saw start (a dev server, say); background
			// helpers a shell keeps (git status daemons and the like) don't count.
			const detection = instance.capabilities.get(TerminalCapability.CommandDetection);
			const running = detection ? !!detection.executingCommand : instance.hasChildProcesses;
			if (restored && !this._claudeService.isClaude(instance) && !running) {
				instance.dispose();
			}
		}
	}

	/** Without a running Claude: still two columns at most, the agent tab's group kept as one of them. */
	private async _keepTwoColumns(): Promise<void> {
		const main = this._editorGroupsService.mainPart;
		if (this._applying || main.count <= 2) {
			return;
		}
		const groups = main.getGroups(GroupsOrder.GRID_APPEARANCE);
		const agent = groups.find(group => group.editors.some(editor => editor instanceof TerminalEditorInput && /^Agent\b/.test(editor.getName()))) ?? groups[0];
		await this._applying$(async () => this._mergeIntoTwoGroups(agent));
	}

	private _otherGroups(claude: IEditorGroup): IEditorGroup[] {
		// Only the main window: a group popped out into a window of its own stays there.
		return this._editorGroupsService.mainPart.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE).filter(group => group !== claude);
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

	/** While the window opens, every move pushes "settled" back a little. */
	private _noteMovement(): void {
		if (this._opening && this._sessions.length) {
			this._settle.schedule();
		}
	}

	private _finishOpening(): void {
		if (this._opening) {
			this._opening = false;
			this._settle.cancel();
			this._claudeService.settleLayout();
		}
	}

	/**
	 * Runs a layout change behind a short fade, so groups moving and parts appearing are never seen
	 * mid-way. While the window opens the splash covers everything already.
	 */
	private async _veiled(change: () => Promise<void>): Promise<void> {
		const container = this._layoutService.mainContainer;
		if (this._opening || this._veil || mainWindow.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			return change();
		}
		const veil = this._veil = dom.append(container, dom.$('.dovo-layout-veil'));
		dom.append(veil, dom.$('.dovo-layout-veil-glow'));
		const top = this._layoutService.getContainer(mainWindow, Parts.TITLEBAR_PART)?.getBoundingClientRect().bottom ?? 0;
		veil.style.top = `${Math.max(0, Math.round(top))}px`;
		try {
			// Fade in, then change underneath, then let the new layout paint before fading out.
			void veil.offsetWidth;
			veil.classList.add('in');
			await timeout(veilInDuration);
			await change();
			await timeout(120);
		} finally {
			veil.classList.remove('in');
			veil.classList.add('out');
			this._veil = undefined;
			const timer = mainWindow.setTimeout(() => veil.remove(), veilOutDuration);
			this._veilRemoval.value = toDisposable(() => {
				mainWindow.clearTimeout(timer);
				veil.remove();
			});
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

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: toggleHiddenCommandId,
			title: localize2('maut.claude.toggleHidden', "Hide or Show Claude"),
			category: localize2('maut.claude.category', "Dovo"),
			f1: true,
			keybinding: [{
				// Cmd+Shift+J (Ctrl+Shift+J elsewhere) everywhere except the Search view and Search
				// editor, which keep it for Toggle Query Details.
				weight: KeybindingWeight.WorkbenchContrib + 100,
				when: ContextKeyExpr.and(ContextKeyExpr.not('searchViewletFocus'), ContextKeyExpr.not('inSearchEditor')),
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyJ,
			}, {
				// Ctrl+Cmd+J on macOS and Ctrl+Alt+J elsewhere, as before.
				weight: KeybindingWeight.WorkbenchContrib + 100,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ,
				mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.KeyJ },
			}],
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IMautClaudeService).requestToggleHidden();
	}
});
