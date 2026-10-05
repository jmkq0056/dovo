/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Maut Open External: file-type-aware right-click actions.
//    - HTML/PDF/SVG  → Open in Firefox
//    - DOCX/ODT/RTF  → Show in Word
//    - XLSX/CSV/TSV  → Show in Excel
//    - PPTX/ODP      → Show in PowerPoint
//    - SH/BASH/ZSH   → Execute Script in Terminal
//    - anything      → Open With System Default App

import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { registerBrowserDock } from './browserDock';

async function resolveTarget(arg: unknown): Promise<vscode.Uri | undefined> {
	if (arg instanceof vscode.Uri) { return arg; }
	if (typeof arg === 'object' && arg && typeof (arg as { fsPath?: unknown }).fsPath === 'string') {
		const fsPath = String((arg as { fsPath: unknown }).fsPath ?? '');
		if (fsPath) { return vscode.Uri.file(fsPath); }
	}
	const editor = vscode.window.activeTextEditor;
	if (editor) { return editor.document.uri; }
	return undefined;
}

async function openWith(appName: string | undefined, arg: unknown): Promise<void> {
	const uri = await resolveTarget(arg);
	if (!uri || uri.scheme !== 'file') {
		vscode.window.showWarningMessage('Dovo: Could not resolve a local file path to open.');
		return;
	}
	const args = appName ? ['-a', appName, uri.fsPath] : [uri.fsPath];
	try {
		const child = spawn('open', args, { detached: true, stdio: 'ignore' });
		child.on('error', (err) => {
			vscode.window.showErrorMessage(`Failed to launch ${appName ?? 'default app'}: ${err.message}`);
		});
		child.unref();
	} catch (err) {
		vscode.window.showErrorMessage(`Failed to launch ${appName ?? 'default app'}: ${err}`);
	}
}

function shellQuote(s: string): string {
	return s.includes(' ') || /[$`"\\']/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

async function runScript(arg: unknown): Promise<void> {
	const uri = await resolveTarget(arg);
	if (!uri || uri.scheme !== 'file') {
		vscode.window.showWarningMessage('Dovo: Could not resolve a local script path to run.');
		return;
	}
	const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: 'Dovo · run' });
	terminal.show(true);
	terminal.sendText(`bash ${shellQuote(uri.fsPath)}`, true);
}

async function compileTexAndOpenInFirefox(arg: unknown): Promise<void> {
	const uri = await resolveTarget(arg);
	if (!uri || uri.scheme !== 'file' || !uri.fsPath.endsWith('.tex')) {
		vscode.window.showWarningMessage('Dovo: select a .tex file first.');
		return;
	}
	const path = await import('node:path');
	const dir = path.dirname(uri.fsPath);
	const file = path.basename(uri.fsPath);
	const base = path.basename(uri.fsPath, '.tex');

	const terminal = vscode.window.createTerminal({ name: `Dovo · tex · ${base}`, cwd: dir });
	terminal.show(true);
	// Short single-line command operating in $PWD; `;` so each step runs even if pdflatex errors.
	const cmd = `pdflatex -interaction=nonstopmode ${shellQuote(file)}; pdflatex -interaction=nonstopmode ${shellQuote(file)}; rm -f ${shellQuote(base)}.{aux,log,out,toc,fdb_latexmk,fls,synctex.gz,nav,snm,bbl,blg}; open -a Firefox ${shellQuote(base + '.pdf')}`;
	terminal.sendText(cmd, true);
}

class HandoffEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
	constructor(private readonly appName: string) { }

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose() { /* noop */ } };
	}

	resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
		const fileName = document.uri.path.split('/').pop() || 'file';
		const app = this.appName;
		panel.webview.html = `<!doctype html>
<html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);text-align:center">
	<div>
		<div style="font-size:13px;opacity:0.6;margin-bottom:8px">Dovo</div>
		<div style="font-size:15px;font-weight:600">Opening <code>${fileName}</code> in ${app}…</div>
		<div style="font-size:11px;opacity:0.5;margin-top:16px">Closing this tab automatically.</div>
	</div>
</body></html>`;
		try {
			const child = spawn('open', ['-a', this.appName, document.uri.fsPath], { detached: true, stdio: 'ignore' });
			child.on('error', () => vscode.window.showErrorMessage(`Failed to launch ${this.appName}.`));
			child.unref();
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to launch ${this.appName}: ${err}`);
		}
		// Close the placeholder tab shortly after handing off.
		setTimeout(() => { try { panel.dispose(); } catch { /* noop */ } }, 600);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	registerBrowserDock(context);
	context.subscriptions.push(
		vscode.commands.registerCommand('maut.openIn.firefox', (arg) => openWith('Firefox', arg)),
		vscode.commands.registerCommand('maut.openIn.word', (arg) => openWith('Microsoft Word', arg)),
		vscode.commands.registerCommand('maut.openIn.excel', (arg) => openWith('Microsoft Excel', arg)),
		vscode.commands.registerCommand('maut.openIn.powerpoint', (arg) => openWith('Microsoft PowerPoint', arg)),
		vscode.commands.registerCommand('maut.openIn.defaultApp', (arg) => openWith(undefined, arg)),
		vscode.commands.registerCommand('maut.run.script', (arg) => runScript(arg)),
		vscode.commands.registerCommand('maut.tex.compileAndOpenFirefox', (arg) => compileTexAndOpenInFirefox(arg)),
		vscode.window.registerCustomEditorProvider('maut.openInWord', new HandoffEditorProvider('Microsoft Word'), { supportsMultipleEditorsPerDocument: true }),
		vscode.window.registerCustomEditorProvider('maut.openInExcel', new HandoffEditorProvider('Microsoft Excel'), { supportsMultipleEditorsPerDocument: true }),
		vscode.window.registerCustomEditorProvider('maut.openInPowerPoint', new HandoffEditorProvider('Microsoft PowerPoint'), { supportsMultipleEditorsPerDocument: true }),
	);
}

export function deactivate(): void { /* noop */ }
