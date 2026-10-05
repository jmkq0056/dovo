/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IMautClaudeService } from '../../terminal/browser/mautClaude.js';
import './media/mautStartup.css';

/** The extension reports what it's doing while it gets Claude ready. */
const statusCommandId = '_maut.startup.status';
/** Contributed by the built-in `maut-claude-images` extension: installs Claude Code in a terminal. */
const installCommandId = '_maut.claude.install';
const giveUpAfter = 20_000;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'maut.window',
	title: localize('maut.window.title', "Dovo window"),
	type: 'object',
	properties: {
		'maut.window.openFullScreen': {
			type: 'boolean',
			default: true,
			markdownDescription: localize('maut.window.openFullScreen', "On macOS, open every window in full screen instead of at the size it had last time."),
		},
		'maut.startup.splash': {
			type: 'boolean',
			default: true,
			markdownDescription: localize('maut.startup.splash', "When a project opens and Dovo starts Claude for it, show the Dovo splash until Claude is ready."),
		},
	},
});

type StartupState = 'resuming' | 'starting' | 'skip' | 'failed';

/**
 * The splash: the Maut logo while Maut gets Claude ready for the project you opened (continuing
 * your last conversation, or starting a new one). It fades into the Claude layout when Claude is
 * up. If Claude can't start (not installed, say), it says so, offers to install it, and otherwise
 * steps aside for the normal editor. It never traps you: Escape or a click dismisses it, and it
 * gives up on its own after a while.
 */
class MautStartupSplash extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.mautcode.startupSplash';

	private _splash: HTMLElement | undefined;
	private _status: HTMLElement | undefined;
	private _actions: HTMLElement | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IConfigurationService configurationService: IConfigurationService,
		@IMautClaudeService private readonly _claudeService: IMautClaudeService,
		@ICommandService private readonly _commandService: ICommandService,
		@IThemeService private readonly _themeService: IThemeService,
	) {
		super();
		const folder = workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY;
		const autoLaunch = configurationService.getValue<boolean>('maut.autoLaunchClsp') !== false;
		if (!folder || !autoLaunch || configurationService.getValue<boolean>('maut.startup.splash') === false || _claudeService.hasClaude) {
			return;
		}
		this._show();
		this._register(CommandsRegistry.registerCommand(statusCommandId, (_accessor, state: StartupState, message?: string) => this._onStatus(state, message)));
		this._register(this._claudeService.onDidChange(() => {
			if (this._claudeService.hasClaude) {
				this._hide(250); // let the Claude layout settle under it first
			}
		}));
		const timer = mainWindow.setTimeout(() => this._hide(0), giveUpAfter);
		this._register(toDisposable(() => mainWindow.clearTimeout(timer)));
	}

	private _show(): void {
		const splash = this._splash = dom.$('.maut-splash');
		splash.setAttribute('role', 'status');
		splash.setAttribute('aria-live', 'polite');
		const center = dom.append(splash, dom.$('.maut-splash-center'));
		const logo = dom.append(center, dom.$<HTMLImageElement>('img.maut-splash-logo'));
		// The dark icon on dark themes, the bright one on light themes.
		const logoFile = isDark(this._themeService.getColorTheme().type) ? 'maut-logo-dark.png' : 'maut-logo.png';
		logo.src = FileAccess.asBrowserUri(`vs/workbench/contrib/mautcode/browser/media/${logoFile}`).toString(true);
		logo.alt = '';
		this._status = dom.append(center, dom.$('.maut-splash-status', undefined, localize('maut.splash.getting', "Getting Claude ready")));
		this._actions = dom.append(center, dom.$('.maut-splash-actions'));
		this._layoutService.mainContainer.appendChild(splash);
		this._register(toDisposable(() => splash.remove()));
		this._register(dom.addDisposableListener(splash, dom.EventType.CLICK, e => {
			if (!(e.target as HTMLElement).closest('button')) {
				this._hide(0);
			}
		}));
		this._register(dom.addDisposableListener(mainWindow, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				this._hide(0);
			}
		}));
	}

	private _onStatus(state: StartupState, message?: string): void {
		if (!this._splash || !this._status) {
			return;
		}
		switch (state) {
			case 'resuming':
				this._status.textContent = localize('maut.splash.resuming', "Continuing your last conversation");
				break;
			case 'starting':
				this._status.textContent = localize('maut.splash.starting', "Starting a new Claude session");
				break;
			case 'skip':
				this._hide(0);
				break;
			case 'failed':
				this._fail(message);
				break;
		}
	}

	/** Claude can't start: say why, offer to install it, or step aside for the normal editor. */
	private _fail(message: string | undefined): void {
		const splash = this._splash;
		const actions = this._actions;
		if (!splash || !actions || !this._status) {
			return;
		}
		splash.classList.add('failed');
		dom.clearNode(this._status);
		dom.append(this._status, dom.$('b', undefined, localize('maut.splash.notSetUp', "Claude Code isn't set up")));
		dom.append(this._status, dom.$('span', undefined, message || localize('maut.splash.notFound', "Dovo couldn't find the claude command.")));
		dom.clearNode(actions);
		const install = dom.append(actions, dom.$<HTMLButtonElement>('button.maut-splash-primary', { type: 'button' }, localize('maut.splash.install', "Install Claude Code")));
		const skip = dom.append(actions, dom.$<HTMLButtonElement>('button', { type: 'button' }, localize('maut.splash.continue', "Continue to the Editor")));
		this._register(dom.addDisposableListener(install, dom.EventType.CLICK, () => {
			this._hide(0);
			this._commandService.executeCommand(installCommandId);
		}));
		this._register(dom.addDisposableListener(skip, dom.EventType.CLICK, () => this._hide(0)));
		skip.focus();
	}

	private _hide(delay: number): void {
		const splash = this._splash;
		if (!splash || splash.classList.contains('leaving')) {
			return;
		}
		mainWindow.setTimeout(() => {
			splash.classList.add('leaving');
			mainWindow.setTimeout(() => {
				splash.remove();
				this._splash = undefined;
			}, 420);
		}, delay);
	}
}

registerWorkbenchContribution2(MautStartupSplash.ID, MautStartupSplash, WorkbenchPhase.BlockRestore);
