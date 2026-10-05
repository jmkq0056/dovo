/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function findMautTerminal(): vscode.Terminal | undefined {
	const all = vscode.window.terminals;
	const maut = all.find(t => t.name.includes('DOVO') || t.name.includes('MAUT') || t.name.startsWith('Dovo') || t.name.startsWith('Maut'));
	return maut ?? vscode.window.activeTerminal;
}

export function appendToMautCli(absPaths: string[]): boolean {
	if (absPaths.length === 0) { return false; }
	const terminal = findMautTerminal();
	if (!terminal) {
		vscode.window.showWarningMessage('Dovo: no terminal running. Start `clsp` first.');
		return false;
	}
	terminal.show(false);
	const mentions = absPaths.map(p => `@${p}`).join(' ') + ' ';
	terminal.sendText(mentions, false);
	return true;
}
