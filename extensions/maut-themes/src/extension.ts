/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Maut Theme Studio: visual theme/font customiser.
 *
 *    - Lives as a sidebar view inside the Maut activity bar container,
 *      next to Maut Activity. Open the Maut activity icon  →  Theme
 *      Studio expands directly in the sidebar (no editor tab).
 *    - The user configures TWO snapshots (light and dark) independently;
 *      both are remembered. Pressing Shift+Cmd+L (or the editor toolbar
 *      sun/moon button) flips the active mode and applies that mode's
 *      saved snapshot — nothing is clobbered.
 *    - Font choices are written to every documented font setting (editor,
 *      terminal, debug console, scm, notebook, markdown preview, chat) and
 *      ALSO to  maut.workbenchFontFamily / maut.workbenchFontSize, which
 *      the workbench reads at startup to override the UI chrome font.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type Mode = 'dark' | 'light';

interface Snapshot {
	mode: Mode;
	accent: string;
	tint: string;
	fontFamily: string;
	fontSize: number;
}

interface NamedSnapshot extends Snapshot {
	name: string;
}

interface ThemeState {
	active: Mode;
	light: Snapshot;
	dark: Snapshot;
}

const DEFAULT_DARK: Snapshot = {
	mode: 'dark',
	accent: '#f59e0b',
	tint: '#1f1a1d',
	fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
	fontSize: 13,
};

const DEFAULT_LIGHT: Snapshot = {
	mode: 'light',
	accent: '#c2410c',
	tint: '#f3eee6',
	fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
	fontSize: 13,
};

const DEFAULT_STATE: ThemeState = {
	active: 'dark',
	light: DEFAULT_LIGHT,
	dark: DEFAULT_DARK,
};

const PRESETS: NamedSnapshot[] = [
	{ name: 'Ember dark', mode: 'dark', accent: '#f59e0b', tint: '#1f1a1d', fontFamily: DEFAULT_DARK.fontFamily, fontSize: 13 },
	{ name: 'Midnight blue', mode: 'dark', accent: '#5b8def', tint: '#161b22', fontFamily: DEFAULT_DARK.fontFamily, fontSize: 13 },
	{ name: 'Forest', mode: 'dark', accent: '#8ac926', tint: '#1a1f1a', fontFamily: DEFAULT_DARK.fontFamily, fontSize: 13 },
	{ name: 'Sand light', mode: 'light', accent: '#b6541f', tint: '#faf6ef', fontFamily: DEFAULT_LIGHT.fontFamily, fontSize: 13 },
	{ name: 'Paper light', mode: 'light', accent: '#1a73e8', tint: '#fdfdfd', fontFamily: DEFAULT_LIGHT.fontFamily, fontSize: 13 },
];

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const m = /^#?([a-f\d]{6})$/i.exec(hex.trim());
	if (!m) {
		return { r: 198, g: 42, b: 71 };
	}
	const n = parseInt(m[1], 16);
	return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToHex(r: number, g: number, b: number): string {
	const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
	return `#${h(r)}${h(g)}${h(b)}`;
}

function withAlpha(hex: string, alpha: number): string {
	const a = clamp(Math.round(alpha * 255), 0, 255).toString(16).padStart(2, '0');
	return `${hex}${a}`;
}

function mix(a: string, b: string, t: number): string {
	const ra = hexToRgb(a);
	const rb = hexToRgb(b);
	return rgbToHex(
		ra.r + (rb.r - ra.r) * t,
		ra.g + (rb.g - ra.g) * t,
		ra.b + (rb.b - ra.b) * t,
	);
}

function lighten(hex: string, amount: number): string {
	return mix(hex, '#ffffff', amount);
}

function darken(hex: string, amount: number): string {
	return mix(hex, '#000000', amount);
}

function buildPalette(snap: Snapshot): Record<string, string> {
	const isLight = snap.mode === 'light';
	const accent = snap.accent;
	const accentHover = isLight ? darken(accent, 0.10) : lighten(accent, 0.10);

	// Mix a tiny bit of accent into the chrome surfaces so light mode reads as
	// "Dovo light" rather than "VS Code Light with a red border". Keep it subtle
	// (~2%) so the cream doesn't tip into pink. Borders carry slightly more accent
	// so edges show the brand all the way through the UI.
	const base = snap.tint;
	const chrome = isLight ? mix(darken(base, 0.05), accent, 0.02) : lighten(base, 0.04);
	const chromeHi = isLight ? mix(darken(base, 0.09), accent, 0.025) : lighten(base, 0.07);
	const surface = isLight ? darken(base, 0.03) : lighten(base, 0.04);
	const surfaceHi = isLight ? darken(base, 0.07) : lighten(base, 0.08);
	const border = isLight ? mix(darken(base, 0.12), accent, 0.06) : lighten(base, 0.12);

	// Light mode stays off pure white and pure black: a warm paper ground, ink
	// that is dark but not harsh, and inputs only a step lighter than the page.
	const fg = isLight ? '#2b2724' : '#f0f0f8';
	const fgMuted = isLight ? '#5f5850' : '#a8a8bb';
	const fgSubtle = isLight ? '#8c847a' : '#6868a0';
	const inputBg = isLight ? lighten(base, 0.35) : darken(base, 0.04);

	return {
		'focusBorder': accent,
		'foreground': fg,
		'editorGutter.background': base,
		'editorGroup.border': border,
		'editorPane.background': base,
		'welcomePage.background': base,
		'descriptionForeground': fgMuted,
		'errorForeground': isLight ? '#c62a47' : '#e8465f',
		'selection.background': withAlpha(accent, 0.33),
		'contrastBorder': isLight ? withAlpha('#000000', 0.06) : withAlpha('#ffffff', 0.06),

		'editor.background': base,
		'editor.foreground': fg,
		'editor.selectionBackground': withAlpha(accent, 0.28),
		'editor.selectionHighlightBackground': withAlpha(accent, 0.14),
		'editor.findMatchBackground': withAlpha(accent, 0.30),
		'editor.findMatchHighlightBackground': withAlpha(accent, 0.18),
		'editor.lineHighlightBackground': isLight ? withAlpha('#000000', 0.035) : surface,
		'editor.lineHighlightBorder': '#00000000',
		'editorCursor.foreground': accent,
		'editorLineNumber.foreground': fgSubtle,
		'editorLineNumber.activeForeground': accent,
		'editorIndentGuide.background1': isLight ? darken(base, 0.05) : lighten(base, 0.05),
		'editorIndentGuide.activeBackground1': isLight ? darken(base, 0.12) : lighten(base, 0.12),
		'editorWidget.background': surface,
		'editorWidget.border': border,
		'editorHoverWidget.background': surface,
		'editorHoverWidget.border': border,
		'editorSuggestWidget.background': surface,
		'editorSuggestWidget.border': border,
		'editorSuggestWidget.selectedBackground': withAlpha(accent, 0.25),
		'editorBracketMatch.background': withAlpha(accent, 0.15),
		'editorBracketMatch.border': withAlpha(accent, 0.40),

		'editorGroupHeader.tabsBackground': chrome,
		'editorGroupHeader.tabsBorder': border,
		'editorGroupHeader.border': border,
		'tab.activeBackground': base,
		'tab.inactiveBackground': chrome,
		'tab.activeForeground': fg,
		'tab.inactiveForeground': fgMuted,
		'tab.activeBorderTop': accent,
		'tab.activeBorder': '#00000000',
		'tab.border': border,
		'tab.hoverBackground': isLight ? lighten(chrome, 0.03) : darken(chrome, 0.03),

		'titleBar.activeBackground': chrome,
		'titleBar.activeForeground': fg,
		'titleBar.inactiveBackground': chrome,
		'titleBar.inactiveForeground': fgMuted,
		'titleBar.border': border,

		'activityBar.background': chrome,
		'activityBar.foreground': fg,
		'activityBar.inactiveForeground': fgSubtle,
		'activityBar.activeBorder': accent,
		'activityBar.activeBackground': '#00000000',
		'activityBar.border': border,
		'activityBarBadge.background': accent,
		'activityBarBadge.foreground': '#ffffff',

		// The "Top" activity bar variant is what renders when the activity bar is
		// positioned at the top or shows in a pane composite. Without explicit
		// values the active-item bg falls back to weird values (a dark block in
		// light mode). Force these to chrome so the active item blends with the bar.
		'activityBarTop.background': chrome,
		'activityBarTop.foreground': fg,
		'activityBarTop.inactiveForeground': fgSubtle,
		'activityBarTop.activeBackground': '#00000000',
		'activityBarTop.activeBorder': accent,

		'sideBar.background': chrome,
		'sideBar.foreground': fgMuted,
		'sideBar.border': border,
		'sideBarSectionHeader.background': chromeHi,
		'sideBarSectionHeader.foreground': fg,
		'sideBarSectionHeader.border': border,
		'sideBarTitle.foreground': fg,

		'panel.background': chrome,
		'panel.border': border,
		'panelTitle.activeBorder': accent,
		'panelTitle.activeForeground': fg,
		'panelTitle.inactiveForeground': fgMuted,
		'panelInput.border': border,

		'statusBar.background': chrome,
		'statusBar.foreground': fgMuted,
		'statusBar.border': border,
		'statusBar.noFolderBackground': chrome,
		'statusBar.debuggingBackground': accent,
		'statusBar.debuggingForeground': '#ffffff',
		'statusBarItem.hoverBackground': isLight ? withAlpha('#000000', 0.06) : withAlpha('#ffffff', 0.08),
		'statusBarItem.remoteBackground': accent,
		'statusBarItem.remoteForeground': '#ffffff',
		'statusBarItem.prominentBackground': withAlpha(accent, 0.18),
		'statusBarItem.prominentForeground': fg,

		'terminal.background': base,
		'terminal.foreground': fg,
		'terminal.selectionBackground': withAlpha(accent, 0.28),
		'terminalCursor.foreground': accent,

		'button.background': accent,
		'button.foreground': '#ffffff',
		'button.hoverBackground': accentHover,
		'button.secondaryBackground': surface,
		'button.secondaryForeground': fg,
		'button.secondaryHoverBackground': surfaceHi,

		'input.background': inputBg,
		'input.foreground': fg,
		'input.border': border,
		'input.placeholderForeground': fgSubtle,
		'inputOption.activeBorder': accent,
		'inputOption.activeBackground': withAlpha(accent, 0.18),
		'inputOption.activeForeground': fg,
		'inputValidation.errorBackground': isLight ? '#ffeef0' : '#3a1a20',
		'inputValidation.errorBorder': isLight ? '#c62a47' : '#e8465f',

		'dropdown.background': inputBg,
		'dropdown.foreground': fg,
		'dropdown.border': border,
		'dropdown.listBackground': inputBg,

		'list.activeSelectionBackground': isLight ? withAlpha(accent, 0.16) : surface,
		'list.activeSelectionForeground': isLight ? darken(accent, 0.12) : lighten(accent, 0.12),
		'list.inactiveSelectionBackground': isLight ? withAlpha(accent, 0.08) : surface,
		'list.inactiveSelectionForeground': fg,
		'list.hoverBackground': isLight ? withAlpha(accent, 0.05) : surface,
		'list.hoverForeground': fg,
		'list.focusBackground': isLight ? withAlpha(accent, 0.12) : surface,
		'list.focusForeground': fg,
		'list.focusOutline': accent,
		'list.highlightForeground': accent,

		'menu.background': inputBg,
		'menu.foreground': fg,
		'menu.border': border,
		'menu.separatorBackground': border,
		'menu.selectionBackground': accent,
		'menu.selectionForeground': '#ffffff',
		'menubar.selectionBackground': withAlpha(accent, 0.25),
		'menubar.selectionForeground': fg,

		'quickInput.background': surface,
		'quickInput.foreground': fg,
		'quickInputTitle.background': surface,
		'quickInputList.focusBackground': accent,
		'quickInputList.focusForeground': '#ffffff',
		'pickerGroup.foreground': accent,
		'pickerGroup.border': border,

		'badge.background': accent,
		'badge.foreground': '#ffffff',
		'counterBadge.background': accent,
		'counterBadge.foreground': '#ffffff',

		'scrollbarSlider.background': withAlpha(accent, 0.15),
		'scrollbarSlider.hoverBackground': withAlpha(accent, 0.30),
		'scrollbarSlider.activeBackground': withAlpha(accent, 0.45),
		'scrollbar.shadow': isLight ? withAlpha('#000000', 0.08) : withAlpha('#000000', 0.25),

		'progressBar.background': accent,

		'gitDecoration.modifiedResourceForeground': isLight ? '#7d4900' : '#e0a040',
		'gitDecoration.untrackedResourceForeground': isLight ? darken(accent, 0.10) : lighten(accent, 0.15),
		'gitDecoration.ignoredResourceForeground': fgSubtle,
		'gitDecoration.conflictingResourceForeground': isLight ? '#b00020' : '#ff5b6b',

		'editorOverviewRuler.findMatchForeground': withAlpha(accent, 0.6),
		'editorOverviewRuler.selectionHighlightForeground': withAlpha(accent, 0.4),
		'editorOverviewRuler.border': border,

		'minimap.background': base,
		'minimap.findMatchHighlight': accent,
		'minimap.selectionHighlight': withAlpha(accent, 0.5),

		'breadcrumb.background': chrome,
		'breadcrumb.foreground': fgMuted,
		'breadcrumb.focusForeground': accent,
		'breadcrumb.activeSelectionForeground': accent,
		'breadcrumbPicker.background': surface,

		'notificationCenter.border': border,
		'notifications.background': surface,
		'notifications.foreground': fg,
		'notifications.border': border,
		'notificationLink.foreground': accent,

		'editorGutter.modifiedBackground': isLight ? '#7d4900' : '#e0a040',
		'editorGutter.addedBackground': isLight ? '#0f7b3a' : '#5fd47f',
		'editorGutter.deletedBackground': isLight ? '#c62a47' : '#e8465f',
	};
}

const STATE_KEY = 'maut.theme.state';
const STATE_NAMED = 'maut.theme.named';
const STATE_LEGACY = 'maut.theme.current';

/** The crimson defaults of the Maut days; a theme still on them moves to Dovo's Ember. */
const LEGACY_ACCENT = '#c62a47';
const LEGACY_DARK_TINT = '#2a181c';

/** The first Ember light: bright cream that glared. Saved copies move to the softer default. */
const BRIGHT_LIGHT_ACCENT = '#ea580c';
const BRIGHT_LIGHT_TINT = '#fbf6ec';

function toEmber(snap: Snapshot): Snapshot {
	if (snap.mode === 'light' && snap.accent.toLowerCase() === BRIGHT_LIGHT_ACCENT && snap.tint.toLowerCase() === BRIGHT_LIGHT_TINT) {
		return { ...snap, accent: DEFAULT_LIGHT.accent, tint: DEFAULT_LIGHT.tint };
	}
	if (snap.accent.toLowerCase() !== LEGACY_ACCENT) {
		return snap;
	}
	const defaults = snap.mode === 'light' ? DEFAULT_LIGHT : DEFAULT_DARK;
	return { ...snap, accent: defaults.accent, tint: snap.tint.toLowerCase() === LEGACY_DARK_TINT ? defaults.tint : snap.tint };
}

function loadState(context: vscode.ExtensionContext): ThemeState {
	const existing = context.globalState.get<ThemeState>(STATE_KEY);
	if (existing && existing.light && existing.dark) {
		return { ...existing, light: toEmber(existing.light), dark: toEmber(existing.dark) };
	}
	const legacy = context.globalState.get<Snapshot>(STATE_LEGACY);
	if (legacy) {
		const fresh: ThemeState = {
			active: legacy.mode,
			light: legacy.mode === 'light' ? toEmber(legacy) : DEFAULT_LIGHT,
			dark: legacy.mode === 'dark' ? toEmber(legacy) : DEFAULT_DARK,
		};
		return fresh;
	}
	return DEFAULT_STATE;
}

function saveState(context: vscode.ExtensionContext, state: ThemeState): Thenable<void> {
	return context.globalState.update(STATE_KEY, state);
}

function loadNamed(context: vscode.ExtensionContext): NamedSnapshot[] {
	return context.globalState.get<NamedSnapshot[]>(STATE_NAMED) ?? [];
}

function saveNamed(context: vscode.ExtensionContext, list: NamedSnapshot[]): Thenable<void> {
	return context.globalState.update(STATE_NAMED, list);
}

async function applySnapshot(snap: Snapshot): Promise<void> {
	const cfg = vscode.workspace.getConfiguration();
	const colors = buildPalette(snap);
	const baseTheme = snap.mode === 'light' ? 'Default Light Modern' : 'Default Dark Modern';
	await cfg.update('workbench.colorTheme', baseTheme, vscode.ConfigurationTarget.Global);
	await cfg.update('workbench.colorCustomizations', colors, vscode.ConfigurationTarget.Global);

	// Editor / terminal — primary code surfaces.
	await cfg.update('editor.fontFamily', snap.fontFamily, vscode.ConfigurationTarget.Global);
	await cfg.update('editor.fontSize', snap.fontSize, vscode.ConfigurationTarget.Global);
	await cfg.update('terminal.integrated.fontFamily', snap.fontFamily, vscode.ConfigurationTarget.Global);
	await cfg.update('terminal.integrated.fontSize', snap.fontSize, vscode.ConfigurationTarget.Global);

	// Every other documented font setting — debug console, scm input, notebooks,
	// markdown preview, chat input, etc. Best-effort: if a particular setting
	// isn't registered in this build we just swallow the rejection.
	const extras: [string, unknown][] = [
		['debug.console.fontFamily', snap.fontFamily],
		['debug.console.fontSize', snap.fontSize],
		['scm.inputFontFamily', snap.fontFamily],
		['scm.inputFontSize', snap.fontSize],
		['notebook.output.fontFamily', snap.fontFamily],
		['notebook.output.fontSize', snap.fontSize],
		['markdown.preview.fontFamily', snap.fontFamily],
		['markdown.preview.fontSize', snap.fontSize],
		['chat.editor.fontFamily', snap.fontFamily],
		['chat.editor.fontSize', snap.fontSize],
		['markdown.preview.lineHeight', 1.6],
		// Workbench UI chrome — picked up by our patched src/vs/workbench/browser/workbench.ts
		// at startup AND on change. This is what gives the JetBrains feel — sidebar, tabs,
		// menus, palette and status bar all switch to the chosen font.
		['maut.workbenchFontFamily', snap.fontFamily],
		['maut.workbenchFontSize', snap.fontSize],
	];
	for (const [k, v] of extras) {
		try {
			await cfg.update(k, v, vscode.ConfigurationTarget.Global);
		} catch {
			// setting not registered in this build — skip silently
		}
	}
}

async function activateMode(context: vscode.ExtensionContext, mode: Mode): Promise<void> {
	const state = loadState(context);
	state.active = mode;
	await applySnapshot(state[mode]);
	await saveState(context, state);
	vscode.window.setStatusBarMessage(`Dovo · ${mode === 'light' ? 'Light' : 'Dark'}`, 2000);
	provider?.refresh();
}

async function toggleMode(context: vscode.ExtensionContext): Promise<void> {
	const state = loadState(context);
	const next: Mode = state.active === 'light' ? 'dark' : 'light';
	await activateMode(context, next);
}

let provider: StudioViewProvider | undefined;

interface StudioMessage {
	type: string;
	mode?: Mode;
	snap?: Snapshot;
	name?: string;
	json?: string;
}

class StudioViewProvider implements vscode.WebviewViewProvider {

	private view: vscode.WebviewView | undefined;

	constructor(private readonly context: vscode.ExtensionContext) { }

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
		};
		const htmlPath = path.join(this.context.extensionPath, 'media', 'studio.html');
		webviewView.webview.html = fs.readFileSync(htmlPath, 'utf8');
		this.refresh();

		webviewView.webview.onDidReceiveMessage(async (msg: StudioMessage) => {
			switch (msg.type) {
				case 'edit': {
					if (!msg.mode || !msg.snap) { return; }
					const state = loadState(this.context);
					state[msg.mode] = { ...msg.snap, mode: msg.mode };
					await saveState(this.context, state);
					if (state.active === msg.mode) {
						await applySnapshot(state[msg.mode]);
					}
					return;
				}
				case 'activate': {
					if (!msg.mode) { return; }
					await activateMode(this.context, msg.mode);
					return;
				}
				case 'preset': {
					if (!msg.snap || !msg.mode) { return; }
					const state = loadState(this.context);
					state[msg.mode] = { ...msg.snap, mode: msg.mode };
					state.active = msg.mode;
					await saveState(this.context, state);
					await applySnapshot(state[msg.mode]);
					this.refresh();
					return;
				}
				case 'saveAs': {
					if (!msg.snap || !msg.name) { return; }
					const list = loadNamed(this.context).filter(t => t.name !== msg.name);
					list.unshift({ ...msg.snap, name: msg.name });
					await saveNamed(this.context, list);
					this.refresh();
					return;
				}
				case 'applyNamed': {
					if (!msg.snap || !msg.mode) { return; }
					const state = loadState(this.context);
					state[msg.mode] = { ...msg.snap, mode: msg.mode };
					state.active = msg.mode;
					await saveState(this.context, state);
					await applySnapshot(state[msg.mode]);
					this.refresh();
					return;
				}
				case 'deleteNamed': {
					if (!msg.name) { return; }
					const list = loadNamed(this.context).filter(t => t.name !== msg.name);
					await saveNamed(this.context, list);
					this.refresh();
					return;
				}
				case 'export': {
					const data = JSON.stringify({ state: loadState(this.context), named: loadNamed(this.context) }, null, 2);
					const doc = await vscode.workspace.openTextDocument({ language: 'json', content: data });
					await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
					return;
				}
				case 'import': {
					if (!msg.json) { return; }
					try {
						const parsed = JSON.parse(msg.json) as { state?: ThemeState; named?: NamedSnapshot[] };
						if (parsed.state) {
							await saveState(this.context, parsed.state);
							await applySnapshot(parsed.state[parsed.state.active]);
						}
						if (parsed.named) {
							await saveNamed(this.context, parsed.named);
						}
						this.refresh();
						vscode.window.showInformationMessage('Dovo: theme imported.');
					} catch (e) {
						vscode.window.showErrorMessage(`Dovo: import failed — ${e instanceof Error ? e.message : 'bad JSON'}`);
					}
					return;
				}
				case 'reset': {
					if (!msg.mode) { return; }
					const state = loadState(this.context);
					state[msg.mode] = msg.mode === 'light' ? DEFAULT_LIGHT : DEFAULT_DARK;
					await saveState(this.context, state);
					if (state.active === msg.mode) {
						await applySnapshot(state[msg.mode]);
					}
					this.refresh();
					return;
				}
			}
		});
	}

	public refresh(): void {
		this.view?.webview.postMessage({
			type: 'state',
			state: loadState(this.context),
			named: loadNamed(this.context),
			presets: PRESETS,
		});
	}
}

async function openStudio(): Promise<void> {
	// Reveal the Maut activity bar container, then focus our view inside it.
	// The container id  maut  is owned by maut-activity; we just live in it.
	await vscode.commands.executeCommand('workbench.view.extension.maut');
	await vscode.commands.executeCommand('maut.themeStudio.focus');
}

function setupStatusBar(context: vscode.ExtensionContext): void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9_500);
	item.command = 'maut.theme.studio';
	item.text = '$(symbol-color)  Theme';
	item.tooltip = 'Dovo Theme Studio — colour, font, light/dark (Shift+Cmd+T)';
	item.show();
	context.subscriptions.push(item);
}

async function applyFirstRunDefaults(context: vscode.ExtensionContext): Promise<void> {
	// On a truly fresh install (no STATE_KEY, no STATE_LEGACY), seed sensible defaults
	// and apply them immediately so the user sees the JetBrains-flavoured Maut palette
	// before they ever open the studio. Saves the "why does this still look like VS Code"
	// confusion.
	const hasState = context.globalState.get<ThemeState>(STATE_KEY);
	const hasLegacy = context.globalState.get<Snapshot>(STATE_LEGACY);
	if (hasState || hasLegacy) {
		return;
	}
	const initial: ThemeState = {
		active: 'dark',
		light: DEFAULT_LIGHT,
		dark: DEFAULT_DARK,
	};
	await saveState(context, initial);
	await applySnapshot(initial.dark);
}

export function activate(context: vscode.ExtensionContext): void {
	provider = new StudioViewProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('maut.themeStudio', provider),
		vscode.commands.registerCommand('maut.theme.toggle', () => toggleMode(context)),
		vscode.commands.registerCommand('maut.theme.studio', () => { void openStudio(); }),
		// For the Dovo welcome: read and pick light or dark. Both wait for the startup re-apply
		// below, so a choice made while Dovo is still starting isn't overwritten by it.
		vscode.commands.registerCommand('_maut.theme.activeMode', async () => { await ready; return loadState(context).active; }),
		vscode.commands.registerCommand('_maut.theme.setMode', async (mode: unknown) => {
			await ready;
			if (mode === 'light' || mode === 'dark') {
				await activateMode(context, mode);
			}
			return loadState(context).active;
		}),
	);
	setupStatusBar(context);

	const ready = (async () => {
		try {
			await applyFirstRunDefaults(context);

			// Re-apply the active snapshot every startup. This re-asserts our palette
			// against any settings.json drift and re-sets the workbench font in case the
			// workbench config-change listener missed it.
			const state = loadState(context);
			await applySnapshot(state[state.active]);
		} catch {
			// a setting that won't write shouldn't keep the commands above waiting forever
		}
	})();
}

export function deactivate(): void { /* noop */ }
