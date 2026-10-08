/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Audio and video the editor's player (Chromium) can't play itself: AIFF, CAF, WMA, AMR, AVI,
// MKV, WMV, FLV and the like. Each is converted once, to AAC audio (.m4a) or H.264 video (.mp4),
// cached while the file is unchanged, and the player plays that. macOS converts audio with its
// own afconvert; anything else needs ffmpeg.

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

type MediaKind = 'audio' | 'video';

/** What Chromium plays as is: these never need converting. */
const PLAYABLE: Record<MediaKind, ReadonlySet<string>> = {
	audio: new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.m4b', '.aac', '.flac', '.opus', '.weba', '.mp4']),
	video: new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv']),
};

const CACHE_DIR = path.join(os.tmpdir(), 'dovo-media');
/** A long film takes a while to convert; it is done once. */
const CONVERT_TIMEOUT = 15 * 60_000;

const converting = new Map<string, Promise<string | undefined>>();
let warnedNoFfmpeg = false;

function run(command: string, args: string[]): Promise<boolean> {
	return new Promise(resolve => {
		execFile(command, args, { timeout: CONVERT_TIMEOUT, maxBuffer: 4 * 1024 * 1024 }, error => resolve(!error));
	});
}

/** ffmpeg from the PATH, or where Homebrew puts it (a GUI app's PATH often lacks it). */
async function findFfmpeg(): Promise<string | undefined> {
	const candidates = process.platform === 'win32'
		? ['ffmpeg.exe']
		: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];
	for (const candidate of candidates) {
		if (path.isAbsolute(candidate) ? fs.existsSync(candidate) : await run(candidate, ['-version'])) {
			return candidate;
		}
	}
	return undefined;
}

async function convert(file: string, kind: MediaKind, out: string): Promise<boolean> {
	const done = async (ok: boolean) => ok && fs.existsSync(out) && (await fs.promises.stat(out)).size > 0;
	if (kind === 'audio' && process.platform === 'darwin' && await done(await run('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', file, out]))) {
		return true;
	}
	const ffmpeg = await findFfmpeg();
	if (!ffmpeg) {
		return false;
	}
	if (kind === 'audio') {
		return done(await run(ffmpeg, ['-y', '-v', 'error', '-i', file, '-vn', '-c:a', 'aac', '-b:a', '192k', out]));
	}
	// Most MKV and AVI files already hold H.264 and AAC: moving them into an MP4 takes seconds.
	if (await done(await run(ffmpeg, ['-y', '-v', 'error', '-i', file, '-c', 'copy', '-movflags', '+faststart', out]))) {
		return true;
	}
	return done(await run(ffmpeg, ['-y', '-v', 'error', '-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]));
}

/**
 * The file to play for `file`: itself when the player handles its format, else a converted copy
 * in Dovo's cache, or undefined when nothing here can convert it (then the player says it can't).
 */
export async function playableMedia(file: string, kind: MediaKind): Promise<string | undefined> {
	const ext = path.extname(file).toLowerCase();
	if (PLAYABLE[kind].has(ext)) {
		return file;
	}
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(file);
	} catch {
		return undefined;
	}
	const key = crypto.createHash('sha1').update(`${file}\0${stat.mtimeMs}\0${stat.size}`).digest('hex').slice(0, 16);
	const out = path.join(CACHE_DIR, `${path.basename(file, ext)}-${key}${kind === 'audio' ? '.m4a' : '.mp4'}`);
	if (fs.existsSync(out)) {
		return out;
	}
	let pending = converting.get(out);
	if (!pending) {
		pending = (async () => {
			await fs.promises.mkdir(CACHE_DIR, { recursive: true });
			const partial = `${out}.part${kind === 'audio' ? '.m4a' : '.mp4'}`;
			if (await convert(file, kind, partial)) {
				await fs.promises.rename(partial, out);
				return out;
			}
			await fs.promises.rm(partial, { force: true });
			if (!warnedNoFfmpeg && !await findFfmpeg()) {
				warnedNoFfmpeg = true;
				void vscode.window.showInformationMessage(vscode.l10n.t("Dovo needs ffmpeg to play {0} files. Install it (on a Mac: brew install ffmpeg) and open the file again.", ext.slice(1).toUpperCase()));
			}
			return undefined;
		})().finally(() => converting.delete(out));
		converting.set(out, pending);
	}
	return pending;
}
