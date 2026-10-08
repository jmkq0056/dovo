/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';

/**
 * Dovo: the file to play for `resource`. Formats the player can't handle (AIFF, WMA, MKV, AVI...)
 * come back converted, from Dovo's own extension, which may take a moment the first time; the
 * webview is then allowed to load from the converted copy's folder. Elsewhere (the web, no Dovo
 * extension) this is the resource itself.
 */
export async function playableResource(webviewEditor: vscode.WebviewPanel, resource: vscode.Uri, kind: 'audio' | 'video'): Promise<vscode.Uri> {
	if (resource.scheme !== 'file') {
		return resource;
	}
	let file: string | undefined;
	try {
		file = await vscode.commands.executeCommand<string | undefined>('_maut.media.playable', resource.fsPath, kind);
	} catch {
		return resource;
	}
	if (!file || file === resource.fsPath) {
		return resource;
	}
	const converted = vscode.Uri.file(file);
	const options = webviewEditor.webview.options;
	webviewEditor.webview.options = { ...options, localResourceRoots: [...(options.localResourceRoots ?? []), Utils.dirname(converted)] };
	return converted;
}
