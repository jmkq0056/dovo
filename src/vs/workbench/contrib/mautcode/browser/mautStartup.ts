/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IMautClaudeService } from '../../terminal/browser/mautClaude.js';
import { isDovoWelcomePending } from './dovoOnboarding.js';
import './media/mautStartup.css';

/** The extension reports what it's doing while it gets Claude ready. */
const statusCommandId = '_maut.startup.status';
/** Contributed by the built-in `maut-claude-images` extension: installs Claude Code in a terminal. */
const installCommandId = '_maut.claude.install';
/** The splash's whole show, from appearing to gone, unless Claude can't start. */
const splashDuration = 2_200;
/** How long the fade out takes, within {@link splashDuration}. */
const leaveDuration = 380;
/** When the icon is in and the word starts typing. */
const typeStart = 380;
/** Per letter. */
const typeStep = 100;
const word = 'DOVO';
/** Survives a window reload (unlike module state), so the splash shows once per window. */
const shownKey = 'dovo.startupSplash.shown';

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
			markdownDescription: localize('maut.startup.splash', "When a window opens a project and Dovo starts Claude for it, show the short Dovo splash."),
		},
	},
});

type StartupState = 'resuming' | 'starting' | 'skip' | 'failed';

/** Whether this window has shown the splash before (a reload keeps the same window). */
function alreadyShown(): boolean {
	try {
		if (mainWindow.sessionStorage.getItem(shownKey)) {
			return true;
		}
		mainWindow.sessionStorage.setItem(shownKey, '1');
	} catch {
		// No session storage: fall back to showing it, it still runs only at window open.
	}
	return false;
}

/**
 * The splash, once when a window opens a project: the Dovo icon eases in, "DOVO" types itself,
 * a line says what Claude is doing (continuing your last conversation or starting a new one), and
 * it lifts away into the workbench. All of it takes {@link splashDuration} at most, whether or not
 * Claude is up yet. Only if Claude can't start (not installed, say) does it stay, to say so and
 * offer to install it. Escape or a click dismisses it at any time.
 */
class MautStartupSplash extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.mautcode.startupSplash';

	private _splash: HTMLElement | undefined;
	private _typed: HTMLElement | undefined;
	private _status: HTMLElement | undefined;
	private _actions: HTMLElement | undefined;
	private readonly _timers = this._register(new DisposableStore());

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IConfigurationService configurationService: IConfigurationService,
		@IMautClaudeService claudeService: IMautClaudeService,
		@ICommandService private readonly _commandService: ICommandService,
		@IThemeService private readonly _themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		// The first-run welcome comes first; Claude starts once it closes, without the splash.
		if (isDovoWelcomePending(storageService, environmentService)) {
			return;
		}
		const folder = workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY;
		const autoLaunch = configurationService.getValue<boolean>('maut.autoLaunchClsp') !== false;
		if (!folder || !autoLaunch || configurationService.getValue<boolean>('maut.startup.splash') === false || claudeService.hasClaude || alreadyShown()) {
			return;
		}
		this._show();
		this._register(CommandsRegistry.registerCommand(statusCommandId, (_accessor, state: StartupState, message?: string) => this._onStatus(state, message)));
	}

	private _later(delay: number, run: () => void): void {
		const timer = mainWindow.setTimeout(run, delay);
		this._timers.add(toDisposable(() => mainWindow.clearTimeout(timer)));
	}

	private _show(): void {
		const reduceMotion = mainWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const splash = this._splash = dom.$('.maut-splash');
		splash.setAttribute('role', 'status');
		splash.setAttribute('aria-live', 'polite');
		splash.setAttribute('aria-label', word);
		const center = dom.append(splash, dom.$('.maut-splash-center'));
		const mark = dom.append(center, dom.$('.maut-splash-mark'));
		const logo = dom.append(mark, dom.$<HTMLImageElement>('img.maut-splash-logo'));
		// The dark icon on dark themes, the bright one on light themes.
		const logoFile = isDark(this._themeService.getColorTheme().type) ? 'maut-logo-dark.png' : 'maut-logo.png';
		logo.alt = '';
		logo.draggable = false;
		logo.onerror = () => mark.classList.add('no-image');
		logo.src = FileAccess.asBrowserUri(`vs/workbench/contrib/mautcode/browser/media/${logoFile}`).toString(true);

		// The word types into a box sized for the whole word, so nothing shifts as it grows.
		const wordBox = dom.append(center, dom.$('.maut-splash-word'));
		wordBox.setAttribute('aria-hidden', 'true');
		dom.append(wordBox, dom.$('span.maut-splash-word-ghost', undefined, word));
		const line = dom.append(wordBox, dom.$('span.maut-splash-word-line'));
		this._typed = dom.append(line, dom.$('span.maut-splash-typed'));
		dom.append(line, dom.$('span.maut-splash-cursor'));

		this._status = dom.append(center, dom.$('.maut-splash-status', undefined, localize('maut.splash.getting', "Getting Claude ready")));
		this._actions = dom.append(center, dom.$('.maut-splash-actions'));
		this._layoutService.mainContainer.appendChild(splash);
		this._register(toDisposable(() => splash.remove()));
		this._register(dom.addDisposableListener(splash, dom.EventType.CLICK, e => {
			if (!(e.target as HTMLElement).closest('button')) {
				this._hide();
			}
		}));
		this._register(dom.addDisposableListener(mainWindow, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && this._splash) {
				this._hide();
			}
		}));

		if (reduceMotion) {
			splash.classList.add('typed', 'settled');
			this._typed.textContent = word;
		} else {
			for (let i = 1; i <= word.length; i++) {
				this._later(typeStart + i * typeStep, () => {
					if (this._typed) {
						this._typed.textContent = word.slice(0, i);
					}
				});
			}
			this._later(typeStart + (word.length + 1) * typeStep, () => splash.classList.add('typed'));
			this._later(typeStart + (word.length + 2) * typeStep, () => splash.classList.add('settled'));
		}
		// Done in splashDuration, Claude ready or not; only a failure keeps it up.
		this._later(splashDuration - leaveDuration, () => this._hide());
	}

	private _onStatus(state: StartupState, message?: string): void {
		if (!this._splash || !this._status || this._splash.classList.contains('leaving')) {
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
				this._hide();
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
		this._timers.clear();
		if (this._typed) {
			this._typed.textContent = word;
		}
		splash.classList.add('failed', 'typed', 'settled');
		dom.clearNode(this._status);
		dom.append(this._status, dom.$('b', undefined, localize('maut.splash.notSetUp', "Claude Code isn't set up")));
		dom.append(this._status, dom.$('span', undefined, message || localize('maut.splash.notFound', "Dovo couldn't find the claude command.")));
		dom.clearNode(actions);
		const install = dom.append(actions, dom.$<HTMLButtonElement>('button.maut-splash-primary', { type: 'button' }, localize('maut.splash.install', "Install Claude Code")));
		const skip = dom.append(actions, dom.$<HTMLButtonElement>('button', { type: 'button' }, localize('maut.splash.continue', "Continue to the Editor")));
		this._register(dom.addDisposableListener(install, dom.EventType.CLICK, () => {
			this._hide();
			this._commandService.executeCommand(installCommandId);
		}));
		this._register(dom.addDisposableListener(skip, dom.EventType.CLICK, () => this._hide()));
		skip.focus();
	}

	/** Lifts it away. A failure has no timer, so it stays until a button, Escape or a click. */
	private _hide(): void {
		const splash = this._splash;
		if (!splash || splash.classList.contains('leaving')) {
			return;
		}
		this._timers.clear();
		splash.classList.add('leaving');
		const timer = mainWindow.setTimeout(() => {
			splash.remove();
			this._splash = undefined;
			this._typed = undefined;
			this._status = undefined;
		}, leaveDuration);
		this._register(toDisposable(() => mainWindow.clearTimeout(timer)));
	}
}

registerWorkbenchContribution2(MautStartupSplash.ID, MautStartupSplash, WorkbenchPhase.BlockRestore);
