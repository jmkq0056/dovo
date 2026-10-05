/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Maut Server Launcher: right-click a folder → detect runnable server, spawn it in a terminal.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface ServerCandidate {
	label: string;
	description?: string;
	command: string;
	detail?: string;
}

function exists(p: string): boolean {
	try { fs.accessSync(p); return true; } catch { return false; }
}

function readJson(p: string): Record<string, unknown> | undefined {
	try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return undefined; }
}

function detectPackageManager(dir: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
	if (exists(path.join(dir, 'pnpm-lock.yaml'))) { return 'pnpm'; }
	if (exists(path.join(dir, 'yarn.lock'))) { return 'yarn'; }
	if (exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock'))) { return 'bun'; }
	return 'npm';
}

function detectCandidates(dir: string): ServerCandidate[] {
	const out: ServerCandidate[] = [];

	// Node — read package.json scripts
	const pkgPath = path.join(dir, 'package.json');
	if (exists(pkgPath)) {
		const pkg = readJson(pkgPath) ?? {};
		const scripts = (pkg.scripts ?? {}) as Record<string, string>;
		const pm = detectPackageManager(dir);
		const runner = pm === 'npm' ? 'npm run' : pm;
		// Prioritize common script names
		for (const name of ['dev', 'start', 'serve', 'server', 'watch']) {
			if (scripts[name]) {
				out.push({
					label: `$(node) ${runner} ${name}`,
					description: scripts[name],
					command: `${runner} ${name}`,
				});
			}
		}
		// Any other script
		for (const name of Object.keys(scripts)) {
			if (['dev', 'start', 'serve', 'server', 'watch'].includes(name)) { continue; }
			out.push({
				label: `$(node) ${runner} ${name}`,
				description: scripts[name],
				command: `${runner} ${name}`,
			});
		}
	}

	// Python — Django
	if (exists(path.join(dir, 'manage.py'))) {
		out.push({ label: '$(snake) python manage.py runserver', description: 'Django dev server', command: 'python manage.py runserver' });
	}
	// Python — Flask / FastAPI / generic
	for (const fname of ['main.py', 'app.py', 'server.py', 'run.py', '__main__.py']) {
		if (exists(path.join(dir, fname))) {
			out.push({ label: `$(snake) python ${fname}`, command: `python ${fname}` });
		}
	}
	// Detect uv / poetry
	if (exists(path.join(dir, 'pyproject.toml'))) {
		const text = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
		if (/\[tool\.uv\]/.test(text)) {
			out.push({ label: '$(snake) uv run', command: 'uv run' });
		}
		if (/\[tool\.poetry\.scripts\]/.test(text)) {
			out.push({ label: '$(snake) poetry run', command: 'poetry run' });
		}
	}

	// Rust — Cargo
	if (exists(path.join(dir, 'Cargo.toml'))) {
		out.push({ label: '$(rust) cargo run', command: 'cargo run' });
	}

	// Go
	if (exists(path.join(dir, 'go.mod'))) {
		out.push({ label: '$(go) go run .', command: 'go run .' });
	}

	// Static — index.html and no package.json (serve via Python http.server)
	if (exists(path.join(dir, 'index.html')) && !exists(pkgPath)) {
		out.push({ label: '$(file-code) python -m http.server', description: 'static HTTP', command: 'python -m http.server 8000' });
	}

	// Makefile
	if (exists(path.join(dir, 'Makefile')) || exists(path.join(dir, 'makefile'))) {
		for (const target of ['dev', 'serve', 'run', 'start']) {
			const mkText = fs.readFileSync(exists(path.join(dir, 'Makefile')) ? path.join(dir, 'Makefile') : path.join(dir, 'makefile'), 'utf8');
			if (new RegExp(`^${target}:`, 'm').test(mkText)) {
				out.push({ label: `$(tools) make ${target}`, command: `make ${target}` });
			}
		}
	}

	// Docker compose
	if (exists(path.join(dir, 'docker-compose.yml')) || exists(path.join(dir, 'compose.yml'))) {
		out.push({ label: '$(server-process) docker compose up', command: 'docker compose up' });
	}

	return out;
}

async function startServer(arg: vscode.Uri | undefined): Promise<void> {
	const dir = arg?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!dir) {
		vscode.window.showWarningMessage('Dovo: select a folder first.');
		return;
	}
	let stat: fs.Stats;
	try { stat = fs.statSync(dir); } catch { return; }
	const folder = stat.isDirectory() ? dir : path.dirname(dir);

	const candidates = detectCandidates(folder);
	if (candidates.length === 0) {
		vscode.window.showWarningMessage(`Dovo: no runnable server detected in ${path.basename(folder)}.`);
		return;
	}

	let chosen = candidates[0];
	if (candidates.length > 1) {
		const pick = await vscode.window.showQuickPick(
			candidates.map(c => ({ label: c.label, description: c.description, detail: c.detail, command: c.command })),
			{ placeHolder: `Start server in ${path.basename(folder)}` },
		);
		if (!pick) { return; }
		chosen = candidates.find(c => c.command === pick.command) ?? chosen;
	}

	const terminal = vscode.window.createTerminal({ name: `Dovo · server · ${path.basename(folder)}`, cwd: folder });
	terminal.show(true);
	terminal.sendText(chosen.command, true);
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('maut.server.start', (arg?: vscode.Uri) => startServer(arg)),
	);
}

export function deactivate(): void { /* noop */ }
