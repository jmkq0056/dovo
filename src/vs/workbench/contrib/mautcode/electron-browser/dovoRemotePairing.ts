/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService, IOpenContextView } from '../../../../platform/contextview/browser/contextView.js';
import { IsMacNativeContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import './media/dovoRemotePairing.css';

/** What the `maut-activity` extension reports (see its remotePairing.ts). */
interface IPairingInfo {
	readonly supported: boolean;
	readonly name: string;
	readonly user: string;
	readonly port: number;
	readonly hosts: readonly string[];
	readonly sharing: boolean;
	readonly host: boolean;
	readonly tailscale: boolean;
	readonly url: string;
	readonly modules: readonly string[];
}

const ACTION_ID = 'dovo.remote.pair';
const pairingCommandId = '_dovo.remote.pairing';
const sharingSettingsCommandId = '_dovo.remote.openSharingSettings';
/** While the panel is open it re-checks, so turning Screen Sharing on shows up right away. */
const refreshEvery = 3000;
/** White border around the code, in modules; scanners want at least four. */
const quietZone = 4;

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ACTION_ID,
			title: localize2('dovo.remote.pair', "Pair iPhone"),
			f1: true,
			category: localize2('dovo.category', "Dovo"),
			precondition: IsMacNativeContext,
			menu: [{
				id: MenuId.TitleBarAdjacentCenter,
				order: 2,
				when: IsMacNativeContext,
			}],
		});
	}
	override async run(): Promise<void> {
		DovoRemotePairing.instance?.toggle();
	}
});

/** The title bar's QR button and the panel it opens: scan once from Dovo Remote to pair the phone. */
class DovoRemotePairing extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dovoRemotePairing';
	static instance: DovoRemotePairing | undefined;

	private _anchor: HTMLElement | undefined;
	private _panel: IOpenContextView | undefined;

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
	) {
		super();
		DovoRemotePairing.instance = this;
		this._register({ dispose: () => DovoRemotePairing.instance = undefined });
		this._register(actionViewItemService.register(MenuId.TitleBarAdjacentCenter, ACTION_ID, (action, options) => instantiationService.createInstance(DovoRemotePairingItem, action, options, this)));
	}

	setAnchor(anchor: HTMLElement | undefined): void {
		this._anchor = anchor;
	}

	toggle(): void {
		if (this._panel) {
			this._panel.close();
			return;
		}
		const anchor = this._anchor;
		if (!anchor) {
			return;
		}
		anchor.classList.add('active');
		this._panel = this._contextViewService.showContextView({
			getAnchor: () => anchor,
			render: container => this._renderPanel(container),
			onHide: () => {
				anchor.classList.remove('active');
				this._panel = undefined;
			},
		});
	}

	private _renderPanel(container: HTMLElement): IDisposable {
		const store = new DisposableStore();
		const panel = dom.append(container, dom.$('.dovo-pair'));
		const head = dom.append(panel, dom.$('.dovo-pair-head'));
		dom.append(head, dom.$('b', undefined, localize('dovo.remote.title', "Control This Mac from Your iPhone")));
		dom.append(head, dom.$('span', undefined, localize('dovo.remote.subtitle', "Scan once with the Dovo Remote app or the Camera app. Keep this code private: it lets a phone control this Mac.")));
		const code = dom.append(panel, dom.$('.dovo-pair-code'));
		const canvas = dom.append(code, dom.$<HTMLCanvasElement>('canvas'));
		const name = dom.append(panel, dom.$('.dovo-pair-name'));
		const status = dom.append(panel, dom.$('.dovo-pair-status'));
		const reach = dom.append(panel, dom.$('.dovo-pair-status'));
		const hosts = dom.append(panel, dom.$('.dovo-pair-hosts'));

		let last = '';
		const refresh = async () => {
			const info = await this._commandService.executeCommand<IPairingInfo>(pairingCommandId);
			if (!info || store.isDisposed) {
				return;
			}
			const key = JSON.stringify(info);
			if (key === last) {
				return;
			}
			last = key;
			this._render(info, { canvas, name, status, reach, hosts, store });
		};
		void refresh();
		const timer = store.add(new IntervalTimer());
		timer.cancelAndSet(() => void refresh(), refreshEvery, dom.getWindow(container));
		return store;
	}

	private _render(info: IPairingInfo, parts: { canvas: HTMLCanvasElement; name: HTMLElement; status: HTMLElement; reach: HTMLElement; hosts: HTMLElement; store: DisposableStore }): void {
		const { canvas, name, status, reach, hosts, store } = parts;
		if (!info.supported) {
			dom.clearNode(name);
			name.textContent = localize('dovo.remote.macOnly', "Dovo Remote uses macOS Screen Sharing, so it works with Macs only.");
			canvas.style.display = 'none';
			return;
		}
		drawCode(canvas, info.modules);
		canvas.classList.toggle('dimmed', !info.host && !info.sharing);
		canvas.setAttribute('aria-label', localize('dovo.remote.codeLabel', "Pairing code for {0}", info.name));

		dom.clearNode(name);
		dom.append(name, dom.$('b', undefined, info.name));
		if (!info.host) {
			dom.append(name, dom.$('span', undefined, localize('dovo.remote.signIn', "Signs in as {0}", info.user)));
		}

		dom.clearNode(status);
		status.classList.toggle('off', !info.host && !info.sharing);
		if (info.host) {
			dom.append(status, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.check)}`));
			dom.append(status, dom.$('span', undefined, localize('dovo.remote.hostOn', "Dovo Remote Host is running: fast streaming, no password")));
		} else if (info.sharing) {
			dom.append(status, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.check)}`));
			dom.append(status, dom.$('span', undefined, localize('dovo.remote.sharingOn', "Screen Sharing is on. Dovo Remote Host isn't running, so the phone uses the slower Screen Sharing.")));
		} else {
			dom.append(status, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.warning)}`));
			dom.append(status, dom.$('span', undefined, localize('dovo.remote.sharingOff', "Screen Sharing is off. Turn it on, then scan.")));
			const button = dom.append(status, dom.$<HTMLButtonElement>('button', { type: 'button' }, localize('dovo.remote.openSettings', "Open Sharing Settings")));
			store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => void this._commandService.executeCommand(sharingSettingsCommandId)));
		}

		dom.clearNode(reach);
		dom.append(reach, dom.$(`span${ThemeIcon.asCSSSelector(info.tailscale ? Codicon.globe : Codicon.home)}`));
		dom.append(reach, dom.$('span', undefined, info.tailscale
			? localize('dovo.remote.anywhere', "Reachable from anywhere through Tailscale")
			: localize('dovo.remote.lanOnly', "Same Wi-Fi only. Install Tailscale on both devices to connect from anywhere.")));

		hosts.textContent = info.hosts.join('  ·  ');
	}
}

/** Draws the code black on white with its quiet zone, sharp at any pixel ratio. */
function drawCode(canvas: HTMLCanvasElement, modules: readonly string[]): void {
	const size = 196;
	const count = modules.length + quietZone * 2;
	const ratio = dom.getWindow(canvas).devicePixelRatio || 1;
	canvas.style.width = `${size}px`;
	canvas.style.height = `${size}px`;
	canvas.width = canvas.height = Math.round(size * ratio);
	const context = canvas.getContext('2d');
	if (!context) {
		return;
	}
	const cell = canvas.width / count;
	context.fillStyle = '#fff';
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.fillStyle = '#000';
	modules.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) {
			if (row[x] === '1') {
				context.fillRect(Math.floor((x + quietZone) * cell), Math.floor((y + quietZone) * cell), Math.ceil(cell), Math.ceil(cell));
			}
		}
	});
}

class DovoRemotePairingItem extends BaseActionViewItem {

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		private readonly _pairing: DovoRemotePairing,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		const button = dom.append(container, dom.$('.dovo-pair-button'));
		button.setAttribute('role', 'button');
		button.setAttribute('aria-label', localize('dovo.remote.button', "Pair iPhone"));
		button.tabIndex = 0;
		dom.append(button, qrIcon());
		this._pairing.setAnchor(button);
		this._register({ dispose: () => this._pairing.setAnchor(undefined) });
		this._register(this._hoverService.setupDelayedHover(button, { content: localize('dovo.remote.hover', "Control this Mac from your iPhone") }));
	}
}

/** A small QR glyph: three finder squares and a few modules, drawn in the text colour. */
function qrIcon(): SVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('aria-hidden', 'true');
	const rect = (x: number, y: number, size: number, filled: boolean) => {
		const element = document.createElementNS(ns, 'rect');
		element.setAttribute('x', String(filled ? x : x + .6));
		element.setAttribute('y', String(filled ? y : y + .6));
		element.setAttribute('width', String(filled ? size : size - 1.2));
		element.setAttribute('height', String(filled ? size : size - 1.2));
		element.setAttribute('rx', filled ? '.4' : '.8');
		element.setAttribute('class', filled ? 'fill' : 'stroke');
		svg.appendChild(element);
	};
	for (const [x, y] of [[1, 1], [10, 1], [1, 10]]) {
		rect(x, y, 5, false);
		rect(x + 1.8, y + 1.8, 1.4, true);
	}
	for (const [x, y] of [[10, 10], [13, 10], [11.5, 11.5], [10, 13], [13, 13], [8, 3], [8, 8], [3, 8]]) {
		rect(x, y, 1.6, true);
	}
	return svg;
}

registerWorkbenchContribution2(DovoRemotePairing.ID, DovoRemotePairing, WorkbenchPhase.AfterRestored);
