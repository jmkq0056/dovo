/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isSingleFolderWorkspaceIdentifier, IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isRecentFolder, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import './media/mautProjectDock.css';

/** Contributed by the built-in `maut-claude-images` extension. */
const statusesCommandId = '_maut.claude.statuses';
const storageKey = 'maut.projectDock.projects';
const maxProjects = 7;
const refreshInterval = 4000;

type ClaudeState = 'working' | 'ready' | undefined;

interface IProject {
	readonly uri: URI;
	readonly name: string;
	/** Window showing this project, if one is open. */
	readonly windowId: number | undefined;
	readonly claude: ClaudeState;
}

/**
 * The project dock: every project one click away, at the top of the activity bar. Each project
 * keeps its own window (so its editors, terminals and Claude sessions stay exactly as they are);
 * the dock switches between them and opens projects that aren't open yet. A dot shows each
 * project's Claude: pulsing while it works, green when it's ready for you.
 */
class MautProjectDock extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.mautcode.projectDock';

	private readonly _element: HTMLElement;
	private readonly _renderStore = this._register(new DisposableStore());
	/** Projects in dock order; stable so buttons don't move under your cursor. */
	private _order: string[];

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IWorkspacesService private readonly _workspacesService: IWorkspacesService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IHostService private readonly _hostService: IHostService,
		@ICommandService private readonly _commandService: ICommandService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._order = this._loadOrder();
		this._element = dom.$('.maut-project-dock');
		this._element.setAttribute('role', 'toolbar');
		this._element.setAttribute('aria-label', localize('maut.dock.label', "Projects"));
		this._mount();
		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this._refresh(), refreshInterval);
		this._register(this._hostService.onDidChangeFocus(focused => focused && this._refresh()));
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
		const [windows, recent, sessions] = await Promise.all([
			this._nativeHostService.getWindows({ includeAuxiliaryWindows: false }),
			this._workspacesService.getRecentlyOpened(),
			this._commandService.executeCommand<{ cwd: string; status: string }[]>(statusesCommandId).catch(() => []),
		]);
		const current = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		const windowFolders = windows.flatMap(window => isSingleFolderWorkspaceIdentifier(window.workspace) ? [{ uri: window.workspace.uri, id: window.id }] : []);

		// Known projects keep their place; new ones (open windows, running Claude, recent) join at the end.
		const candidates = [
			...(current ? [current] : []),
			...windowFolders.map(window => window.uri),
			...(sessions ?? []).map(session => URI.file(session.cwd)),
			...recent.workspaces.filter(isRecentFolder).map(folder => folder.folderUri),
		].filter(uri => uri.scheme === 'file');
		for (const uri of candidates) {
			if (!this._order.includes(uri.toString()) && this._order.length < maxProjects) {
				this._order.push(uri.toString());
			}
		}
		this._saveOrder();

		const projects: IProject[] = this._order.map(key => {
			const uri = URI.parse(key);
			const states = (sessions ?? []).filter(session => isEqualOrParent(URI.file(session.cwd), uri)).map(session => session.status);
			const claude: ClaudeState = states.includes('busy') ? 'working' : states.length ? 'ready' : undefined;
			return { uri, name: basename(uri), windowId: windowFolders.find(window => window.uri.toString() === key)?.id, claude };
		});
		this._render(projects, current);
	}

	private _render(projects: IProject[], current: URI | undefined): void {
		this._renderStore.clear();
		dom.clearNode(this._element);
		for (const project of projects) {
			const isCurrent = !!current && project.uri.toString() === current.toString();
			const button = dom.append(this._element, dom.$<HTMLButtonElement>('button.maut-dock-project', { type: 'button' }));
			button.textContent = initials(project.name);
			button.style.background = colorFor(project.name);
			button.classList.toggle('current', isCurrent);
			button.classList.toggle('closed', project.windowId === undefined && !isCurrent);
			button.setAttribute('aria-label', project.name);
			if (project.claude) {
				dom.append(button, dom.$(`span.maut-dock-status.${project.claude}`));
			}
			const detail = project.claude === 'working'
				? localize('maut.dock.working', "Claude is working")
				: project.claude === 'ready'
					? localize('maut.dock.ready', "Claude is ready")
					: project.windowId !== undefined || isCurrent ? localize('maut.dock.open', "Open") : localize('maut.dock.closed', "Click to open in a new window");
			this._renderStore.add(this._hoverService.setupDelayedHover(button, {
				content: `${project.name} · ${detail}\n${project.uri.fsPath}`,
				appearance: { showPointer: true },
				position: { hoverPosition: HoverPosition.RIGHT },
			}));
			this._renderStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this._open(project, isCurrent)));
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

	private async _addProject(): Promise<void> {
		const picked = await this._fileDialogService.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: localize('maut.dock.pick', "Open a project") });
		const folder = picked?.[0];
		if (!folder) {
			return;
		}
		const key = folder.toString();
		this._order = [...this._order.filter(existing => existing !== key), key].slice(-maxProjects);
		this._saveOrder();
		await this._hostService.openWindow([{ folderUri: folder }], { forceNewWindow: true });
	}

	private _loadOrder(): string[] {
		try {
			const value = JSON.parse(this._storageService.get(storageKey, StorageScope.APPLICATION, '[]'));
			return Array.isArray(value) ? value.filter((v: unknown) => typeof v === 'string').slice(0, maxProjects) : [];
		} catch {
			return [];
		}
	}

	private _saveOrder(): void {
		this._storageService.store(storageKey, JSON.stringify(this._order), StorageScope.APPLICATION, StorageTarget.USER);
	}
}

function initials(name: string): string {
	const words = name.replace(/[-_.]+/g, ' ').trim().split(/\s+/);
	return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 1)).toUpperCase();
}

/** A stable, muted color per project name. */
function colorFor(name: string): string {
	let hash = 0;
	for (const char of name) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	return `hsl(${hash % 360} 45% 42%)`;
}

registerWorkbenchContribution2(MautProjectDock.ID, MautProjectDock, WorkbenchPhase.AfterRestored);
