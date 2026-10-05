/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Maut: how Claude starts. The permission mode, the model and any extra flags, set in the Maut
 *  panel's "Claude" section (or as `maut.claude.*` settings) and used everywhere Maut starts Claude:
 *  the auto-continue on open, "maut", and the panel's own Start button.
 */

import * as vscode from 'vscode';

const section = 'maut.claude';

interface IChoice {
	readonly value: string;
	readonly label: string;
	readonly detail: string;
}

const permissionModes: readonly IChoice[] = [
	{ value: 'bypassPermissions', label: 'Bypass', detail: 'Never asks: Claude edits and runs commands freely (claude --dangerously-skip-permissions)' },
	{ value: 'acceptEdits', label: 'Accept edits', detail: 'Edits files without asking; asks before running commands' },
	{ value: 'auto', label: 'Auto', detail: 'Claude decides what is safe to do without asking (not every model supports it)' },
	{ value: 'manual', label: 'Ask every time', detail: 'Asks before each edit and each command' },
	{ value: 'plan', label: 'Plan first', detail: 'Plans and explains, changes nothing until you approve the plan' },
	{ value: 'dontAsk', label: 'Don\'t ask, deny', detail: 'Never asks: anything not already allowed is refused' },
];

const models: readonly IChoice[] = [
	{ value: '', label: 'Default', detail: 'Whatever Claude Code uses by default (your /model choice)' },
	{ value: 'opus', label: 'Opus', detail: 'The most capable model' },
	{ value: 'sonnet', label: 'Sonnet', detail: 'Fast and capable' },
	{ value: 'haiku', label: 'Haiku', detail: 'The fastest, for quick tasks' },
];

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(section);
}

/** The command that starts Claude with the chosen mode, model and extra flags. */
export function claudeCommand(): string {
	const mode = config().get<string>('permissionMode', 'bypassPermissions');
	const model = config().get<string>('model', '');
	const extra = config().get<string>('extraArgs', '').trim();
	const parts = [config().get<string>('command', 'claude').trim() || 'claude'];
	parts.push(mode === 'bypassPermissions' ? '--dangerously-skip-permissions' : `--permission-mode ${mode}`);
	if (model) {
		parts.push(`--model ${model}`);
	}
	if (extra) {
		parts.push(extra);
	}
	return parts.join(' ');
}

type Row = 'mode' | 'model' | 'extra' | 'start';

/** The Maut panel's "Claude" section: how the next Claude starts, and a Start button. */
class ClaudeLaunchProvider implements vscode.TreeDataProvider<Row> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getChildren(): Row[] {
		return ['mode', 'model', 'extra', 'start'];
	}

	getTreeItem(row: Row): vscode.TreeItem {
		switch (row) {
			case 'mode': {
				const value = config().get<string>('permissionMode', 'bypassPermissions');
				const choice = permissionModes.find(mode => mode.value === value) ?? permissionModes[0];
				const item = new vscode.TreeItem('Permissions');
				item.description = choice.label;
				item.tooltip = choice.detail;
				item.iconPath = new vscode.ThemeIcon('shield');
				item.command = { command: 'maut.claude.pickPermissionMode', title: 'Choose Permission Mode' };
				return item;
			}
			case 'model': {
				const value = config().get<string>('model', '');
				const choice = models.find(model => model.value === value) ?? { label: value, detail: 'A custom model' };
				const item = new vscode.TreeItem('Model');
				item.description = choice.label;
				item.tooltip = choice.detail;
				item.iconPath = new vscode.ThemeIcon('sparkle');
				item.command = { command: 'maut.claude.pickModel', title: 'Choose Model' };
				return item;
			}
			case 'extra': {
				const value = config().get<string>('extraArgs', '').trim();
				const item = new vscode.TreeItem('Extra flags');
				item.description = value || 'none';
				item.tooltip = 'More flags for claude, like --add-dir ../shared';
				item.iconPath = new vscode.ThemeIcon('settings');
				item.command = { command: 'maut.claude.editExtraArgs', title: 'Edit Extra Flags' };
				return item;
			}
			case 'start': {
				const item = new vscode.TreeItem('Start new Claude');
				item.description = claudeCommand();
				item.tooltip = `Opens a new agent terminal and runs: ${claudeCommand()}`;
				item.iconPath = new vscode.ThemeIcon('play');
				item.command = { command: 'maut.chat.startClaude', title: 'Start New Claude' };
				return item;
			}
		}
	}
}

async function pick(key: string, choices: readonly IChoice[], title: string, fallback: string): Promise<void> {
	const current = config().get<string>(key, fallback);
	const picked = await vscode.window.showQuickPick(choices.map(choice => ({ label: choice.label, detail: choice.detail, value: choice.value, picked: choice.value === current, description: choice.value === current ? 'current' : undefined })), { title, placeHolder: 'Used the next time Dovo starts Claude' });
	if (picked) {
		await config().update(key, picked.value, vscode.ConfigurationTarget.Global);
	}
}

export function registerClaudeLaunch(context: vscode.ExtensionContext): void {
	const provider = new ClaudeLaunchProvider();
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('maut.claude.launch', provider),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(section)) {
				provider.refresh();
			}
		}),
		vscode.commands.registerCommand('maut.claude.pickPermissionMode', () => pick('permissionMode', permissionModes, 'How Claude asks before acting', 'bypassPermissions')),
		vscode.commands.registerCommand('maut.claude.pickModel', () => pick('model', models, 'Which model Claude uses', '')),
		vscode.commands.registerCommand('maut.claude.editExtraArgs', async () => {
			const value = await vscode.window.showInputBox({
				title: 'Extra flags for claude',
				prompt: 'Added to the command Dovo runs, e.g. --add-dir ../shared',
				value: config().get<string>('extraArgs', ''),
			});
			if (value !== undefined) {
				await config().update('extraArgs', value.trim(), vscode.ConfigurationTarget.Global);
			}
		}),
	);
}
