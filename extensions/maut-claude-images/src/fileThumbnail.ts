/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Where thumbnails are kept, named after the file and its last change, so an edit makes a new one. */
const cacheDir = path.join(os.tmpdir(), 'dovo-thumbnails');
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const pending = new Map<string, Promise<string | undefined>>();

/**
 * A picture of `file` for a chip in Claude's pane: images as they are, anything else (a PDF's
 * first page, a document, a video frame) from macOS Quick Look. Undefined where there's none.
 */
export async function fileThumbnail(file: string): Promise<string | undefined> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(file);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) {
		return undefined;
	}
	if (imageExtensions.has(path.extname(file).toLowerCase())) {
		return file;
	}
	if (process.platform !== 'darwin') {
		return undefined;
	}
	const key = createHash('sha1').update(`${file}:${stat.mtimeMs}`).digest('hex').slice(0, 16);
	const target = path.join(cacheDir, key);
	const known = pending.get(key);
	if (known) {
		return known;
	}
	const made = makeThumbnail(file, target);
	pending.set(key, made);
	return made;
}

async function makeThumbnail(file: string, target: string): Promise<string | undefined> {
	const output = path.join(target, `${path.basename(file)}.png`);
	if (fs.existsSync(output)) {
		return output;
	}
	await fs.promises.mkdir(target, { recursive: true });
	await new Promise<void>(resolve => execFile('/usr/bin/qlmanage', ['-t', '-s', '480', '-o', target, file], { timeout: 10000 }, () => resolve()));
	return fs.existsSync(output) ? output : undefined;
}
