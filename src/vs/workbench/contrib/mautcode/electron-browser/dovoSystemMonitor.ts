/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction, toAction } from '../../../../base/common/actions.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import './media/dovoSystemMonitor.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

/** A sample from the `maut-activity` extension (see its systemStats.ts). Sizes in bytes, percentages 0..100. */
interface ISystemSample {
	readonly platform: string;
	readonly cpu: number;
	readonly cores: readonly number[];
	readonly load: readonly number[];
	readonly memory: {
		readonly total: number;
		readonly used: number;
		readonly app?: number;
		readonly wired?: number;
		readonly compressed?: number;
		readonly cached?: number;
		readonly pressure?: 'normal' | 'warn' | 'critical';
		readonly swapUsed?: number;
		readonly swapTotal?: number;
	};
	readonly dovo?: { readonly cpu: number; readonly memory: number; readonly processes: number };
	readonly thermal?: { readonly state: 'nominal' | 'fair' | 'serious' | 'critical'; readonly speedLimit?: number };
	readonly battery?: { readonly percent: number; readonly charging: boolean; readonly remaining?: string };
	readonly disk?: { readonly free: number; readonly total: number };
	readonly uptime: number;
}

const ACTION_ID = 'dovo.systemMonitor.show';
const SETTING = 'dovo.systemMonitor.enabled';
const sampleCommandId = '_dovo.systemMonitor.sample';
const openMonitorCommandId = '_dovo.systemMonitor.openActivityMonitor';
/** Sampling: every 2 s while Dovo has focus, every 10 s otherwise. */
const focusedEvery = 2000;
const unfocusedEvery = 10000;
/** CPU history kept for the sparkline. */
const historyLength = 24;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'dovo.systemMonitor',
	title: localize('dovo.systemMonitor.title', "Dovo System Monitor"),
	type: 'object',
	properties: {
		[SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('dovo.systemMonitor.enabled', "Show CPU, memory and thermal state next to the search bar in the title bar. Hover it for all the details."),
		},
	},
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ACTION_ID,
			title: localize2('dovo.systemMonitor.action', "System Monitor"),
			f1: false,
			menu: [{
				id: MenuId.TitleBarAdjacentCenter,
				order: 1,
				when: ContextKeyExpr.equals(`config.${SETTING}`, true),
			}],
		});
	}
	override async run(): Promise<void> { }
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dovo.systemMonitor.toggle',
			title: localize2('dovo.systemMonitor.toggle', "Toggle System Monitor in Title Bar"),
			category: localize2('dovo.category', "Dovo"),
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		await configurationService.updateValue(SETTING, configurationService.getValue<boolean>(SETTING) === false, ConfigurationTarget.USER);
	}
});

/** Samples the system while the readout shows, faster while Dovo has focus. */
class DovoSystemMonitor extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dovo.systemMonitor';

	private readonly _onDidSample = this._register(new Emitter<ISystemSample>());
	readonly onDidSample = this._onDidSample.event;
	private readonly _timer = this._register(new IntervalTimer());
	private _last: ISystemSample | undefined;
	readonly cpuHistory: number[] = [];

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IHostService private readonly _hostService: IHostService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.TitleBarAdjacentCenter, ACTION_ID, (action, options) => instantiationService.createInstance(DovoSystemMonitorItem, action, options, this)));
		this._register(this._hostService.onDidChangeFocus(() => this._schedule()));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING)) {
				this._schedule();
			}
		}));
		this._schedule();
	}

	get last(): ISystemSample | undefined {
		return this._last;
	}

	private _schedule(): void {
		if (this._configurationService.getValue<boolean>(SETTING) === false) {
			this._timer.cancel();
			return;
		}
		this._timer.cancelAndSet(() => this._sample(), this._hostService.hasFocus ? focusedEvery : unfocusedEvery);
		void this._sample();
	}

	private async _sample(): Promise<void> {
		let sample: ISystemSample | undefined;
		try {
			sample = await this._commandService.executeCommand<ISystemSample>(sampleCommandId);
		} catch {
			// The extension isn't up yet; the next tick tries again.
		}
		if (!sample) {
			return;
		}
		this._last = sample;
		this.cpuHistory.push(sample.cpu);
		if (this.cpuHistory.length > historyLength) {
			this.cpuHistory.shift();
		}
		this._onDidSample.fire(sample);
	}

	openActivityMonitor(): void {
		void this._commandService.executeCommand(openMonitorCommandId).then(undefined, () => { /* the extension isn't up */ });
	}

	async hide(): Promise<void> {
		await this._configurationService.updateValue(SETTING, false, ConfigurationTarget.USER);
	}
}

/** The readout next to the search bar: CPU with a sparkline, memory with a bar, thermal state. */
class DovoSystemMonitorItem extends BaseActionViewItem {

	private readonly _hoverContent = dom.$('.dovo-sysmon-hover');
	private _cpu: HTMLElement | undefined;
	private _spark: SVGPolylineElement | undefined;
	private _ram: HTMLElement | undefined;
	private _ramBar: HTMLElement | undefined;
	private _state: HTMLElement | undefined;
	private _battery: HTMLElement | undefined;
	private _batteryLevel: HTMLElement | undefined;
	private _batteryValue: HTMLElement | undefined;
	private _root: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		private readonly _monitor: DovoSystemMonitor,
		@IHoverService private readonly _hoverService: IHoverService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
	) {
		super(undefined, action, options);
		this.action.run = async () => this._monitor.openActivityMonitor();
		this._register(this._monitor.onDidSample(sample => this._update(sample)));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		const root = this._root = dom.append(container, dom.$('.dovo-sysmon'));
		root.setAttribute('role', 'button');
		root.setAttribute('aria-label', localize('dovo.systemMonitor.label', "System monitor. Click to open {0}.", activityMonitorName()));

		const cpu = dom.append(root, dom.$('span.dovo-sysmon-seg'));
		const svgNs = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNs, 'svg');
		svg.setAttribute('class', 'dovo-sysmon-spark');
		svg.setAttribute('viewBox', `0 0 ${historyLength - 1} 10`);
		svg.setAttribute('preserveAspectRatio', 'none');
		const line = this._spark = document.createElementNS(svgNs, 'polyline');
		svg.appendChild(line);
		cpu.appendChild(svg);
		this._cpu = dom.append(cpu, dom.$('span.dovo-sysmon-value.dovo-sysmon-cpu', undefined, '--'));

		const ram = dom.append(root, dom.$('span.dovo-sysmon-seg'));
		const bar = dom.append(ram, dom.$('span.dovo-sysmon-bar'));
		this._ramBar = dom.append(bar, dom.$('b'));
		this._ram = dom.append(ram, dom.$('span.dovo-sysmon-value.dovo-sysmon-ram', undefined, '--'));

		const state = dom.append(root, dom.$('span.dovo-sysmon-seg.dovo-sysmon-state'));
		dom.append(state, dom.$('i'));
		this._state = dom.append(state, dom.$('span.dovo-sysmon-value'));

		// Battery: a tiny battery filled to its level, the percentage, and a bolt while charging.
		const battery = this._battery = dom.append(root, dom.$('span.dovo-sysmon-seg.dovo-sysmon-battery.hidden'));
		const shell = dom.append(battery, dom.$('span.dovo-sysmon-battery-shell'));
		this._batteryLevel = dom.append(shell, dom.$('b'));
		this._batteryValue = dom.append(battery, dom.$('span.dovo-sysmon-value'));
		dom.append(battery, dom.$(`span.dovo-sysmon-bolt${ThemeIcon.asCSSSelector(Codicon.zap)}`));

		this._register(this._hoverService.setupDelayedHover(root, () => ({ content: this._hoverContent, appearance: { showPointer: true } })));
		this._register(dom.addDisposableListener(root, dom.EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			e.stopPropagation();
			this._contextMenuService.showContextMenu({
				getAnchor: () => new StandardMouseEvent(dom.getWindow(root), e),
				getActions: () => [
					toAction({ id: 'dovo.systemMonitor.open', label: localize('dovo.systemMonitor.open', "Open {0}", activityMonitorName()), run: () => this._monitor.openActivityMonitor() }),
					toAction({ id: 'dovo.systemMonitor.hide', label: localize('dovo.systemMonitor.hide', "Hide System Monitor"), run: () => this._monitor.hide() }),
				],
			});
		}));
		const last = this._monitor.last;
		if (last) {
			this._update(last);
		}
	}

	private _update(sample: ISystemSample): void {
		if (!this._root || !this._cpu || !this._ram || !this._ramBar || !this._state || !this._spark) {
			return;
		}
		const cpu = Math.round(sample.cpu);
		this._cpu.textContent = `${cpu}%`;
		this._cpu.classList.toggle('hot', cpu >= 80);
		const history = this._monitor.cpuHistory;
		const offset = historyLength - history.length;
		this._spark.setAttribute('points', history.map((value, i) => `${i + offset},${(10 - value / 10).toFixed(2)}`).join(' '));
		const memory = sample.memory;
		this._ram.textContent = localize('dovo.systemMonitor.ramShort', "{0}G", gb(memory.used));
		const ratio = memory.total ? memory.used / memory.total : 0;
		this._ramBar.style.width = `${Math.round(ratio * 100)}%`;
		const memoryHot = memory.pressure === 'warn' || memory.pressure === 'critical' || (!memory.pressure && ratio > 0.9);
		this._ram.classList.toggle('hot', memoryHot);
		this._ramBar.classList.toggle('hot', memoryHot);
		const thermal = sample.thermal?.state;
		this._state.parentElement!.classList.toggle('hidden', !thermal);
		// Just a dot while all is well; the word only when the Mac runs warm.
		this._state.textContent = thermal && thermal !== 'nominal' ? thermalLabel(thermal) : '';
		this._state.parentElement!.classList.toggle('hot', thermal === 'serious' || thermal === 'critical');
		const battery = sample.battery;
		if (this._battery && this._batteryLevel && this._batteryValue) {
			this._battery.classList.toggle('hidden', !battery);
			if (battery) {
				this._batteryLevel.style.width = `${Math.max(4, Math.min(100, battery.percent))}%`;
				this._batteryValue.textContent = `${battery.percent}%`;
				this._battery.classList.toggle('charging', battery.charging);
				this._battery.classList.toggle('hot', !battery.charging && battery.percent <= 15);
			}
		}
		this._renderHover(sample);
	}

	/** Every metric, in plain rows. Rebuilt in place, so an open hover updates live. */
	private _renderHover(sample: ISystemSample): void {
		const content = this._hoverContent;
		dom.clearNode(content);
		const section = (title: string) => dom.append(content, dom.$('.dovo-sysmon-hover-title', undefined, title));
		const row = (label: string, value: string, hot = false) => {
			const element = dom.append(content, dom.$('.dovo-sysmon-hover-row'));
			dom.append(element, dom.$('span', undefined, label));
			dom.append(element, dom.$(`span.dovo-sysmon-hover-value${hot ? '.hot' : ''}`, undefined, value));
		};

		section(localize('dovo.systemMonitor.cpuTitle', "CPU"));
		row(localize('dovo.systemMonitor.cpuTotal', "Total"), `${Math.round(sample.cpu)}%`, sample.cpu >= 80);
		const busiest = sample.cores.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value).slice(0, 4);
		row(localize('dovo.systemMonitor.cores', "Busiest cores ({0} in all)", sample.cores.length), busiest.map(core => `#${core.index + 1} ${Math.round(core.value)}%`).join('  '));
		if (!isWindows) {
			row(localize('dovo.systemMonitor.load', "Load average 1 / 5 / 15 min"), sample.load.map(value => value.toFixed(2)).join(' / '));
		}

		const memory = sample.memory;
		section(localize('dovo.systemMonitor.memoryTitle', "Memory"));
		row(localize('dovo.systemMonitor.memoryUsed', "Used"), localize('dovo.systemMonitor.ofTotal', "{0} of {1}", size(memory.used), size(memory.total)));
		if (memory.app !== undefined) {
			row(localize('dovo.systemMonitor.app', "App memory"), size(memory.app));
		}
		if (memory.wired !== undefined) {
			row(localize('dovo.systemMonitor.wired', "Wired"), size(memory.wired));
		}
		if (memory.compressed !== undefined) {
			row(localize('dovo.systemMonitor.compressed', "Compressed"), size(memory.compressed));
		}
		if (memory.cached !== undefined) {
			row(localize('dovo.systemMonitor.cached', "Cached files and purgeable"), size(memory.cached));
		}
		if (memory.pressure) {
			row(localize('dovo.systemMonitor.pressure', "Memory pressure"), pressureLabel(memory.pressure), memory.pressure !== 'normal');
		}
		if (memory.swapUsed !== undefined) {
			row(localize('dovo.systemMonitor.swap', "Swap used"), memory.swapTotal ? localize('dovo.systemMonitor.ofTotal', "{0} of {1}", size(memory.swapUsed), size(memory.swapTotal)) : size(memory.swapUsed));
		}

		if (sample.dovo) {
			section(localize('dovo.systemMonitor.dovoTitle', "Dovo"));
			row(localize('dovo.systemMonitor.dovoCpu', "CPU (all {0} processes)", sample.dovo.processes), `${Math.round(sample.dovo.cpu)}%`);
			row(localize('dovo.systemMonitor.dovoMemory', "Memory"), size(sample.dovo.memory));
		}

		section(localize('dovo.systemMonitor.systemTitle', "System"));
		if (sample.thermal) {
			row(localize('dovo.systemMonitor.thermal', "Thermal state"), sample.thermal.speedLimit ? localize('dovo.systemMonitor.throttled', "{0}, CPU limited to {1}%", thermalLabel(sample.thermal.state), sample.thermal.speedLimit) : thermalLabel(sample.thermal.state), sample.thermal.state === 'serious' || sample.thermal.state === 'critical');
		}
		if (sample.battery) {
			const battery = sample.battery;
			const state = battery.charging ? localize('dovo.systemMonitor.charging', "charging") : battery.remaining ? localize('dovo.systemMonitor.remaining', "{0} left", battery.remaining) : localize('dovo.systemMonitor.onBattery', "on battery");
			row(localize('dovo.systemMonitor.battery', "Battery"), `${battery.percent}% · ${state}`, !battery.charging && battery.percent <= 15);
		}
		if (sample.disk) {
			row(localize('dovo.systemMonitor.disk', "Disk free"), localize('dovo.systemMonitor.ofTotal', "{0} of {1}", size(sample.disk.free), size(sample.disk.total)), sample.disk.free / sample.disk.total < 0.05);
		}
		row(localize('dovo.systemMonitor.uptime', "Uptime"), uptime(sample.uptime));
		if (isMacintosh) {
			dom.append(content, dom.$('.dovo-sysmon-hover-note', undefined, localize('dovo.systemMonitor.tempNote', "Thermal state is what macOS reports to apps. The exact CPU temperature in degrees needs administrator rights on Apple silicon, so Dovo doesn't read it.")));
		}
		dom.append(content, dom.$('.dovo-sysmon-hover-note', undefined, localize('dovo.systemMonitor.clickNote', "Click to open {0}. Right-click to hide.", activityMonitorName())));
	}
}

function activityMonitorName(): string {
	return isWindows ? localize('dovo.systemMonitor.taskManager', "Task Manager") : localize('dovo.systemMonitor.activityMonitor', "Activity Monitor");
}

function gb(bytes: number): string {
	return (bytes / 1024 ** 3).toFixed(1);
}

function size(bytes: number): string {
	if (bytes >= 1024 ** 4) {
		return localize('dovo.systemMonitor.tb', "{0} TB", (bytes / 1024 ** 4).toFixed(1));
	}
	if (bytes >= 1024 ** 3) {
		return localize('dovo.systemMonitor.gb', "{0} GB", (bytes / 1024 ** 3).toFixed(1));
	}
	return localize('dovo.systemMonitor.mb', "{0} MB", Math.round(bytes / 1024 ** 2));
}

function uptime(seconds: number): string {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return days ? localize('dovo.systemMonitor.uptimeDays', "{0} d {1} h", days, hours) : localize('dovo.systemMonitor.uptimeHours', "{0} h {1} min", hours, minutes);
}

function thermalLabel(state: 'nominal' | 'fair' | 'serious' | 'critical'): string {
	switch (state) {
		case 'nominal': return localize('dovo.systemMonitor.nominal', "Normal");
		case 'fair': return localize('dovo.systemMonitor.fair', "Warm");
		case 'serious': return localize('dovo.systemMonitor.serious', "Hot");
		case 'critical': return localize('dovo.systemMonitor.critical', "Critical");
	}
}

function pressureLabel(pressure: 'normal' | 'warn' | 'critical'): string {
	switch (pressure) {
		case 'normal': return localize('dovo.systemMonitor.pressureNormal', "Normal");
		case 'warn': return localize('dovo.systemMonitor.pressureWarn', "Elevated");
		case 'critical': return localize('dovo.systemMonitor.pressureCritical', "Critical");
	}
}

registerWorkbenchContribution2(DovoSystemMonitor.ID, DovoSystemMonitor, WorkbenchPhase.AfterRestored);
