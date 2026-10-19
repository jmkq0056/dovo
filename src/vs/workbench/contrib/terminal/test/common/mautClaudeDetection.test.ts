/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isClaudeCommandLine, MautClaudePresence, runsClaude, titleShowsClaude } from '../../common/mautClaudeDetection.js';

suite('Workbench - MautClaudeDetection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('isClaudeCommandLine', () => {
		const commandLines = [
			'claude --dangerously-skip-permissions --continue',
			'/Users/me/.local/share/claude/versions/2.1.303 --dangerously-skip-permissions',
			'2.1.303',
			'/Users/me/.local/bin/claude',
			'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --continue',
			'npx @anthropic-ai/claude-code',
			'C:\\Users\\me\\.local\\bin\\claude.exe --continue',
			'claude -p hello',
			'claude --model opus --print hello',
			'claude --version',
			'claude mcp list',
			'vim claude',
			'/bin/zsh -il',
			'node server.js',
			'',
		];
		assert.deepStrictEqual(commandLines.map(commandLine => [commandLine, isClaudeCommandLine(commandLine)]), [
			['claude --dangerously-skip-permissions --continue', true],
			['/Users/me/.local/share/claude/versions/2.1.303 --dangerously-skip-permissions', true],
			// The bare version as argv[0] says nothing on its own: the path, the session file or the title do.
			['2.1.303', false],
			['/Users/me/.local/bin/claude', true],
			['node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --continue', true],
			['npx @anthropic-ai/claude-code', true],
			['C:\\Users\\me\\.local\\bin\\claude.exe --continue', true],
			['claude -p hello', false],
			['claude --model opus --print hello', false],
			['claude --version', false],
			['claude mcp list', false],
			['vim claude', false],
			['/bin/zsh -il', false],
			['node server.js', false],
			['', false],
		]);
	});

	test('runsClaude', () => {
		assert.deepStrictEqual([
			runsClaude([]),
			runsClaude([{ commandLine: 'git status', session: false }]),
			runsClaude([{ commandLine: 'git status', session: false }, { commandLine: 'claude --continue', session: false }]),
			// A process with a Claude session file is Claude, whatever its command line says.
			runsClaude([{ commandLine: '2.1.303', session: true }]),
		], [false, false, true, true]);
	});

	test('titleShowsClaude', () => {
		const titles: [string | undefined, string | undefined][] = [
			['\u2733 Claude Code', 'zsh'],
			['\u2733 Fix the Reader detection', 'zsh'],
			['\u280b Fix the Reader detection', 'zsh'],
			[undefined, '2.1.303'],
			['zsh', 'zsh'],
			['Agent 2', 'zsh'],
			['claude.md - vim', 'vim'],
			[undefined, undefined],
		];
		assert.deepStrictEqual(titles.map(([sequence, processName]) => titleShowsClaude(sequence, processName)), [true, true, true, true, false, false, false, false]);
	});

	test('MautClaudePresence over time', () => {
		const presence = new MautClaudePresence();
		const steps: [string, () => void][] = [
			['nothing yet', () => presence.observe(false, false, 0)],
			// Claude started without shell integration seeing it (restored terminal, alias, `cd x && claude`).
			['process appears', () => presence.observe(true, false, 3000)],
			// The topic replaced "Claude Code" in the title: the process still says Claude.
			['title lost', () => presence.observe(true, false, 6000)],
			['one missed reading', () => presence.observe(false, false, 9000)],
			['back', () => presence.observe(true, false, 12000)],
			['missed once', () => presence.observe(false, false, 15000)],
			['missed twice: gone', () => presence.observe(false, false, 18000)],
			['shell integration sees claude start', () => presence.commandStarted(20000)],
			['process not up yet', () => presence.observe(false, false, 21000)],
			['still starting', () => presence.observe(false, false, 24000)],
			['shell integration sees it finish', () => presence.commandFinished()],
			['process table unreadable, title says Claude', () => presence.observe(undefined, true, 30000)],
			['process table unreadable, no title', () => presence.observe(undefined, false, 33000)],
		];
		assert.deepStrictEqual(steps.map(([name, step]) => {
			step();
			return [name, presence.running];
		}), [
			['nothing yet', false],
			['process appears', true],
			['title lost', true],
			['one missed reading', true],
			['back', true],
			['missed once', true],
			['missed twice: gone', false],
			['shell integration sees claude start', true],
			['process not up yet', true],
			['still starting', true],
			['shell integration sees it finish', false],
			['process table unreadable, title says Claude', true],
			['process table unreadable, no title', false],
		]);
	});
});
