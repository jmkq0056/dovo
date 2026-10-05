/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

/** How much of a transcript is read at a time: a long session can be hundreds of megabytes. */
const chunkSize = 4 * 1024 * 1024;

/** Where reading a transcript left off: the byte offset read up to and an unfinished last line. */
export interface ITranscriptPosition {
	readonly offset: number;
	readonly partial: string;
}

/**
 * Reads a JSONL transcript from `position` to `end` a chunk at a time and hands each complete
 * line to `onLine`, so memory stays bounded however large the file has grown (reading it whole
 * ran the extension host out of memory on long sessions full of screenshots).
 */
export async function readTranscriptLines(file: string, position: ITranscriptPosition, end: number, onLine: (line: string) => void): Promise<ITranscriptPosition> {
	const handle = await fs.promises.open(file, 'r');
	const decoder = new StringDecoder('utf8');
	const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(1, end - position.offset)));
	let offset = position.offset;
	let partial = position.partial;
	try {
		while (offset < end) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
			if (!bytesRead) {
				break;
			}
			offset += bytesRead;
			const lines = (partial + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
			partial = lines.pop() ?? '';
			for (const line of lines) {
				onLine(line);
			}
		}
	} finally {
		await handle.close();
	}
	return { offset, partial: partial + decoder.end() };
}
