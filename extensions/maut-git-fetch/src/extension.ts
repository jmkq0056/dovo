/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Maut Git Fetch: status-bar button next to the commit button.
 *
 *    Click  →  pick remote (skipped if only one)  →  pick branch (default = current)  →
 *    fetch + pull. If the pull fails because of local changes or a non-fast-forward,
 *    a quick-pick offers three resolutions:
 *
 *        $(archive)  Stash & pull  →  git stash -u  then pull, then pop the stash
 *        $(discard)  Reset --hard  →  git fetch origin <br>  then  git reset --hard <remote>/<br>
 *        $(close)    Cancel
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import * as vscode from 'vscode';

interface ExecResult { stdout: string; stderr: string; code: number }

function runGit(args: string, cwd: string): Promise<ExecResult> {
	return new Promise((resolve) => {
		exec(`git ${args}`, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
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
	const v = r.stdout.trim();
	return v && v !== 'HEAD' ? v : undefined;
}

async function getRemotes(cwd: string): Promise<string[]> {
	const r = await runGit('remote', cwd);
	if (r.code !== 0) { return []; }
	return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

async function getRemoteBranches(remote: string, cwd: string): Promise<string[]> {
	// ls-remote --heads is authoritative because it consults the remote itself,
	// but if the remote is unreachable we fall back to the locally cached refs.
	const live = await runGit(`ls-remote --heads ${remote}`, cwd);
	if (live.code === 0 && live.stdout.trim()) {
		return live.stdout.split('\n')
			.map(line => line.split('\t')[1])
			.filter((ref): ref is string => Boolean(ref))
			.map(ref => ref.replace(/^refs\/heads\//, ''))
			.sort();
	}
	const cached = await runGit(`branch -r --list ${remote}/*`, cwd);
	if (cached.code !== 0) { return []; }
	return cached.stdout.split('\n')
		.map(s => s.trim().replace(new RegExp(`^${remote}/`), ''))
		.filter(b => b && !b.startsWith('HEAD ->'))
		.sort();
}

async function hasLocalChanges(cwd: string): Promise<boolean> {
	const r = await runGit('status --porcelain', cwd);
	return r.code === 0 && r.stdout.trim().length > 0;
}

interface ActionItem extends vscode.QuickPickItem { action: string }

async function chooseAction(title: string, items: ActionItem[]): Promise<string | undefined> {
	const pick = await vscode.window.showQuickPick(items, { placeHolder: title, ignoreFocusOut: true });
	return pick?.action;
}

async function pickRemote(cwd: string): Promise<string | undefined> {
	const remotes = await getRemotes(cwd);
	if (remotes.length === 0) {
		vscode.window.showErrorMessage('Dovo: no remotes configured for this repo.');
		return undefined;
	}
	if (remotes.length === 1) { return remotes[0]; }
	const pick = await vscode.window.showQuickPick(
		remotes.map(r => ({ label: `$(cloud)  ${r}`, description: r === 'origin' ? '(default)' : undefined, value: r })),
		{ placeHolder: 'Pick a remote', ignoreFocusOut: true },
	);
	return pick?.value;
}

async function pickBranch(remote: string, currentBranch: string | undefined, cwd: string): Promise<string | undefined> {
	const sb = vscode.window.setStatusBarMessage(`$(loading~spin)  Dovo · listing ${remote} branches…`);
	let branches: string[] = [];
	try { branches = await getRemoteBranches(remote, cwd); } finally { sb.dispose(); }
	if (branches.length === 0) {
		vscode.window.showWarningMessage(`Dovo: could not list branches on ${remote}.`);
		return undefined;
	}
	const items = branches.map(b => ({
		label: b === currentBranch ? `$(star-full)  ${b}` : `$(git-branch)  ${b}`,
		description: b === currentBranch ? 'current' : undefined,
		value: b,
	}));
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: `Pick a branch on  ${remote}`,
		ignoreFocusOut: true,
		matchOnDescription: true,
	});
	return pick?.value;
}

interface PullResult { ok: boolean; conflict: boolean; output: string }

async function tryPull(remote: string, branch: string, cwd: string): Promise<PullResult> {
	const fetch = await runGit(`fetch ${remote} ${branch}`, cwd);
	if (fetch.code !== 0) {
		return { ok: false, conflict: false, output: (fetch.stderr || fetch.stdout).trim() };
	}
	// Try a fast-forward / merge pull on the current branch only. If the user picked a
	// non-current branch we just fetched it; advise them what to do next.
	const current = await getCurrentBranch(cwd);
	if (current !== branch) {
		return { ok: true, conflict: false, output: `Fetched ${remote}/${branch}. (current branch is ${current ?? '?'} — switch to ${branch} first to pull)` };
	}
	const pull = await runGit(`pull ${remote} ${branch}`, cwd);
	if (pull.code === 0) {
		return { ok: true, conflict: false, output: pull.stdout.trim() || `Up to date with ${remote}/${branch}.` };
	}
	const out = (pull.stderr || pull.stdout).trim();
	const looksLikeConflict =
		/would be overwritten|local changes|merge conflict|conflict|not possible to fast-forward|reject(ed)?|unmerged|divergent/i.test(out);
	return { ok: false, conflict: looksLikeConflict, output: out };
}

async function resolveConflict(remote: string, branch: string, cwd: string): Promise<void> {
	const choice = await chooseAction(
		`Pull failed on  ${branch}  — how do you want to resolve?`,
		[
			{ label: '$(archive)  Stash & pull', description: 'Stash local changes incl. untracked, pull, pop the stash', action: 'stash' },
			{ label: '$(discard)  Reset --hard', description: `Throw away local commits/work — match  ${remote}/${branch}  exactly`, action: 'reset' },
			{ label: '$(close)  Cancel', description: 'Do nothing', action: 'cancel' },
		],
	);
	if (!choice || choice === 'cancel') { return; }

	if (choice === 'stash') {
		const sb = vscode.window.setStatusBarMessage(`$(loading~spin)  Dovo · stashing + pulling…`);
		try {
			const dirty = await hasLocalChanges(cwd);
			if (dirty) {
				const stash = await runGit('stash push -u -m "maut-fetch-auto"', cwd);
				if (stash.code !== 0) {
					vscode.window.showErrorMessage(`git stash failed:\n${(stash.stderr || stash.stdout).trim()}`);
					return;
				}
			}
			const pull = await runGit(`pull ${remote} ${branch}`, cwd);
			if (pull.code !== 0) {
				vscode.window.showErrorMessage(`Pull still failed after stash:\n${(pull.stderr || pull.stdout).trim()}\n\nYour changes are safe in stash@{0}. Run \`git stash pop\` when ready.`);
				return;
			}
			if (dirty) {
				const pop = await runGit('stash pop', cwd);
				if (pop.code !== 0) {
					vscode.window.showWarningMessage(`Pulled OK, but stash pop hit a conflict — resolve manually. Stashed changes are in stash@{0}.`);
					return;
				}
			}
			vscode.window.showInformationMessage(`Dovo · pulled  ${remote}/${branch}  ${dirty ? '(stash popped)' : ''}`);
		} finally {
			sb.dispose();
		}
		return;
	}

	if (choice === 'reset') {
		const sure = await chooseAction(
			`Really reset  ${branch}  to  ${remote}/${branch}? Local commits & uncommitted changes will be lost.`,
			[
				{ label: '$(discard)  Yes, reset --hard', action: 'go' },
				{ label: '$(close)  No, cancel', action: 'cancel' },
			],
		);
		if (sure !== 'go') { return; }
		const sb = vscode.window.setStatusBarMessage(`$(loading~spin)  Dovo · resetting --hard to ${remote}/${branch}…`);
		try {
			const reset = await runGit(`reset --hard ${remote}/${branch}`, cwd);
			if (reset.code !== 0) {
				vscode.window.showErrorMessage(`git reset failed:\n${(reset.stderr || reset.stdout).trim()}`);
				return;
			}
			vscode.window.showInformationMessage(`Dovo · reset  ${branch}  to  ${remote}/${branch}.`);
		} finally {
			sb.dispose();
		}
	}
}

async function fetchAndPull(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) {
		vscode.window.showWarningMessage('Dovo: no workspace folder is open.');
		return;
	}

	const inRepo = await runGit('rev-parse --is-inside-work-tree', folder);
	if (inRepo.code !== 0 || inRepo.stdout.trim() !== 'true') {
		vscode.window.showErrorMessage('Dovo: not inside a git repository.');
		return;
	}

	const remote = await pickRemote(folder);
	if (!remote) { return; }

	const currentBranch = await getCurrentBranch(folder);
	const branch = await pickBranch(remote, currentBranch, folder);
	if (!branch) { return; }

	const sb = vscode.window.setStatusBarMessage(`$(loading~spin)  Dovo · fetching ${remote}/${branch}…`);
	let result: PullResult;
	try { result = await tryPull(remote, branch, folder); } finally { sb.dispose(); }

	if (result.ok) {
		vscode.window.showInformationMessage(`Dovo · ${result.output}`);
		return;
	}

	if (!result.conflict) {
		vscode.window.showErrorMessage(`Dovo · fetch/pull failed:\n${result.output}`);
		return;
	}

	await resolveConflict(remote, branch, folder);
}

function setupStatusBar(context: vscode.ExtensionContext): void {
	// priority 9_995 sits just to the left of  maut-git-commit  at 10_000 so the two
	// git buttons cluster together on the right-hand status bar.
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9_995);
	item.command = 'maut.git.fetchAndPull';
	item.text = '$(cloud-download)  Fetch';
	item.tooltip = 'Dovo: pick remote & branch → fetch + pull. Resolves conflicts via stash / reset.';
	item.show();
	context.subscriptions.push(item);

	const refresh = async () => {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!folder) { item.text = '$(cloud-download)  Fetch'; return; }
		const branch = await getCurrentBranch(folder);
		if (!branch) { item.text = '$(cloud-download)  Fetch'; return; }
		item.text = `$(cloud-download)  Fetch · ${branch}`;
	};
	void refresh();
	const interval = setInterval(refresh, 6000);
	context.subscriptions.push({ dispose: () => clearInterval(interval) });
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
	);
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand('maut.git.fetchAndPull', fetchAndPull));
	setupStatusBar(context);
}

export function deactivate(): void { /* noop */ }
