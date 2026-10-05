/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Maut Focus: zen-mode toggles for the active file or the active terminal. Terminal focus
//  moves the terminal into the editor area while in focus and back to the panel on unfocus,
//  preserving the running process / Claude Code session.

import * as vscode from 'vscode';

interface FocusState {
	mode: 'idle' | 'file' | 'terminal';
}

const state: FocusState = { mode: 'idle' };

async function enterFileFocus(): Promise<void> {
	state.mode = 'file';
	await vscode.commands.executeCommand('workbench.action.toggleZenMode');
}

async function exitFileFocus(): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.toggleZenMode');
	state.mode = 'idle';
}

async function enterTerminalFocus(): Promise<void> {
	const t = vscode.window.activeTerminal;
	if (!t) {
		vscode.window.showWarningMessage('Dovo: no active terminal to focus.');
		return;
	}
	t.show(false);
	await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
	// Tiny delay so the editor-area terminal is the active editor before zen mode hides chrome.
	await new Promise(r => setTimeout(r, 80));
	await vscode.commands.executeCommand('workbench.action.toggleZenMode');
	state.mode = 'terminal';
}

async function exitTerminalFocus(): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.toggleZenMode');
	await new Promise(r => setTimeout(r, 80));
	const active = vscode.window.activeTerminal;
	if (active) {
		active.show(false);
		await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
	}
	state.mode = 'idle';
}

async function toggleFile(): Promise<void> {
	if (state.mode === 'file') { return exitFileFocus(); }
	if (state.mode === 'terminal') { await exitTerminalFocus(); }
	return enterFileFocus();
}

async function toggleTerminal(): Promise<void> {
	if (state.mode === 'terminal') { return exitTerminalFocus(); }
	if (state.mode === 'file') { await exitFileFocus(); }
	return enterTerminalFocus();
}

async function toggleSmart(): Promise<void> {
	if (state.mode !== 'idle') {
		// Whatever's focused, unfocus it.
		return state.mode === 'terminal' ? exitTerminalFocus() : exitFileFocus();
	}
	// Pick by where focus currently is. activeTextEditor wins over activeTerminal when both exist.
	if (vscode.window.activeTextEditor) { return enterFileFocus(); }
	if (vscode.window.activeTerminal) { return enterTerminalFocus(); }
	vscode.window.showWarningMessage('Dovo: no editor or terminal to focus.');
}

async function toggleSidebar(): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('maut.focus.toggleFile', toggleFile),
		vscode.commands.registerCommand('maut.focus.toggleTerminal', toggleTerminal),
		vscode.commands.registerCommand('maut.focus.toggleSmart', toggleSmart),
		vscode.commands.registerCommand('maut.focus.toggleSidebar', toggleSidebar),
	);
}

export function deactivate(): void { /* noop */ }
