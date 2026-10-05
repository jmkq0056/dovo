/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Dovo: the welcome on first run. Five short steps (hello, light or dark, Claude Code, the keys
 *  worth knowing, done) in place of VS Code's own sign-in onboarding, which is switched off here.
 *
 *  It must never get in the way, so:
 *  - it is marked as seen the moment it opens: it can't come back on its own, even after a crash;
 *  - Escape, the close button and Skip always close it, whatever a step is doing;
 *  - every step is built inside a try: a step that fails says so and the rest still work;
 *  - everything that lives in an extension (theme, Claude check, installer) is reached through
 *    `callExtension`, which waits a bounded time for the extension, then gives up quietly and
 *    falls back (the theme) or explains (Claude), so a slow or failed extension degrades a step,
 *    never the flow;
 *  - Claude's auto-start on open waits for it (`_dovo.onboarding.whenDone`), so Claude starts
 *    with the choices made here; that wait always ends, because closing, disposal and failure
 *    all settle it.
 */

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { isWeb } from '../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import './media/dovoOnboarding.css';

/** Set once the welcome has been shown, so it never opens on its own again. */
const seenKey = 'dovo.onboarding.seen';
const showCommandId = 'dovo.welcome.show';
const whenDoneCommandId = '_dovo.onboarding.whenDone';
/** How long a step waits for an extension (theme, Claude check) before it carries on without it. */
const extensionPatience = 8_000;

// VS Code's own first-run onboarding is about GitHub sign-in and Copilot, which Dovo doesn't ship.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'workbench.welcomePage.experimentalOnboarding': false,
	},
	preventExperimentOverride: true,
}]);

/** Whether this launch opens the welcome by itself: a brand-new profile that hasn't seen it. */
export function isDovoWelcomePending(storageService: IStorageService, environmentService: IWorkbenchEnvironmentService): boolean {
	return !isWeb
		&& !environmentService.skipWelcome
		&& storageService.isNew(StorageScope.APPLICATION)
		&& !storageService.getBoolean(seenKey, StorageScope.APPLICATION, false);
}

/** The open welcome, if any. One at a time. */
let current: DovoWelcome | undefined;

/** Settles when no welcome is open: right away, or when the open one closes. Never rejects. */
CommandsRegistry.registerCommand(whenDoneCommandId, () => current?.closed ?? Promise.resolve());

/**
 * Runs a command that an extension contributes, waiting at most `patience` for the extension to
 * register it and for the command to finish. Resolves to undefined instead of failing.
 */
async function callExtension<T>(commandService: ICommandService, id: string, args: unknown[], patience = extensionPatience): Promise<T | undefined> {
	const store = new DisposableStore();
	try {
		if (!CommandsRegistry.getCommand(id)) {
			const registered = new Promise<void>(resolve => store.add(CommandsRegistry.onDidRegisterCommand(registeredId => {
				if (registeredId === id) {
					resolve();
				}
			})));
			await Promise.race([registered, timeout(patience)]);
			if (!CommandsRegistry.getCommand(id)) {
				return undefined;
			}
		}
		return await Promise.race([
			commandService.executeCommand<T>(id, ...args),
			timeout(patience).then(() => undefined),
		]);
	} catch {
		return undefined;
	} finally {
		store.dispose();
	}
}

type Mode = 'dark' | 'light';

interface IClaudeStatus {
	readonly installed: boolean;
	readonly version?: string;
	readonly problem?: string;
	readonly installCommand: string;
}

interface IChoice {
	readonly value: string;
	readonly label: string;
}

const fallbackInstallCommand = 'curl -fsSL https://claude.ai/install.sh | bash';

// Same choices as the Dovo panel's Claude section (maut-claude-images/src/claudeLaunch.ts).
const permissionModes: readonly IChoice[] = [
	{ value: 'acceptEdits', label: localize('dovo.welcome.mode.acceptEdits', "Accept edits: edits files, asks before running commands") },
	{ value: 'manual', label: localize('dovo.welcome.mode.manual', "Ask every time: asks before each edit and command") },
	{ value: 'plan', label: localize('dovo.welcome.mode.plan', "Plan first: changes nothing until you approve a plan") },
	{ value: 'auto', label: localize('dovo.welcome.mode.auto', "Auto: Claude decides what is safe without asking") },
	{ value: 'bypassPermissions', label: localize('dovo.welcome.mode.bypass', "Bypass: never asks, edits and runs commands freely") },
];
const models: readonly IChoice[] = [
	{ value: '', label: localize('dovo.welcome.model.default', "Default: your Claude Code /model choice") },
	{ value: 'opus', label: localize('dovo.welcome.model.opus', "Opus: the most capable") },
	{ value: 'sonnet', label: localize('dovo.welcome.model.sonnet', "Sonnet: fast and capable") },
	{ value: 'haiku', label: localize('dovo.welcome.model.haiku', "Haiku: the fastest") },
];

interface IStep {
	readonly id: string;
	readonly title: string;
	readonly build: (body: HTMLElement, store: DisposableStore) => void;
}

class DovoWelcome extends Disposable {

	private readonly _closed = new DeferredPromise<void>();
	/** Settles when the welcome closes, however it closes. */
	readonly closed = this._closed.p;

	private readonly _stepStore = this._register(new DisposableStore());
	private _overlay: HTMLElement | undefined;
	private _body: HTMLElement | undefined;
	private _dots: HTMLElement[] = [];
	private _back: HTMLButtonElement | undefined;
	private _next: HTMLButtonElement | undefined;
	private _index = 0;
	private readonly _steps: readonly IStep[];

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly _storageService: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IThemeService private readonly _themeService: IThemeService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._steps = [
			{ id: 'hello', title: localize('dovo.welcome.hello', "Welcome to Dovo"), build: body => this._buildHello(body) },
			{ id: 'look', title: localize('dovo.welcome.look', "Light or dark"), build: (body, store) => this._buildLook(body, store) },
			{ id: 'claude', title: localize('dovo.welcome.claude', "Claude Code"), build: (body, store) => this._buildClaude(body, store) },
			{ id: 'keys', title: localize('dovo.welcome.keys', "Worth knowing"), build: body => this._buildKeys(body) },
			{ id: 'done', title: localize('dovo.welcome.done', "You're set"), build: (body, store) => this._buildDone(body, store) },
		];
		// Whatever happens, anyone waiting on the welcome is released when it goes.
		this._register(toDisposable(() => {
			this._overlay?.remove();
			this._overlay = undefined;
			this._closed.complete();
			if (current === this) {
				current = undefined;
			}
		}));
	}

	show(): void {
		// Seen as soon as it opens: it can't trap anyone in a loop of welcomes, even if it breaks.
		this._storageService.store(seenKey, true, StorageScope.APPLICATION, StorageTarget.USER);
		try {
			this._render();
			this._go(0);
		} catch (error) {
			this._logService.error('[Dovo] The welcome could not open', error);
			this.dispose();
		}
	}

	private _render(): void {
		const overlay = this._overlay = dom.$('.dovo-welcome');
		const dialog = dom.append(overlay, dom.$('.dovo-welcome-dialog'));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-labelledby', 'dovo-welcome-title');
		dialog.tabIndex = -1;

		const head = dom.append(dialog, dom.$('.dovo-welcome-head'));
		const dots = dom.append(head, dom.$('.dovo-welcome-dots'));
		dots.setAttribute('aria-hidden', 'true');
		this._dots = this._steps.map(() => dom.append(dots, dom.$('i')));
		const close = dom.append(head, dom.$<HTMLButtonElement>('button.dovo-welcome-close', { type: 'button', title: localize('dovo.welcome.close', "Close"), 'aria-label': localize('dovo.welcome.close', "Close") }));
		close.textContent = '\u00d7';

		this._body = dom.append(dialog, dom.$('.dovo-welcome-body'));
		this._body.setAttribute('aria-live', 'polite');

		const foot = dom.append(dialog, dom.$('.dovo-welcome-foot'));
		const skip = dom.append(foot, dom.$<HTMLButtonElement>('button.dovo-welcome-link', { type: 'button' }, localize('dovo.welcome.skip', "Skip")));
		dom.append(foot, dom.$('span.dovo-welcome-spacer'));
		this._back = dom.append(foot, dom.$<HTMLButtonElement>('button.dovo-welcome-secondary', { type: 'button' }, localize('dovo.welcome.back', "Back")));
		this._next = dom.append(foot, dom.$<HTMLButtonElement>('button.dovo-welcome-primary', { type: 'button' }));

		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.dispose()));
		this._register(dom.addDisposableListener(skip, dom.EventType.CLICK, () => this.dispose()));
		this._register(dom.addDisposableListener(this._back, dom.EventType.CLICK, () => this._go(this._index - 1)));
		this._register(dom.addDisposableListener(this._next, dom.EventType.CLICK, () => this._index >= this._steps.length - 1 ? this.dispose() : this._go(this._index + 1)));
		// Capture phase, on the window: Escape closes it even if a step's control has focus or a
		// step stopped propagation. Tab stays inside the dialog.
		this._register(dom.addDisposableListener(mainWindow, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (!this._overlay) {
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.dispose();
			} else if (e.key === 'Tab') {
				this._trapTab(dialog, e);
			}
		}, true));

		this._layoutService.mainContainer.appendChild(overlay);
	}

	private _trapTab(dialog: HTMLElement, e: KeyboardEvent): void {
		const focusable: HTMLElement[] = [];
		const walk = (el: Element) => {
			for (const child of el.children) {
				if (dom.isHTMLButtonElement(child) || dom.isHTMLInputElement(child) || child.tagName === 'SELECT') {
					const control = child as HTMLButtonElement | HTMLInputElement | HTMLSelectElement;
					if (!control.disabled && control.offsetParent !== null) {
						focusable.push(control);
					}
				}
				walk(child);
			}
		};
		walk(dialog);
		if (!focusable.length) {
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = dialog.ownerDocument.activeElement;
		if (e.shiftKey && (active === first || !dialog.contains(active))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
			e.preventDefault();
			first.focus();
		}
	}

	private _go(index: number): void {
		const body = this._body;
		if (!body || !this._back || !this._next) {
			return;
		}
		this._index = Math.max(0, Math.min(index, this._steps.length - 1));
		const step = this._steps[this._index];
		this._stepStore.clear();
		dom.clearNode(body);
		body.dataset.step = step.id;
		this._dots.forEach((dot, i) => dot.classList.toggle('on', i <= this._index));
		dom.append(body, dom.$('h2#dovo-welcome-title', undefined, step.title));
		const content = dom.append(body, dom.$('.dovo-welcome-content'));
		try {
			step.build(content, this._stepStore);
		} catch (error) {
			// A broken step is skippable, not fatal.
			this._logService.error(`[Dovo] Welcome step "${step.id}" failed`, error);
			dom.clearNode(content);
			dom.append(content, dom.$('p.dovo-welcome-muted', undefined, localize('dovo.welcome.stepFailed', "This part couldn't load. You can carry on; nothing here is required.")));
		}
		this._back.style.visibility = this._index === 0 ? 'hidden' : '';
		this._next.textContent = this._index === 0
			? localize('dovo.welcome.start', "Get Started")
			: this._index === this._steps.length - 1 ? localize('dovo.welcome.finish', "Start Coding") : localize('dovo.welcome.next', "Next");
		this._next.focus();
	}

	// --- steps

	private _buildHello(body: HTMLElement): void {
		const logo = dom.append(body, dom.$<HTMLImageElement>('img.dovo-welcome-logo'));
		logo.src = FileAccess.asBrowserUri(`vs/workbench/contrib/mautcode/browser/media/${isDark(this._themeService.getColorTheme().type) ? 'maut-logo-dark.png' : 'maut-logo.png'}`).toString(true);
		logo.alt = '';
		dom.append(body, dom.$('p.dovo-welcome-lede', undefined, localize('dovo.welcome.lede', "The editor built for agentic coding. Claude Code works in your terminal; Dovo shows you what it's doing and keeps the full editor one keystroke away.")));
		const list = dom.append(body, dom.$('ul.dovo-welcome-points'));
		for (const point of [
			localize('dovo.welcome.point.reader', "Read the conversation like a chat, beside your code"),
			localize('dovo.welcome.point.changes', "See every change Claude makes, right in your files"),
			localize('dovo.welcome.point.yours', "It's still the editor you know: extensions, settings, keys"),
		]) {
			dom.append(list, dom.$('li', undefined, point));
		}
		dom.append(body, dom.$('p.dovo-welcome-muted', undefined, localize('dovo.welcome.time', "About a minute. Escape skips at any point.")));
	}

	private _buildLook(body: HTMLElement, store: DisposableStore): void {
		dom.append(body, dom.$('p', undefined, localize('dovo.welcome.look.p', "Dovo's Ember palette comes in two modes. You can switch any time.")));
		const row = dom.append(body, dom.$('.dovo-welcome-modes'));
		row.setAttribute('role', 'radiogroup');
		row.setAttribute('aria-label', localize('dovo.welcome.look.group', "Color mode"));
		const status = dom.$('p.dovo-welcome-muted');
		const cards = new Map<Mode, HTMLButtonElement>();
		const mark = (mode: Mode) => cards.forEach((card, m) => {
			card.classList.toggle('on', m === mode);
			card.setAttribute('aria-checked', String(m === mode));
		});
		for (const [mode, label] of [['dark', localize('dovo.welcome.dark', "Ember dark")], ['light', localize('dovo.welcome.light', "Ember light")]] as const) {
			const card = dom.append(row, dom.$<HTMLButtonElement>(`button.dovo-welcome-mode.${mode}`, { type: 'button', role: 'radio' }));
			const preview = dom.append(card, dom.$('.dovo-welcome-preview'));
			dom.append(preview, dom.$('i.bar'));
			for (let i = 0; i < 4; i++) {
				dom.append(preview, dom.$('i.line'));
			}
			dom.append(card, dom.$('span', undefined, label));
			cards.set(mode, card);
			store.add(dom.addDisposableListener(card, dom.EventType.CLICK, async () => {
				mark(mode);
				status.textContent = '';
				const applied = await callExtension<Mode>(this._commandService, '_maut.theme.setMode', [mode]);
				if (applied !== mode) {
					// Theme Studio isn't there (or too slow): fall back to the plain VS Code themes.
					try {
						await this._configurationService.updateValue('workbench.colorTheme', mode === 'light' ? 'Default Light Modern' : 'Default Dark Modern', ConfigurationTarget.USER);
						status.textContent = localize('dovo.welcome.look.fallback', "Theme Studio wasn't ready, so Dovo used the plain theme. Shift+Cmd+L applies Ember once it is.");
					} catch {
						status.textContent = localize('dovo.welcome.look.failed', "That didn't apply. Shift+Cmd+L switches modes later.");
					}
				}
			}));
		}
		mark(isDark(this._themeService.getColorTheme().type) ? 'dark' : 'light');
		// Only the shortcuts that exist right now (they belong to the Theme Studio extension).
		const shortcuts = ([['maut.theme.toggle', localize('dovo.welcome.look.toggle', "switches modes")], ['maut.theme.studio', localize('dovo.welcome.look.studio', "opens Theme Studio for colours and fonts")]] as const)
			.flatMap(([commandId, text]) => {
				const label = this._keybindingService.lookupKeybinding(commandId)?.getLabel();
				return label ? [{ label, text }] : [];
			});
		if (shortcuts.length) {
			const keys = dom.append(body, dom.$('p.dovo-welcome-muted'));
			shortcuts.forEach((shortcut, i) => {
				if (i) {
					dom.append(keys, keys.ownerDocument.createTextNode(' \u00b7 '));
				}
				dom.append(keys, dom.$('kbd', undefined, shortcut.label));
				dom.append(keys, keys.ownerDocument.createTextNode(` ${shortcut.text}`));
			});
		}
		dom.append(body, status);
	}

	private _buildClaude(body: HTMLElement, store: DisposableStore): void {
		const check = dom.append(body, dom.$('.dovo-welcome-check'));
		const runCheck = async () => {
			dom.clearNode(check);
			check.className = 'dovo-welcome-check pending';
			dom.append(check, dom.$('span', undefined, localize('dovo.welcome.claude.checking', "Looking for Claude Code\u2026")));
			const status = await callExtension<IClaudeStatus>(this._commandService, '_maut.claude.check', []);
			if (store.isDisposed) {
				return; // moved on to another step meanwhile
			}
			dom.clearNode(check);
			if (status?.installed) {
				check.className = 'dovo-welcome-check ok';
				dom.append(check, dom.$('b', undefined, localize('dovo.welcome.claude.found', "Claude Code is installed")));
				if (status.version) {
					dom.append(check, dom.$('span', undefined, status.version));
				}
				return;
			}
			check.className = 'dovo-welcome-check missing';
			dom.append(check, dom.$('b', undefined, status
				? localize('dovo.welcome.claude.missing', "Claude Code isn't installed yet")
				: localize('dovo.welcome.claude.unknown', "Couldn't check for Claude Code right now")));
			dom.append(check, dom.$('span', undefined, status?.problem ?? localize('dovo.welcome.claude.later', "Dovo checks again when it starts Claude. You can carry on.")));
			const command = status?.installCommand ?? fallbackInstallCommand;
			const code = dom.append(check, dom.$('.dovo-welcome-code'));
			dom.append(code, dom.$('code', undefined, command));
			const copy = dom.append(code, dom.$<HTMLButtonElement>('button.dovo-welcome-secondary', { type: 'button' }, localize('dovo.welcome.copy', "Copy")));
			store.add(dom.addDisposableListener(copy, dom.EventType.CLICK, async () => {
				try {
					await this._clipboardService.writeText(command);
					copy.textContent = localize('dovo.welcome.copied', "Copied");
				} catch { /* the command is on screen to copy by hand */ }
			}));
			const actions = dom.append(check, dom.$('.dovo-welcome-actions'));
			const install = dom.append(actions, dom.$<HTMLButtonElement>('button.dovo-welcome-primary', { type: 'button' }, localize('dovo.welcome.install', "Install in a Terminal")));
			const again = dom.append(actions, dom.$<HTMLButtonElement>('button.dovo-welcome-secondary', { type: 'button' }, localize('dovo.welcome.again', "Check Again")));
			store.add(dom.addDisposableListener(install, dom.EventType.CLICK, () => { void callExtension(this._commandService, '_maut.claude.install', []); }));
			store.add(dom.addDisposableListener(again, dom.EventType.CLICK, () => { void runCheck(); }));
		};
		void runCheck();

		dom.append(body, dom.$('h3', undefined, localize('dovo.welcome.claude.how', "How Claude starts")));
		const form = dom.append(body, dom.$('.dovo-welcome-form'));
		this._select(form, store, localize('dovo.welcome.claude.permissions', "Permissions"), 'maut.claude.permissionMode', 'bypassPermissions', permissionModes);
		this._select(form, store, localize('dovo.welcome.claude.model', "Model"), 'maut.claude.model', '', models);
		const auto = dom.append(form, dom.$('label.dovo-welcome-toggle'));
		const box = dom.append(auto, dom.$<HTMLInputElement>('input', { type: 'checkbox' }));
		box.checked = this._configurationService.getValue<boolean>('maut.autoLaunchClsp') !== false;
		dom.append(auto, dom.$('span', undefined, localize('dovo.welcome.claude.auto', "Start Claude when I open a project, continuing the last conversation")));
		store.add(dom.addDisposableListener(box, dom.EventType.CHANGE, () => this._write('maut.autoLaunchClsp', box.checked)));
		dom.append(body, dom.$('p.dovo-welcome-muted', undefined, localize('dovo.welcome.claude.later2', "All of this lives in the Dovo panel's Claude section too.")));
	}

	private _buildKeys(body: HTMLElement): void {
		const table = dom.append(body, dom.$('.dovo-welcome-keys'));
		const row = (commandId: string | undefined, text: string, keyText?: string) => {
			const label = keyText ?? (commandId ? this._keybindingService.lookupKeybinding(commandId)?.getLabel() : undefined);
			const line = dom.append(table, dom.$('.dovo-welcome-key'));
			dom.append(line, dom.$('span', undefined, text));
			if (label) {
				dom.append(line, dom.$('kbd', undefined, label));
			}
		};
		row('maut.claude.toggleHidden', localize('dovo.welcome.keys.column', "Hide or show Claude's column"));
		row(undefined, localize('dovo.welcome.keys.reader', "Reader shows the conversation; Terminal is the real CLI"), localize('dovo.welcome.keys.readerKey', "Reader / Terminal"));
		row('maut.finder.open', localize('dovo.welcome.keys.finder', "Find files and folders, and add them to Claude"));
		row(undefined, localize('dovo.welcome.keys.changes', "Changes Claude makes light up: green added, red removed. Step through them in the bar"), '\u2191 \u2193');
		row('maut.markdown.toggle', localize('dovo.welcome.keys.markdown', "Markdown preview"));
		row('workbench.action.showCommands', localize('dovo.welcome.keys.palette', "Every command, including the Dovo ones"));
	}

	private _buildDone(body: HTMLElement, store: DisposableStore): void {
		dom.append(body, dom.$('p.dovo-welcome-lede', undefined, localize('dovo.welcome.done.p', "That's it. Open a project and Claude is ready in the column on the right.")));
		if (this._workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			const actions = dom.append(body, dom.$('.dovo-welcome-actions'));
			const open = dom.append(actions, dom.$<HTMLButtonElement>('button.dovo-welcome-secondary', { type: 'button' }, localize('dovo.welcome.open', "Open a Folder\u2026")));
			store.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => {
				this.dispose();
				this._commandService.executeCommand('workbench.action.files.openFolder').catch(() => { /* the File menu does the same */ });
			}));
		}
		const again = dom.append(body, dom.$('p.dovo-welcome-muted'));
		dom.append(again, again.ownerDocument.createTextNode(localize('dovo.welcome.again.p', "See this again with the command ")));
		dom.append(again, dom.$('b', undefined, localize('dovo.welcome.again.cmd', "Dovo: Show Welcome")));
		dom.append(again, again.ownerDocument.createTextNode('.'));
	}

	// --- helpers

	private _select(parent: HTMLElement, store: DisposableStore, label: string, key: string, fallback: string, choices: readonly IChoice[]): void {
		const field = dom.append(parent, dom.$('label.dovo-welcome-field'));
		dom.append(field, dom.$('span', undefined, label));
		const select = dom.append(field, dom.$<HTMLSelectElement>('select'));
		const value = this._configurationService.getValue<string>(key) ?? fallback;
		const options = choices.some(choice => choice.value === value) ? choices : [...choices, { value, label: value }];
		for (const choice of options) {
			const option = dom.append(select, dom.$<HTMLOptionElement>('option', { value: choice.value }, choice.label));
			option.selected = choice.value === value;
		}
		store.add(dom.addDisposableListener(select, dom.EventType.CHANGE, () => this._write(key, select.value)));
	}

	private _write(key: string, value: unknown): void {
		this._configurationService.updateValue(key, value, ConfigurationTarget.USER).catch(error => this._logService.warn(`[Dovo] Couldn't save ${key}`, error));
	}
}

function openWelcome(instantiationService: IInstantiationService): void {
	if (current) {
		return;
	}
	const welcome = current = instantiationService.createInstance(DovoWelcome);
	welcome.show();
}

class DovoWelcomeOnFirstRun extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dovo.welcome';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@ILogService logService: ILogService,
	) {
		super();
		try {
			if (isDovoWelcomePending(storageService, environmentService)) {
				openWelcome(instantiationService);
			}
		} catch (error) {
			logService.error('[Dovo] The welcome could not start', error);
			current?.dispose();
		}
	}

	override dispose(): void {
		current?.dispose();
		super.dispose();
	}
}

registerWorkbenchContribution2(DovoWelcomeOnFirstRun.ID, DovoWelcomeOnFirstRun, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: showCommandId,
			title: localize2('dovo.welcome.show', "Show Welcome"),
			category: localize2('dovo.category', "Dovo"),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		openWelcome(accessor.get(IInstantiationService));
	}
});
