/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, isEqualOrParent } from '../../../../base/common/resources.js';
import { isDefined } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isSingleFolderWorkspaceIdentifier, IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import './media/mautProjectDock.css';

/** Contributed by the built-in `maut-claude-images` extension. */
const statusesCommandId = '_maut.claude.statuses';
const storageKey = 'maut.projectDock.projects';
const starredKey = 'maut.projectDock.starred';
/** Projects you removed from the dock: hidden until you open them again from the dock's +. */
const hiddenKey = 'maut.projectDock.hidden';
const refreshInterval = 2000;

/** Working: Claude is busy. Needs you: it finished while you were elsewhere, until you go there. */
type ClaudeState = 'working' | 'needs' | undefined;

interface IProject {
	readonly uri: URI;
	readonly name: string;
	/** Window showing this project, if one is open. */
	readonly windowId: number | undefined;
	readonly starred: boolean;
	readonly claude: ClaudeState;
}

/**
 * The project dock, at the top of the activity bar: the projects open in a window, plus the ones
 * you star (hover a project for its star, or right-click it), which stay one click away when
 * closed. Each project keeps its own window; the dock switches between them. A dot shows each
 * project's Claude: a spinner while it works, a bell when it finished while you were elsewhere.
 */
class MautProjectDock extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.mautcode.projectDock';

	private readonly _element: HTMLElement;
	private readonly _renderStore = this._register(new DisposableStore());
	/** Projects in dock order; stable so buttons don't move under your cursor. */
	private _order: string[];
	private readonly _starred: Set<string>;
	private readonly _hidden: Set<string>;
	/** Each project's Claude, last time we looked: busy or not. */
	private readonly _wasBusy = new Map<string, boolean>();
	private readonly _needsYou = new Set<string>();
	private _lastProjects = new Map<string, IProject>();

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IHostService private readonly _hostService: IHostService,
		@ICommandService private readonly _commandService: ICommandService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IStorageService private readonly _storageService: IStorageService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
	) {
		super();
		this._order = this._loadList(storageKey);
		this._starred = new Set(this._loadList(starredKey));
		this._hidden = new Set(this._loadList(hiddenKey));
		// Opening a project you removed brings it back.
		const opened = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString();
		if (opened && this._hidden.delete(opened)) {
			this._saveList(hiddenKey, [...this._hidden]);
		}
		this._element = dom.$('.maut-project-dock');
		this._element.setAttribute('role', 'toolbar');
		this._element.setAttribute('aria-label', localize('maut.dock.label', "Projects"));
		this._mount();
		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this._refresh(), refreshInterval);
		this._register(this._hostService.onDidChangeFocus(focused => focused && this._refresh()));
		// Windows opening, closing (focus moves on) and gaining focus show up right away.
		this._register(this._nativeHostService.onDidOpenMainWindow(() => this._refresh()));
		this._register(this._nativeHostService.onDidFocusMainWindow(() => this._refresh()));
		this._register(this._nativeHostService.onDidBlurMainWindow(() => this._refresh()));
		this._refresh();
	}

	/** The dock lives at the top of the activity bar, above its view icons. */
	private _mount(): void {
		// The activity bar has no slot for custom content; its content element is the anchor.
		// eslint-disable-next-line no-restricted-syntax
		const content = this._layoutService.mainContainer.querySelector('.part.activitybar > .content');
		if (content) {
			content.prepend(this._element);
		}
		this._register({ dispose: () => this._element.remove() });
	}

	private async _refresh(): Promise<void> {
		const [windows, sessions] = await Promise.all([
			this._nativeHostService.getWindows({ includeAuxiliaryWindows: false }),
			this._commandService.executeCommand<{ cwd: string; status: string }[]>(statusesCommandId).catch(() => []),
		]);
		const current = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		// Stars and removals are shared by every window.
		this._replace(this._starred, this._loadList(starredKey));
		this._replace(this._hidden, this._loadList(hiddenKey));
		const windowFolders = windows.flatMap(window => isSingleFolderWorkspaceIdentifier(window.workspace) ? [{ uri: window.workspace.uri, id: window.id }] : []);

		// What's open, and what you starred. Known projects keep their place; new ones join at the end.
		const open = new Set([...(current ? [current] : []), ...windowFolders.map(window => window.uri)].filter(uri => uri.scheme === 'file').map(uri => uri.toString()));
		for (const key of [...open, ...this._starred]) {
			if (!this._order.includes(key)) {
				this._order.push(key);
			}
		}
		// A removed project stays out, except in its own window (so you always see where you are).
		this._order = this._order.filter(key => (open.has(key) || this._starred.has(key)) && (!this._hidden.has(key) || key === current?.toString()));
		this._saveList(storageKey, this._order);

		const projects: IProject[] = this._order.map(key => {
			const uri = URI.parse(key);
			const states = (sessions ?? []).filter(session => isEqualOrParent(URI.file(session.cwd), uri)).map(session => session.status);
			const busy = states.includes('busy');
			const isCurrent = !!current && key === current.toString();
			if (this._wasBusy.get(key) && !busy && states.length && !(isCurrent && this._hostService.hasFocus)) {
				this._needsYou.add(key);
			}
			if (busy || !states.length || (isCurrent && this._hostService.hasFocus)) {
				this._needsYou.delete(key);
			}
			this._wasBusy.set(key, busy);
			const claude: ClaudeState = busy ? 'working' : this._needsYou.has(key) ? 'needs' : undefined;
			return { uri, name: basename(uri), windowId: windowFolders.find(window => window.uri.toString() === key)?.id, claude, starred: this._starred.has(key) };
		});
		this._lastProjects = new Map(projects.map(project => [project.uri.toString(), project]));
		this._render(projects, current);
	}

	private _render(projects: IProject[], current: URI | undefined): void {
		this._renderStore.clear();
		dom.clearNode(this._element);
		for (const project of projects) {
			const isCurrent = !!current && project.uri.toString() === current.toString();
			const button = dom.append(this._element, dom.$<HTMLButtonElement>('button.maut-dock-project', { type: 'button' }));
			button.textContent = initials(project.name);
			button.classList.toggle('current', isCurrent);
			button.classList.toggle('starred', project.starred);
			button.classList.toggle('closed', project.windowId === undefined && !isCurrent);
			button.setAttribute('aria-label', project.name);
			if (project.claude) {
				// One tone: a spinner while Claude works, a bell when it's waiting for you.
				const icon = project.claude === 'working' ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.bellDot;
				dom.append(button, dom.$(`span.maut-dock-status.${project.claude}${ThemeIcon.asCSSSelector(icon)}`));
			}
			const detail = project.claude === 'working'
				? localize('maut.dock.working', "Claude is working")
				: project.claude === 'needs'
					? localize('maut.dock.needsYou', "Claude finished and is waiting for you")
					: project.windowId !== undefined || isCurrent ? localize('maut.dock.open', "Open") : localize('maut.dock.closed', "Click to open in a new window");
			this._renderStore.add(this._hoverService.setupDelayedHover(button, {
				content: `${project.name} · ${detail}\n${project.uri.fsPath}`,
				appearance: { showPointer: true },
				position: { hoverPosition: HoverPosition.RIGHT },
			}));
			this._renderStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this._open(project, isCurrent)));
			// A tiny star on hover keeps a project in the dock when its window is closed.
			const star = dom.append(button, dom.$<HTMLElement>(`span.maut-dock-star${ThemeIcon.asCSSSelector(project.starred ? Codicon.starFull : Codicon.starEmpty)}`));
			star.setAttribute('role', 'button');
			star.setAttribute('aria-label', project.starred ? localize('maut.dock.unstar', "Unstar") : localize('maut.dock.star', "Star"));
			this._renderStore.add(dom.addDisposableListener(star, dom.EventType.CLICK, e => {
				e.stopPropagation();
				this._toggleStar(project);
			}));
			this._renderStore.add(dom.addDisposableListener(button, dom.EventType.CONTEXT_MENU, e => {
				// The dock's own menu, not the activity bar's.
				e.preventDefault();
				e.stopPropagation();
				this._contextMenuService.showContextMenu({
					getAnchor: () => new StandardMouseEvent(dom.getWindow(button), e),
					getActions: () => [
						toAction({ id: 'maut.dock.toggleStar', label: project.starred ? localize('maut.dock.unstarProject', "Unstar Project") : localize('maut.dock.starProject', "Star Project"), run: () => this._toggleStar(project) }),
						toAction({
							id: 'maut.dock.remove',
							label: project.windowId !== undefined || isCurrent ? localize('maut.dock.closeAndRemove', "Close and Remove from Dock") : localize('maut.dock.removeProject', "Remove from Dock"),
							run: () => this._remove(project, isCurrent),
						}),
						new Separator(),
						toAction({ id: 'maut.dock.openNew', label: localize('maut.dock.openNewWindow', "Open in New Window"), run: () => this._hostService.openWindow([{ folderUri: project.uri }], { forceNewWindow: true }) }),
						toAction({ id: 'maut.dock.reveal', label: localize('maut.dock.reveal', "Reveal in Finder"), run: () => this._nativeHostService.showItemInFolder(project.uri.fsPath) }),
						toAction({ id: 'maut.dock.copyPath', label: localize('maut.dock.copyPath', "Copy Path"), run: () => this._clipboardService.writeText(project.uri.fsPath) }),
					],
				});
			}));
		}
		const add = dom.append(this._element, dom.$<HTMLButtonElement>('button.maut-dock-add', { type: 'button' }, '+'));
		add.setAttribute('aria-label', localize('maut.dock.add', "Open another project"));
		this._renderStore.add(this._hoverService.setupDelayedHover(add, { content: localize('maut.dock.addHover', "Open another project in its own window"), position: { hoverPosition: HoverPosition.RIGHT } }));
		this._renderStore.add(dom.addDisposableListener(add, dom.EventType.CLICK, () => this._addProject()));
	}

	private async _open(project: IProject, isCurrent: boolean): Promise<void> {
		if (isCurrent) {
			return;
		}
		if (project.windowId !== undefined) {
			await this._nativeHostService.focusWindow({ targetWindowId: project.windowId });
		} else {
			await this._hostService.openWindow([{ folderUri: project.uri }], { forceNewWindow: true });
		}
	}

	/** Takes a project out of the dock, closing its window if it has one. */
	private async _remove(project: IProject, isCurrent: boolean): Promise<void> {
		const key = project.uri.toString();
		this._hidden.add(key);
		this._starred.delete(key);
		this._saveList(hiddenKey, [...this._hidden]);
		this._saveList(starredKey, [...this._starred]);
		if (isCurrent) {
			await this._nativeHostService.closeWindow();
			return;
		}
		this._order = this._order.filter(existing => existing !== key);
		this._render(this._order.map(existing => this._lastProjects.get(existing)).filter(isDefined), this._workspaceContextService.getWorkspace().folders[0]?.uri);
		if (project.windowId !== undefined) {
			await this._nativeHostService.closeWindow({ targetWindowId: project.windowId });
		}
		this._refresh();
	}

	private _replace(set: Set<string>, values: string[]): void {
		set.clear();
		for (const value of values) {
			set.add(value);
		}
	}

	private _toggleStar(project: IProject): void {
		const key = project.uri.toString();
		if (!this._starred.delete(key)) {
			this._starred.add(key);
		}
		this._saveList(starredKey, [...this._starred]);
		this._refresh();
	}

	private async _addProject(): Promise<void> {
		const picked = await this._fileDialogService.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: localize('maut.dock.pick', "Open a project") });
		const folder = picked?.[0];
		if (!folder) {
			return;
		}
		const key = folder.toString();
		if (this._hidden.delete(key)) {
			this._saveList(hiddenKey, [...this._hidden]);
		}
		this._order = [...this._order.filter(existing => existing !== key), key];
		this._saveList(storageKey, this._order);
		await this._hostService.openWindow([{ folderUri: folder }], { forceNewWindow: true });
	}

	private _loadList(key: string): string[] {
		try {
			const value = JSON.parse(this._storageService.get(key, StorageScope.APPLICATION, '[]'));
			return Array.isArray(value) ? value.filter((v: unknown) => typeof v === 'string') : [];
		} catch {
			return [];
		}
	}

	private _saveList(key: string, list: string[]): void {
		this._storageService.store(key, JSON.stringify(list), StorageScope.APPLICATION, StorageTarget.USER);
	}
}

/** A two-letter monogram: the first letters of two words ("MC"), else "Do" for one word. */
function initials(name: string): string {
	const words = name.replace(/[-_.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
	if (words.length > 1) {
		return (words[0][0] + words[1][0]).toUpperCase();
	}
	const word = words[0] ?? name;
	return word.slice(0, 1).toUpperCase() + word.slice(1, 2).toLowerCase();
}

registerWorkbenchContribution2(MautProjectDock.ID, MautProjectDock, WorkbenchPhase.AfterRestored);
