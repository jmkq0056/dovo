/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { GroupDirection, IAuxiliaryEditorPart, IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import './media/dovoBrowserDock.css';

// Dovo's browser is the built-in one (Chromium, with its DevTools): browser tabs open beside your
// files, web links open there, and the activity bar's globe brings one up.

const openLinksSetting = 'dovo.browser.openLinksInDovo';
/** The docked Firefox tab of earlier builds: restored ones are dropped. */
const retiredTypeId = 'workbench.editors.dovoBrowser';
const containerId = 'workbench.view.dovoBrowser';
const viewId = 'dovo.browser.view';
const terminalEditorTypeId = 'workbench.editors.terminal';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'dovo.browser',
	title: localize('dovo.browser.title', "Dovo Browser"),
	type: 'object',
	properties: {
		[openLinksSetting]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('dovo.browser.openLinks', "Open web links (Cmd+Click on macOS, Ctrl+Click on Windows and Linux, in the editor, terminal or Claude's Reader) in a browser tab inside Dovo instead of your default browser."),
		},
	},
});

export const IDovoBrowserService = createDecorator<IDovoBrowserService>('dovoBrowserService');

export interface IDovoBrowserService {
	readonly _serviceBrand: undefined;
	/** Opens `url` in a new browser tab; without one, shows an open browser tab or opens a new tab page. */
	open(url?: string): Promise<void>;
	/** Opens a new tab page. */
	newTab(): Promise<void>;
	/** Puts the active browser tab in a full-screen window of its own, or brings it back. */
	toggleFullScreen(): Promise<void>;
}

class DovoBrowserService extends Disposable implements IDovoBrowserService {

	declare readonly _serviceBrand: undefined;

	/** The full-screen window a browser tab was put in, while it's open. */
	private _popup: IAuxiliaryEditorPart | undefined;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IOpenerService openerService: IOpenerService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
	) {
		super();
		this._register(openerService.registerExternalOpener({
			openExternal: async href => {
				if (!this._configurationService.getValue<boolean>(openLinksSetting) || !/^https?:\/\//i.test(href)) {
					return false;
				}
				await this.open(href);
				return true;
			},
		}));
	}

	async open(url?: string): Promise<void> {
		if (!url) {
			const existing = this._editorService.editors.find(editor => editor.typeId === BrowserEditorInput.ID);
			if (existing) {
				const holder = this._editorGroupsService.groups.find(group => group.contains(existing));
				if (holder && holder.editors.some(editor => editor.typeId === terminalEditorTypeId)) {
					// It ended up beside Claude's terminal: move it over to the files side.
					holder.moveEditor(existing, this._filesGroup());
					return;
				}
				await this._editorService.openEditor(existing, { pinned: true }, holder ?? this._filesGroup());
				return;
			}
		}
		await this._openTab(url);
	}

	newTab(): Promise<void> {
		return this._openTab(undefined);
	}

	async toggleFullScreen(): Promise<void> {
		const editor = this._editorService.activeEditor;
		const group = this._editorService.activeEditorPane?.group;
		if (!(editor instanceof BrowserEditorInput) || !group) {
			return;
		}
		const main = this._editorGroupsService.mainPart;
		if (this._editorGroupsService.getPart(group) !== main) {
			// Back beside the files; the full-screen window closes once nothing is left in it.
			const part = this._editorGroupsService.getPart(group);
			group.moveEditor(editor, this._filesGroup());
			if (this._popup === part && part.groups.every(candidate => candidate.isEmpty)) {
				this._popup.close();
			}
			return;
		}
		const popup = this._popup = await this._editorGroupsService.createAuxiliaryEditorPart({ compact: true });
		group.moveEditor(editor, popup.activeGroup);
		// Dovo's own full screen (below the notch), on its own window over everything.
		await this._nativeHostService.toggleFullScreen({ targetWindowId: popup.windowId });
	}

	private async _openTab(url: string | undefined): Promise<void> {
		await this._editorService.openEditor({ resource: BrowserViewUri.forId(generateUuid()), options: { pinned: true, viewState: url ? { url } : undefined } }, this._filesGroup());
	}

	/** Where browser tabs open: the main window's group that isn't Claude's terminal. */
	private _filesGroup(): IEditorGroup {
		const main = this._editorGroupsService.mainPart;
		const isFiles = (group: IEditorGroup) => group.isEmpty || !group.editors.some(editor => editor.typeId === terminalEditorTypeId);
		const existing = isFiles(main.activeGroup) ? main.activeGroup : main.groups.find(isFiles);
		// Only Claude's group (Focus, nothing else open): the browser gets a group of its own on
		// the right, beside Claude, never a tab in Claude's group.
		return existing ?? main.addGroup(main.activeGroup, GroupDirection.RIGHT);
	}
}

registerSingleton(IDovoBrowserService, DovoBrowserService, InstantiationType.Delayed);

class RetiredBrowserTabSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return false;
	}
	serialize(): string {
		return '';
	}
	deserialize(): EditorInput | undefined {
		return undefined;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(retiredTypeId, RetiredBrowserTabSerializer);

/** The activity bar's browser entry: choosing it brings up a browser tab beside the files. */
class DovoBrowserView extends ViewPane {

	private readonly _bodyStore = this._register(new DisposableStore());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IDovoBrowserService private readonly _browserService: IDovoBrowserService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				void this._browserService.open();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const body = dom.append(container, dom.$('.dovo-browser-view'));
		dom.append(body, dom.$('p', undefined, isMacintosh
			? localize('dovo.browser.builtInMac', "The browser opens as a tab beside your files, with its DevTools; your logins stay. Cmd+click a link anywhere to open it there.")
			: localize('dovo.browser.builtInOther', "The browser opens as a tab beside your files, with its DevTools; your logins stay. Ctrl+click a link anywhere to open it there.")));
		const newTab = dom.append(body, dom.$<HTMLButtonElement>('button.dovo-browser-primary', { type: 'button' }, localize('dovo.browser.newTabButton', "New Browser Tab")));
		this._bodyStore.add(dom.addDisposableListener(newTab, dom.EventType.CLICK, () => void this._browserService.newTab()));
		if (this.isBodyVisible()) {
			void this._browserService.open();
		}
	}
}

const browserContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: containerId,
	title: localize2('dovo.browser.containerTitle', "Browser"),
	icon: Codicon.globe,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [containerId, { mergeViewWithContainerWhenSingleView: true }]),
	order: 8,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: viewId,
	name: localize2('dovo.browser.viewTitle', "Browser"),
	containerIcon: Codicon.globe,
	ctorDescriptor: new SyncDescriptor(DovoBrowserView),
	canToggleVisibility: false,
	canMoveView: false,
}], browserContainer);

const browserActive = ContextKeyExpr.equals('activeEditor', BrowserEditorInput.EDITOR_ID);
const category = localize2('dovo.category', "Dovo");

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dovo.browser.open', title: localize2('dovo.browser.openTab', "Open Browser Tab"), category, f1: true, icon: Codicon.globe });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IDovoBrowserService).open();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dovo.browser.newTab',
			title: localize2('dovo.browser.newTabTitle', "New Browser Tab"),
			category,
			f1: true,
			icon: Codicon.add,
			keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyT, when: browserActive, weight: KeybindingWeight.WorkbenchContrib + 60 },
			menu: { id: MenuId.BrowserNavigationToolbar, group: 'navigation', order: 4 },
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IDovoBrowserService).newTab();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dovo.browser.toggleFullScreen',
			title: localize2('dovo.browser.fullScreenTitle', "Browser Full Screen"),
			category,
			f1: true,
			icon: Codicon.screenFull,
			toggled: { condition: IsAuxiliaryWindowContext, icon: Codicon.screenNormal, title: localize('dovo.browser.exitFullScreen', "Exit Browser Full Screen") },
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter, when: browserActive, weight: KeybindingWeight.WorkbenchContrib + 60 },
			menu: { id: MenuId.BrowserActionsToolbar, group: 'actions', order: 0 },
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IDovoBrowserService).toggleFullScreen();
	}
});

/** Creates the service at startup, so web links open in a browser tab from the first click. */
class DovoBrowserLinks implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dovoBrowserLinks';
	constructor(@IDovoBrowserService _browserService: IDovoBrowserService) { }
}

registerWorkbenchContribution2(DovoBrowserLinks.ID, DovoBrowserLinks, WorkbenchPhase.AfterRestored);
