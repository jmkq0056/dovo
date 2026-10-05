/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Maut Add to CLI: append `@<workspace-relative-path>` references for one or many selected
//  files/folders to the running Maut Claude terminal.

import * as path from 'path';
import * as vscode from 'vscode';

function workspaceRelative(uri: vscode.Uri): string {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (!folder) { return uri.fsPath; }
	const rel = path.relative(folder.uri.fsPath, uri.fsPath);
	return rel || '.';
}

function findMautTerminal(): vscode.Terminal | undefined {
	const all = vscode.window.terminals;
	const maut = all.find(t => t.name.includes('DOVO') || t.name.includes('MAUT') || t.name.startsWith('Dovo') || t.name.startsWith('Maut'));
	return maut ?? vscode.window.activeTerminal;
}

async function addFiles(arg: vscode.Uri | undefined, allArgs: vscode.Uri[] | undefined): Promise<void> {
	const uris = (allArgs && allArgs.length > 0)
		? allArgs
		: (arg ? [arg] : []);
	if (uris.length === 0) {
		vscode.window.showWarningMessage('Dovo: no file selected.');
		return;
	}
	const fileOnly = uris.filter(u => u.scheme === 'file');
	if (fileOnly.length === 0) { return; }

	// Bulk confirm when more than 1
	if (fileOnly.length > 1) {
		const list = fileOnly.slice(0, 12).map(u => `• ${workspaceRelative(u)}`).join('\n');
		const more = fileOnly.length > 12 ? `\n… and ${fileOnly.length - 12} more` : '';
		const choice = await vscode.window.showWarningMessage(
			`Add ${fileOnly.length} items to Claude as @-mentions?`,
			{ modal: true, detail: `${list}${more}` },
			'Add',
		);
		if (choice !== 'Add') { return; }
	}

	const terminal = findMautTerminal();
	if (!terminal) {
		vscode.window.showWarningMessage('Dovo: no terminal running. Start `clsp` first.');
		return;
	}
	terminal.show(false);
	const mentions = fileOnly.map(u => `@${workspaceRelative(u)}`).join(' ') + ' ';
	terminal.sendText(mentions, false);
}

async function addSelection(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Dovo: no active editor.');
		return;
	}
	const sel = editor.selection;
	const uri = editor.document.uri;
	if (uri.scheme !== 'file') {
		vscode.window.showWarningMessage('Dovo: file must be on disk.');
		return;
	}
	const rel = workspaceRelative(uri);
	const start = sel.start.line + 1;
	const end = sel.end.line + 1;
	const ref = sel.isEmpty
		? `@${rel} `
		: (start === end ? `@${rel}:${start} ` : `@${rel}:${start}-${end} `);
	const terminal = findMautTerminal();
	if (!terminal) {
		vscode.window.showWarningMessage('Dovo: no terminal running. Start `clsp` first.');
		return;
	}
	terminal.show(false);
	terminal.sendText(ref, false);
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('maut.cli.add', (arg?: vscode.Uri, allArgs?: vscode.Uri[]) => addFiles(arg, allArgs)),
		vscode.commands.registerCommand('maut.cli.addSelection', () => addSelection()),
	);
}

export function deactivate(): void { /* noop */ }
