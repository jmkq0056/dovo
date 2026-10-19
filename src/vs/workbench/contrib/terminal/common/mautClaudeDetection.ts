/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How Dovo tells that Claude Code runs in a terminal.
 *
 * Claude's native installer names its binary after its version (`~/.local/share/claude/versions/2.1.303`),
 * so the process name is "2.1.303", not "claude"; its terminal title is "Claude Code" (after a U+2733 mark) only until the
 * chat has a topic; and its fullscreen view redraws only the cells that changed. So the process tree
 * under the terminal's shell decides, re-read every few seconds; shell integration's command line
 * and the title only stand in when the process table can't be read.
 */

/** `claude`, `clsp`, or Claude started by its path (`~/.local/bin/claude --continue`). */
export const claudeCommandRegex = /^\s*(?:\S*\/)?(?:claude|clsp)(?:\s|$)/;
/** One-off runs of claude that print and exit (no session to show): `claude -p ...`, `claude --version`, `claude mcp list`. */
export const claudeOneOffRegex = /^\s*(?:\S*\/)?claude\s+(?:-p\b|--print\b|-v\b|--version\b|-h\b|--help\b|update\b|mcp\b|config\b|doctor\b|install\b|setup-token\b|migrate-installer\b)/;

/** What follows `claude` in a one-off run: a subcommand or flag that prints and exits. */
const oneOffFirstArgument = /^(?:-v|--version|-h|--help|update|mcp|config|doctor|install|setup-token|migrate-installer)$/;
/** Programs that run Claude Code's JavaScript build (`node .../@anthropic-ai/claude-code/cli.js`, `npx @anthropic-ai/claude-code`). */
const scriptRunner = /^(?:node|nodejs|bun|deno|npx|bunx|pnpx)(?:\.exe)?$/i;
/** Claude Code's native build: one binary per version, under `.../claude/versions/`. */
const nativeBuildPath = /[\\/]claude[\\/]versions[\\/]/;
const packageName = /@anthropic-ai[\\/]claude-code(?:$|[\\/@])/;

/** A process under a terminal's shell, as the Dovo extension reads it from the process table. */
export interface IShellDescendant {
	/** Its argv, joined by spaces. */
	readonly commandLine: string;
	/** Claude Code keeps `~/.claude/sessions/<pid>.json` while it runs: this process has one. */
	readonly session: boolean;
}

function baseName(token: string): string {
	return token.replace(/^["']|["']$/g, '').split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd)$/i, '') ?? '';
}

/**
 * Whether a command line is an interactive Claude Code session: its native binary (by path, or run as
 * `claude`), or its JavaScript build run by node or a package runner. One-off runs that print and exit
 * (`claude -p`, `claude --version`, `claude mcp list`) don't count, nor does `claude` as an argument
 * of something else (`vim claude`).
 */
export function isClaudeCommandLine(commandLine: string): boolean {
	const tokens = commandLine.trim().split(/\s+/).filter(token => token.length > 0);
	if (!tokens.length) {
		return false;
	}
	let index = -1;
	if (baseName(tokens[0]) === 'claude' || nativeBuildPath.test(tokens[0])) {
		index = 0;
	} else if (scriptRunner.test(baseName(tokens[0]))) {
		index = tokens.slice(1, 4).findIndex(token => baseName(token) === 'claude' || packageName.test(token) || nativeBuildPath.test(token));
		index = index === -1 ? -1 : index + 1;
	}
	if (index === -1) {
		return false;
	}
	const rest = tokens.slice(index + 1);
	return !(rest.length && oneOffFirstArgument.test(rest[0])) && !rest.some(token => token === '-p' || token === '--print');
}

/** Whether any of a shell's descendants is Claude Code. */
export function runsClaude(descendants: readonly IShellDescendant[]): boolean {
	return descendants.some(process => process.session || isClaudeCommandLine(process.commandLine));
}

/**
 * Whether a terminal's title looks like Claude's: the title Claude sets (a U+2733 mark, or a spinner frame while it works,
 * then "Claude Code" or the chat's topic), or the process name its native binary has (a version, "2.1.303").
 */
export function titleShowsClaude(sequence: string | undefined, processName: string | undefined): boolean {
	return /^\s*[\u2733\u25d0-\u25d3\u2800-\u28ff]\s+\S/u.test(sequence ?? '') || /^\s*\d+\.\d+\.\d+\s*$/.test(processName ?? '');
}

/** How long after shell integration saw `claude` start its process may still be missing from the table. */
const startGrace = 10000;
/** Process readings in a row without Claude before it counts as gone: one missed reading isn't proof. */
const missesToEnd = 2;

/**
 * Whether Claude Code runs in one terminal, from every signal there is, re-evaluated on each:
 *
 * - The process table (authoritative when it can be read): Claude under the shell means running;
 *   missing from {@link missesToEnd} readings in a row means gone.
 * - Shell integration: `claude` starting counts at once (before the next reading), and finishing
 *   ends it at once.
 * - The title: only when the process table can't be read.
 */
export class MautClaudePresence {

	private _running = false;
	/** When shell integration saw a Claude command start, while it hasn't finished. */
	private _commandStartedAt: number | undefined;
	private _misses = 0;

	get running(): boolean {
		return this._running;
	}

	/** Shell integration saw an interactive `claude` start. */
	commandStarted(now: number): void {
		this._commandStartedAt = now;
		this._misses = 0;
		this._running = true;
	}

	/** Shell integration saw a `claude` command finish. */
	commandFinished(): void {
		this._commandStartedAt = undefined;
		this._misses = 0;
		this._running = false;
	}

	/**
	 * A reading: `process` is whether Claude is under the shell, undefined when the process table
	 * couldn't be read; `title` is {@link titleShowsClaude} for the terminal now.
	 */
	observe(process: boolean | undefined, title: boolean, now: number): void {
		if (process === undefined) {
			this._running = this._commandStartedAt !== undefined || title;
			return;
		}
		if (process) {
			this._misses = 0;
			this._running = true;
			return;
		}
		if (this._commandStartedAt !== undefined && now - this._commandStartedAt < startGrace) {
			return;
		}
		this._misses++;
		if (!this._running || this._misses >= missesToEnd) {
			this._commandStartedAt = undefined;
			this._running = false;
		}
	}
}
