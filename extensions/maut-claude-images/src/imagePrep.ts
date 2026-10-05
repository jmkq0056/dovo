/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Images handed to Claude: pasted or dropped files arrive as plain absolute paths so Claude
// attaches them as images, and HEIC/HEIF photos (which Claude can't read) become JPEGs first.

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const HEIC_EXTS = new Set(['.heic', '.heif']);
const CONVERT_TIMEOUT = 20_000;
const CACHE_DIR = path.join(os.tmpdir(), 'dovo-heic');

let warnedNoConverter = false;

function run(command: string, args: string[], timeout = CONVERT_TIMEOUT): Promise<{ ok: boolean; stdout: string }> {
	return new Promise(resolve => {
		execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') }));
	});
}

function expandHome(p: string): string {
	return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** A HEIC/HEIF photo as a JPEG in Dovo's cache (reused while the photo is unchanged), or undefined. */
async function heicToJpeg(file: string, stat: fs.Stats): Promise<string | undefined> {
	const key = crypto.createHash('sha1').update(`${file}\0${stat.mtimeMs}\0${stat.size}`).digest('hex').slice(0, 16);
	const base = path.basename(file).replace(/\.(heic|heif)$/i, '');
	const out = path.join(CACHE_DIR, `${base}-${key}.jpg`);
	if (fs.existsSync(out)) {
		return out;
	}
	await fs.promises.mkdir(CACHE_DIR, { recursive: true });
	const attempts: [string, string[]][] = process.platform === 'darwin'
		? [['/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', file, '--out', out]]]
		: [['magick', [file, out]], ['heif-convert', [file, out]]];
	for (const [command, args] of attempts) {
		const { ok } = await run(command, args);
		if (ok && fs.existsSync(out)) {
			return out;
		}
	}
	if (!warnedNoConverter) {
		warnedNoConverter = true;
		void vscode.window.showWarningMessage(process.platform === 'darwin'
			? `Dovo couldn't convert ${path.basename(file)} to JPEG, so Claude may not be able to read it.`
			: `Dovo can't convert HEIC photos here (install ImageMagick or libheif), so Claude may not be able to read ${path.basename(file)}.`);
	}
	return undefined;
}

/**
 * Absolute paths ready for Claude, in the same order: `~` expanded, HEIC/HEIF converted to JPEG.
 * A path that doesn't exist comes back as `undefined`, so callers can keep today's behaviour.
 */
export async function prepareImages(paths: readonly string[]): Promise<(string | undefined)[]> {
	return Promise.all(paths.map(async raw => {
		const file = path.resolve(expandHome(String(raw)));
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(file);
		} catch {
			return undefined;
		}
		if (!stat.isFile()) {
			return file;
		}
		if (HEIC_EXTS.has(path.extname(file).toLowerCase())) {
			return (await heicToJpeg(file, stat)) ?? file;
		}
		return file;
	}));
}

/**
 * The files copied in Finder (all of them, not just their names, which is all the clipboard's
 * text holds), or an empty list. macOS only.
 */
export async function clipboardFilePaths(): Promise<string[]> {
	if (process.platform !== 'darwin') {
		return [];
	}
	const script = [
		'ObjC.import("AppKit");',
		'var pb = $.NSPasteboard.generalPasteboard;',
		'var urls = pb.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), $.NSDictionary.dictionaryWithObjectForKey(true, "NSPasteboardURLReadingFileURLsOnlyKey"));',
		'var out = [];',
		'if (urls) { for (var i = 0; i < urls.count; i++) { out.push(urls.objectAtIndex(i).path.js); } }',
		'JSON.stringify(out);',
	].join(' ');
	const { ok, stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], 4000);
	if (!ok) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(stdout.trim() || '[]');
		return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
	} catch {
		return [];
	}
}
