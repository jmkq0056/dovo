/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import './media/dovoBrowserDock.css';

// Dovo's browser: Gecko can't run inside Electron, so the user's real Firefox (its passwords,
// Inspector, Console, extensions) is docked: a "Firefox" editor tab sits beside the files, and its
// window is placed exactly over that tab's body and kept there. The extension host moves the window
// (maut-open-external/src/browserDock.ts); this side knows where the tab is on screen.

const appSetting = 'dovo.browser.app';
const openLinksSetting = 'dovo.browser.openLinksInDovo';
const browserTypeId = 'workbench.editors.dovoBrowser';
const containerId = 'workbench.view.dovoBrowser';
const viewId = 'dovo.browser.view';
const terminalEditorTypeId = 'workbench.editors.terminal';
const accessibilitySettingsUrl = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const downloadUrl = 'https://www.mozilla.org/firefox/new/';

type DockStatus = 'ok' | 'unsupported' | 'missing' | 'notRunning' | 'noWindow' | 'permission' | 'error';

interface IBrowserWindow {
	readonly index: number;
	readonly title: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly docked: boolean;
}

interface IDockResult {
	readonly status: DockStatus;
	readonly title?: string;
	readonly windows?: IBrowserWindow[];
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'dovo.browser',
	title: localize('dovo.browser.title', "Dovo Browser"),
	type: 'object',
	properties: {
		[appSetting]: {
			type: 'string',
			default: 'Firefox',
			markdownDescription: localize('dovo.browser.app', "The browser app Dovo docks in its browser tab, for example `Firefox`, `Firefox Developer Edition`, `LibreWolf` or `Zen` (macOS)."),
		},
		[openLinksSetting]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('dovo.browser.openLinks', "Open web links (Cmd+Click in the editor, terminal or Claude's Reader) in the browser tab inside Dovo instead of your default browser (macOS)."),
		},
	},
});

// A docked window can only sit over Dovo if full screen doesn't move Dovo to a Space of its own.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{ overrides: { 'window.nativeFullScreen': false } }]);

export const IDovoBrowserService = createDecorator<IDovoBrowserService>('dovoBrowserService');

export interface IDovoBrowserService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly input: DovoBrowserInput;
	readonly status: DockStatus | undefined;
	readonly appName: string;
	/** Opens (or shows) the browser tab, optionally loading `url` in the browser first. */
	open(url?: string): Promise<void>;
	/** The tab's body: the browser window is kept over it while the tab is visible. */
	attach(body: HTMLElement): IDisposable;
	setVisible(visible: boolean): void;
	focusBrowser(): void;
	pickWindow(): Promise<void>;
	newTab(): Promise<void>;
	toggleFullScreen(): void;
	openAccessibilitySettings(): void;
	openDownloadPage(): void;
}

/** The browser tab. There is one; its title follows the docked window's page title. */
export class DovoBrowserInput extends EditorInput {

	static readonly RESOURCE = URI.from({ scheme: 'dovo-browser', path: '/browser' });

	private _title: string | undefined;

	constructor(private readonly _appName: () => string) {
		super();
	}

	override get typeId(): string {
		return browserTypeId;
	}

	override get editorId(): string | undefined {
		return browserTypeId;
	}

	override get resource(): URI | undefined {
		return DovoBrowserInput.RESOURCE;
	}

	override getName(): string {
		return this._title || this._appName();
	}

	override getTitle(): string {
		return this._title ? localize('dovo.browser.tabTitle', "{0} ({1})", this._title, this._appName()) : this._appName();
	}

	override getIcon(): ThemeIcon {
		return Codicon.globe;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof DovoBrowserInput;
	}

	override toUntyped(): IUntypedEditorInput {
		return { resource: DovoBrowserInput.RESOURCE, options: { override: browserTypeId, pinned: true } };
	}

	setTitle(title: string | undefined): void {
		// Firefox appends its own name to every page title; the tab doesn't need it twice.
		const clean = title?.replace(/\s+[\u2014\u2013-]\s+(?:Mozilla Firefox|Firefox Developer Edition|Firefox Nightly|Firefox|LibreWolf|Zen Browser|Zen)$/, '').trim() || undefined;
		if (clean !== this._title) {
			this._title = clean;
			this._onDidChangeLabel.fire();
		}
	}
}

class DovoBrowserService extends Disposable implements IDovoBrowserService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _input: DovoBrowserInput | undefined;

	private _status: DockStatus | undefined;
	private _body: HTMLElement | undefined;
	private _visible = false;
	/** The last rectangle sent, so the window only moves when the tab does. */
	private _placedKey = '';
	private _pick: { title?: string; x?: number; y?: number } | undefined;
	private _busy = false;
	/** Set after a failure (no permission, browser missing): no more tries until the user acts. */
	private _halted = false;
	private _installed: boolean | undefined;
	private _fullScreen: { sideBar: boolean; auxiliaryBar: boolean; panel: boolean } | undefined;
	private readonly _loop = this._register(new MutableDisposable<IntervalTimer>());
	private readonly _raise = this._register(new MutableDisposable());
	private _ticks = 0;

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IHostService private readonly _hostService: IHostService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
	) {
		super();
		this._register(toDisposable(() => this._input?.dispose()));
		// Coming back to Dovo, or clicking anywhere in it, puts Dovo's window over the browser:
		// raise the browser again (without taking focus) while its tab is showing.
		this._register(this._hostService.onDidChangeFocus(focused => {
			if (focused) {
				this._raiseSoon();
			}
		}));
		this._register(dom.addDisposableListener(mainWindow, dom.EventType.MOUSE_DOWN, e => {
			if (this._visible && !(this._body && dom.isAncestor(e.target as Node, this._body))) {
				this._raiseSoon();
			}
		}, true));
		if (isMacintosh) {
			this._register(this._openerService.registerExternalOpener({
				openExternal: async href => {
					if (!this._configurationService.getValue<boolean>(openLinksSetting) || !/^https?:\/\//i.test(href) || !await this._isInstalled()) {
						return false;
					}
					await this.open(href);
					return true;
				},
			}));
		}
	}

	get status(): DockStatus | undefined {
		return isMacintosh ? this._status : 'unsupported';
	}

	/** The tab's input; closing the tab disposes it, so a new one is made for the next open. */
	get input(): DovoBrowserInput {
		if (!this._input || this._input.isDisposed()) {
			this._input = new DovoBrowserInput(() => this.appName);
		}
		return this._input;
	}

	get appName(): string {
		return this._configurationService.getValue<string>(appSetting)?.trim() || 'Firefox';
	}

	async open(url?: string): Promise<void> {
		this._halted = false;
		if (url) {
			await this._commandService.executeCommand('_dovo.browser.openUrl', this.appName, url).catch(() => undefined);
		}
		await this._editorService.openEditor(this.input, { pinned: true }, this._filesGroup());
		this._placedKey = '';
		this._dock();
	}

	attach(body: HTMLElement): IDisposable {
		this._body = body;
		this._placedKey = '';
		return toDisposable(() => {
			if (this._body === body) {
				this._body = undefined;
				this.setVisible(false);
			}
		});
	}

	setVisible(visible: boolean): void {
		this._visible = visible;
		if (!visible) {
			this._loop.clear();
			return;
		}
		this._placedKey = '';
		this._halted = false;
		const timer = new IntervalTimer();
		timer.cancelAndSet(() => this._tick(), 250, mainWindow);
		this._loop.value = timer;
		this._dock();
	}

	focusBrowser(): void {
		if (this._status !== 'ok') {
			// Clicking the tab is the way to try again after a failure.
			this._halted = false;
			this._placedKey = '';
			this._dock();
			return;
		}
		void this._call('_dovo.browser.raise', this.appName, true);
	}

	async pickWindow(): Promise<void> {
		if (!isMacintosh) {
			return;
		}
		const result = await this._call('_dovo.browser.windows', this.appName);
		const windows = result?.windows ?? [];
		if (!windows.length) {
			return;
		}
		const items: (IQuickPickItem & { window: IBrowserWindow })[] = windows.map(window => ({
			window,
			label: window.title || localize('dovo.browser.untitled', "Untitled Window"),
			description: localize('dovo.browser.windowSize', "{0} \u00d7 {1}", window.width, window.height),
			detail: window.docked ? localize('dovo.browser.docked', "Shown in Dovo now") : undefined,
		}));
		const picked = await this._quickInputService.pick(items, { placeHolder: localize('dovo.browser.pickWindow', "Which {0} window to show in Dovo", this.appName) });
		if (picked) {
			this._pick = { title: picked.window.title, x: picked.window.x, y: picked.window.y };
			this._placedKey = '';
			this._dock();
		}
	}

	async newTab(): Promise<void> {
		await this._call('_dovo.browser.newTab', this.appName);
	}

	toggleFullScreen(): void {
		const group = this._groupOfInput();
		if (!group) {
			return;
		}
		if (this._fullScreen) {
			const previous = this._fullScreen;
			this._fullScreen = undefined;
			if (this._editorGroupsService.getPart(group).hasMaximizedGroup()) {
				this._editorGroupsService.toggleMaximizeGroup(group);
			}
			this._layoutService.setPartHidden(!previous.sideBar, Parts.SIDEBAR_PART);
			this._layoutService.setPartHidden(!previous.auxiliaryBar, Parts.AUXILIARYBAR_PART);
			this._layoutService.setPartHidden(!previous.panel, Parts.PANEL_PART);
		} else {
			this._fullScreen = {
				sideBar: this._layoutService.isVisible(Parts.SIDEBAR_PART),
				auxiliaryBar: this._layoutService.isVisible(Parts.AUXILIARYBAR_PART),
				panel: this._layoutService.isVisible(Parts.PANEL_PART),
			};
			this._layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			this._layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			this._layoutService.setPartHidden(true, Parts.PANEL_PART);
			if (!this._editorGroupsService.getPart(group).hasMaximizedGroup()) {
				this._editorGroupsService.toggleMaximizeGroup(group);
			}
		}
		this._placedKey = '';
	}

	openAccessibilitySettings(): void {
		void this._openerService.open(URI.parse(accessibilitySettingsUrl), { openExternal: true });
	}

	openDownloadPage(): void {
		void this._openerService.open(URI.parse(downloadUrl), { openExternal: true });
	}

	/** Where files open: the group that isn't Claude's terminal. */
	private _filesGroup(): IEditorGroup | undefined {
		const existing = this._groupOfInput();
		if (existing) {
			return existing;
		}
		const isFiles = (group: IEditorGroup) => group.activeEditor?.typeId !== terminalEditorTypeId;
		const active = this._editorGroupsService.activeGroup;
		if (isFiles(active)) {
			return active;
		}
		return this._editorGroupsService.groups.find(isFiles) ?? active;
	}

	private _groupOfInput(): IEditorGroup | undefined {
		return this._editorGroupsService.groups.find(group => group.editors.some(editor => editor === this.input));
	}

	private _tick(): void {
		this._dock();
		// The page title changes as the user browses; refresh it every couple of seconds.
		if (this._status === 'ok' && ++this._ticks % 8 === 0) {
			void this._call('_dovo.browser.windows', this.appName).then(result => {
				const docked = result?.windows?.find(window => window.docked);
				if (docked) {
					this.input.setTitle(docked.title);
				}
			});
		}
	}

	/** Places the browser window over the tab's body, if it moved since last time. */
	private _dock(): void {
		const body = this._body;
		if (!isMacintosh || !this._visible || !body || this._busy || this._halted) {
			return;
		}
		const rect = body.getBoundingClientRect();
		if (rect.width < 40 || rect.height < 40) {
			return;
		}
		const targetWindow = dom.getWindow(body);
		// Screen points: the window's position, its native title bar (if any), then the body.
		const chrome = Math.max(0, targetWindow.outerHeight - targetWindow.innerHeight);
		const screenRect = {
			x: Math.round(targetWindow.screenX + rect.left),
			y: Math.round(targetWindow.screenY + chrome + rect.top),
			width: Math.round(rect.width),
			height: Math.round(rect.height),
		};
		const key = `${screenRect.x},${screenRect.y},${screenRect.width},${screenRect.height}`;
		if (key === this._placedKey && !this._pick) {
			return;
		}
		this._busy = true;
		const pick = this._pick;
		this._pick = undefined;
		void this._call('_dovo.browser.dock', this.appName, screenRect, pick).then(result => {
			this._busy = false;
			this._setStatus(result?.status ?? 'error');
			if (result?.status === 'ok') {
				this._placedKey = key;
				this.input.setTitle(result.title);
			} else {
				this._halted = true;
			}
		});
	}

	private _raiseSoon(): void {
		if (!this._visible) {
			return;
		}
		const timer = mainWindow.setTimeout(() => {
			if (this._visible && this._status === 'ok') {
				void this._call('_dovo.browser.raise', this.appName, false);
			}
		}, 140);
		this._raise.value = toDisposable(() => mainWindow.clearTimeout(timer));
	}

	private async _isInstalled(): Promise<boolean> {
		if (this._installed === undefined) {
			this._installed = !!await this._commandService.executeCommand<boolean>('_dovo.browser.installed', this.appName).catch(() => false);
		}
		return this._installed;
	}

	private async _call(command: string, ...args: unknown[]): Promise<IDockResult | undefined> {
		try {
			const result = await this._commandService.executeCommand<IDockResult>(command, ...args);
			if (result?.status === 'permission' || result?.status === 'missing') {
				this._setStatus(result.status);
			}
			return result;
		} catch {
			// The extension host isn't up yet.
			return undefined;
		}
	}

	private _setStatus(status: DockStatus): void {
		if (status !== this._status) {
			this._status = status;
			if (status === 'missing') {
				this._installed = false;
			}
			this._onDidChange.fire();
		}
	}
}

registerSingleton(IDovoBrowserService, DovoBrowserService, InstantiationType.Delayed);

/** What the browser tab shows underneath the docked window: only seen while it isn't there yet. */
function renderPlaceholder(container: HTMLElement, service: IDovoBrowserService, store: DisposableStore): () => void {
	const icon = dom.append(container, dom.$(`span.dovo-browser-icon${ThemeIcon.asCSSSelector(Codicon.globe)}`));
	icon.setAttribute('aria-hidden', 'true');
	const title = dom.append(container, dom.$('.dovo-browser-title'));
	const detail = dom.append(container, dom.$('.dovo-browser-detail'));
	const actions = dom.append(container, dom.$('.dovo-browser-actions'));
	const render = () => {
		dom.clearNode(actions);
		const button = (label: string, run: () => void, primary = false) => {
			const element = dom.append(actions, dom.$<HTMLButtonElement>(`button${primary ? '.primary' : ''}`, { type: 'button' }, label));
			store.add(dom.addDisposableListener(element, dom.EventType.CLICK, e => {
				e.stopPropagation();
				run();
			}));
		};
		switch (service.status) {
			case 'unsupported':
				title.textContent = localize('dovo.browser.unsupported', "The browser tab is macOS-only for now");
				detail.textContent = localize('dovo.browser.unsupportedDetail', "Links open in your default browser.");
				break;
			case 'permission':
				title.textContent = localize('dovo.browser.permission', "Let Dovo place {0} here", service.appName);
				detail.textContent = localize('dovo.browser.permissionDetail', "macOS needs your OK once: turn on Dovo under Privacy & Security > Accessibility, then click the tab again.");
				button(localize('dovo.browser.openSettings', "Open Accessibility Settings"), () => service.openAccessibilitySettings(), true);
				break;
			case 'missing':
				title.textContent = localize('dovo.browser.missing', "{0} isn't installed", service.appName);
				detail.textContent = localize('dovo.browser.missingDetail', "Install it, or choose another browser in the dovo.browser.app setting.");
				button(localize('dovo.browser.getFirefox', "Get Firefox"), () => service.openDownloadPage(), true);
				break;
			default:
				title.textContent = localize('dovo.browser.shownHere', "{0} is shown here", service.appName);
				detail.textContent = localize('dovo.browser.shownHereDetail', "Your own {0}, with its passwords, tabs, Inspector and Console. Click here to use it.", service.appName);
				button(localize('dovo.browser.chooseWindow', "Choose Window"), () => void service.pickWindow(), true);
				button(localize('dovo.browser.newTab', "New Tab"), () => void service.newTab());
				button(localize('dovo.browser.fullScreen', "Full Screen"), () => service.toggleFullScreen());
		}
	};
	render();
	store.add(service.onDidChange(render));
	return render;
}

class DovoBrowserEditor extends EditorPane {

	static readonly ID = browserTypeId;

	private _body: HTMLElement | undefined;
	private readonly _attached = this._register(new MutableDisposable());
	private readonly _placeholderStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IDovoBrowserService private readonly _browserService: IDovoBrowserService,
	) {
		super(DovoBrowserEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		const body = this._body = dom.append(parent, dom.$('.dovo-browser-body'));
		body.tabIndex = 0;
		renderPlaceholder(dom.append(body, dom.$('.dovo-browser-center')), this._browserService, this._placeholderStore);
		this._placeholderStore.add(dom.addDisposableListener(body, dom.EventType.CLICK, () => this._browserService.focusBrowser()));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this._body) {
			this._attached.value = this._browserService.attach(this._body);
			// The pane can be made visible before it gets its input: start docking now if so.
			this._browserService.setVisible(this.isVisible());
		}
	}

	override clearInput(): void {
		this._attached.clear();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this._browserService.setVisible(visible && !!this._attached.value);
	}

	override layout(): void {
		// The docked window follows the body on its own (it checks a few times a second).
	}
}

class DovoBrowserInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.invokeFunction(accessor => accessor.get(IDovoBrowserService).input);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(browserTypeId, DovoBrowserInputSerializer);
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DovoBrowserEditor, DovoBrowserEditor.ID, localize('dovo.browser.editorLabel', "Browser")),
	[new SyncDescriptor(DovoBrowserInput)]
);

/** The activity bar's browser view: opening it opens the browser tab; it holds the controls. */
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
		renderPlaceholder(body, this._browserService, this._bodyStore);
		if (this.isBodyVisible()) {
			void this._browserService.open();
		}
	}
}

const browserContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: containerId,
	title: localize2('dovo.browser.containerTitle', "Firefox"),
	icon: Codicon.globe,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [containerId, { mergeViewWithContainerWhenSingleView: true }]),
	order: 8,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: viewId,
	name: localize2('dovo.browser.viewTitle', "Firefox"),
	containerIcon: Codicon.globe,
	ctorDescriptor: new SyncDescriptor(DovoBrowserView),
	canToggleVisibility: false,
	canMoveView: false,
}], browserContainer);

const browserFocused = ActiveEditorContext.isEqualTo(browserTypeId);
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
			id: 'dovo.browser.pickWindow',
			title: localize2('dovo.browser.pickWindowTitle', "Choose Browser Window"),
			category,
			f1: true,
			icon: Codicon.window,
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyW, when: browserFocused, weight: KeybindingWeight.WorkbenchContrib },
			menu: { id: MenuId.EditorTitle, when: browserFocused, group: 'navigation', order: 1 },
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IDovoBrowserService).pickWindow();
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
			menu: { id: MenuId.EditorTitle, when: browserFocused, group: 'navigation', order: 2 },
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
			title: localize2('dovo.browser.fullScreenTitle', "Toggle Browser Full Screen"),
			category,
			f1: true,
			icon: Codicon.screenFull,
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter, when: browserFocused, weight: KeybindingWeight.WorkbenchContrib },
			menu: { id: MenuId.EditorTitle, when: browserFocused, group: 'navigation', order: 3 },
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IDovoBrowserService).toggleFullScreen();
	}
});

/** Creates the service at startup, so web links open in the browser tab from the first click. */
class DovoBrowserLinks implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dovoBrowserLinks';
	constructor(@IDovoBrowserService _browserService: IDovoBrowserService) { }
}

registerWorkbenchContribution2(DovoBrowserLinks.ID, DovoBrowserLinks, WorkbenchPhase.AfterRestored);
