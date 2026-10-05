/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../../../platform/commands/common/commands.js';

/** Contributed by the built-in `maut-claude-images` extension. */
const prepareCommandId = '_maut.images.prepare';
const clipboardFilesCommandId = '_maut.images.clipboardFiles';

const imageExtension = /\.(?:png|jpe?g|gif|webp|heic|heif)$/i;
/** Characters a shell (and Claude's path detection) needs escaped in a path, as Terminal.app does on drop. */
const shellSpecial = /[\s()'"&;$!*?[\]{}<>|\\`#~]/g;

/** Whether a path names an image Claude can attach (HEIC/HEIF become JPEGs first). */
export function isImagePath(path: string): boolean {
	return imageExtension.test(path);
}

/** A path escaped the way macOS Terminal pastes a dropped file: `/Users/me/My\ Photo.png`. */
export function escapePathForClaude(path: string): string {
	return path.replace(shellSpecial, match => `\\${match}`);
}

/**
 * Paths in pasted text: one per line, or several on one line separated by spaces when each is
 * escaped or quoted (`'/a b.png' /c.png`, `/a\ b.png /c.png`), `file://` URLs too. Undefined
 * unless every part is an absolute (or `~/`) path.
 */
export function pathsFromText(text: string): string[] | undefined {
	const parts: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const tokens = splitShellWords(line);
		if (!tokens) {
			return undefined;
		}
		// A single unescaped path with spaces arrives as several tokens: take the line whole.
		if (tokens.length > 1 && !tokens.every(token => isAbsolutePathLike(token))) {
			if (!isAbsolutePathLike(line)) {
				return undefined;
			}
			parts.push(line);
			continue;
		}
		parts.push(...tokens);
	}
	const paths = parts.map(part => part.startsWith('file://') ? decodeURIComponent(part.slice('file://'.length)) : part);
	return paths.length && paths.every(isAbsolutePathLike) ? paths : undefined;
}

function isAbsolutePathLike(path: string): boolean {
	return path.startsWith('/') || path.startsWith('~/') || path.startsWith('file:///') || /^[a-zA-Z]:[\\/]/.test(path);
}

/** Splits a line into shell words, honouring quotes and backslash escapes; undefined if unbalanced. */
function splitShellWords(line: string): string[] | undefined {
	const words: string[] = [];
	let current = '';
	let quote: '\'' | '"' | undefined;
	let inWord = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else if (ch === '\\' && quote === '"' && i + 1 < line.length) {
				current += line[++i];
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '\'' || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (ch === '\\' && i + 1 < line.length) {
			current += line[++i];
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (inWord) {
				words.push(current);
				current = '';
				inWord = false;
			}
		} else {
			current += ch;
			inWord = true;
		}
	}
	if (quote) {
		return undefined;
	}
	if (inWord) {
		words.push(current);
	}
	return words;
}

/**
 * Image paths ready for Claude: absolute, existing, HEIC/HEIF converted to JPEG. Undefined if the
 * extension isn't there or any of them doesn't exist.
 */
export async function prepareImagePaths(commandService: ICommandService, paths: readonly string[]): Promise<string[] | undefined> {
	try {
		const prepared = await commandService.executeCommand<(string | undefined)[]>(prepareCommandId, [...paths]);
		if (!prepared || prepared.length !== paths.length || prepared.some(path => !path)) {
			return undefined;
		}
		return prepared as string[];
	} catch {
		return undefined;
	}
}

/** The files copied in Finder (macOS), or an empty list. */
export async function clipboardFilePaths(commandService: ICommandService): Promise<string[]> {
	try {
		return (await commandService.executeCommand<string[]>(clipboardFilesCommandId)) ?? [];
	} catch {
		return [];
	}
}

/** What a paste of these image paths sends: escaped absolute paths separated by spaces, as Terminal.app does. */
export function imagePasteText(paths: readonly string[]): string {
	return paths.map(escapePathForClaude).join(' ');
}
