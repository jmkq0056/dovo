/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Maut Git Commit: status-bar button → quick-pick driven commit + optional push flow.
//  Uses VS Code's native quick-pick UI (no macOS-style modals) for every confirmation.

import { exec } from 'child_process';
import * as vscode from 'vscode';

interface ExecResult { stdout: string; stderr: string; code: number }

function runGit(args: string, cwd: string): Promise<ExecResult> {
	return new Promise((resolve) => {
		exec(`git ${args}`, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({
				stdout: String(stdout ?? ''),
				stderr: String(stderr ?? ''),
				code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
			});
		});
	});
}

async function getCurrentBranch(cwd: string): Promise<string | undefined> {
	const r = await runGit('rev-parse --abbrev-ref HEAD', cwd);
	if (r.code !== 0) { return undefined; }
	return r.stdout.trim() || undefined;
}

async function getDirty(cwd: string): Promise<{ files: number; preview: string }> {
	const r = await runGit('status --porcelain', cwd);
	const lines = r.stdout.split('\n').filter(Boolean);
	const preview = lines.slice(0, 8).join('\n');
	return { files: lines.length, preview };
}

interface ActionItem extends vscode.QuickPickItem { action: string }

async function chooseAction(title: string, items: ActionItem[]): Promise<string | undefined> {
	const pick = await vscode.window.showQuickPick(items, { placeHolder: title, ignoreFocusOut: true });
	return pick?.action;
}

async function commitAndPush(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) {
		vscode.window.showWarningMessage('Dovo: no workspace folder is open.');
		return;
	}

	const branch = await getCurrentBranch(folder);
	if (!branch) {
		vscode.window.showErrorMessage('Dovo: not inside a git repository.');
		return;
	}
	const { files, preview } = await getDirty(folder);
	if (files === 0) {
		vscode.window.showInformationMessage(`Dovo: nothing to commit on \`${branch}\` — working tree is clean.`);
		return;
	}

	// 1) Confirm commit
	const commitAction = await chooseAction(`Dovo · ${files} change${files === 1 ? '' : 's'} on  ${branch}`, [
		{
			label: `$(git-commit)  Stage all & commit on  ${branch}`,
			description: `${files} change${files === 1 ? '' : 's'}`,
			detail: preview || undefined,
			action: 'commit',
		},
		{ label: '$(close)  Cancel', action: 'cancel' },
	]);
	if (commitAction !== 'commit') { return; }

	// 2) Commit message
	const message = await vscode.window.showInputBox({
		prompt: `Commit message for  ${branch}`,
		placeHolder: 'short summary…',
		value: `wip: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
		ignoreFocusOut: true,
		validateInput: v => v && v.trim().length > 0 ? null : 'message required',
	});
	if (!message) { return; }

	// 3) Run add + commit
	const sb = vscode.window.setStatusBarMessage(`$(loading~spin)  Dovo · committing on ${branch}…`);
	try {
		const add = await runGit('add -A', folder);
		if (add.code !== 0) {
			vscode.window.showErrorMessage(`git add failed:\n${(add.stderr || add.stdout).trim()}`);
			return;
		}
		const escaped = message.replace(/"/g, '\\"');
		const commit = await runGit(`commit -m "${escaped}"`, folder);
		if (commit.code !== 0) {
			vscode.window.showErrorMessage(`git commit failed:\n${(commit.stderr || commit.stdout).trim()}`);
			return;
		}
		const summary = commit.stdout.split('\n')[0]?.trim();
		vscode.window.showInformationMessage(`Dovo · committed on  ${branch}  ${summary ? `· ${summary}` : ''}`);
	} finally {
		sb.dispose();
	}

	// 4) Push?
	const pushAction = await chooseAction(`Push  ${branch}  to origin?`, [
		{ label: `$(cloud-upload)  Push to origin/${branch}`, action: 'push' },
		{ label: '$(close)  Skip push', action: 'skip' },
	]);
	if (pushAction !== 'push') { return; }

	// 5) Confirm push
	const sure = await chooseAction(`Confirm push to origin/${branch}`, [
		{ label: `$(cloud-upload)  Yes, push origin/${branch}`, action: 'push' },
		{ label: '$(close)  Cancel', action: 'cancel' },
	]);
	if (sure !== 'push') { return; }

	const sbPush = vscode.window.setStatusBarMessage(`$(loading~spin)  Dovo · pushing origin/${branch}…`);
	try {
		const push = await runGit(`push origin ${branch}`, folder);
		if (push.code !== 0) {
			vscode.window.showErrorMessage(`git push failed:\n${(push.stderr || push.stdout).trim()}`);
			return;
		}
		vscode.window.showInformationMessage(`Pushed to origin/${branch}.`);
	} finally {
		sbPush.dispose();
	}
}

function setupStatusBarButton(context: vscode.ExtensionContext): void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10_000);
	item.command = 'maut.git.commitAndPush';
	item.text = '$(git-commit)  Commit all';
	item.tooltip = 'Dovo: git add -A + commit + optional push, all with confirmations';
	item.show();
	context.subscriptions.push(item);

	const refresh = async () => {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!folder) { item.text = '$(git-commit)  Commit all'; return; }
		const branch = await getCurrentBranch(folder);
		if (!branch) { item.text = '$(git-commit)  Commit all'; return; }
		const { files } = await getDirty(folder);
		item.text = files > 0
			? `$(git-commit)  ${branch}  ·  ${files}`
			: `$(check)  ${branch}  ·  clean`;
	};
	void refresh();
	const interval = setInterval(refresh, 4000);
	context.subscriptions.push({ dispose: () => clearInterval(interval) });

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(() => refresh()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
	);
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand('maut.git.commitAndPush', commitAndPush));
	setupStatusBarButton(context);
}

export function deactivate(): void { /* noop */ }
