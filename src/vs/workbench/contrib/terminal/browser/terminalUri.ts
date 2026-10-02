/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DataTransfers } from '../../../../base/browser/dnd.js';
import { Schemas } from '../../../../base/common/network.js';
import { CodeDataTransfers, getPathForFile } from '../../../../platform/dnd/browser/dnd.js';
import { URI } from '../../../../base/common/uri.js';
import { ITerminalInstance, TerminalDataTransfers } from './terminal.js';

export interface ITerminalUriMetadata {
	title?: string;
	commandId?: string;
	commandLine?: string;
}

export function parseTerminalUri(resource: URI): ITerminalIdentifier {
	const [, workspaceId, instanceId] = resource.path.split('/');
	if (!workspaceId || !Number.parseInt(instanceId)) {
		throw new Error(`Could not parse terminal uri for resource ${resource}`);
	}
	return { workspaceId, instanceId: Number.parseInt(instanceId) };
}

export function getTerminalUri(workspaceId: string, instanceId: number, title?: string, commandId?: string): URI {
	const params = new URLSearchParams();
	if (commandId) {
		params.set('command', commandId);
	}
	return URI.from({
		scheme: Schemas.vscodeTerminal,
		path: `/${workspaceId}/${instanceId}`,
		fragment: title || undefined,
		query: commandId ? params.toString() : undefined
	});
}


export interface ITerminalIdentifier {
	workspaceId: string;
	instanceId: number | undefined;
}

export interface IPartialDragEvent {
	dataTransfer: Pick<DataTransfer, 'getData'> | null;
}

/**
 * Every file and folder in a drag: from the explorer or editor tabs, or from the OS file manager.
 */
export function getFileResourcesFromDragEvent(event: DragEvent): URI[] {
	const dataTransfer = event.dataTransfer;
	if (!dataTransfer) {
		return [];
	}
	// The explorer's file list holds every selected item, folders included; its resource list
	// leaves folders out, so a mixed selection (a folder and a file, files from several folders)
	// must be read from the former.
	const rawCodeFiles = dataTransfer.getData(CodeDataTransfers.FILES);
	if (rawCodeFiles) {
		return (JSON.parse(rawCodeFiles) as string[]).map(file => URI.file(file));
	}
	const rawResources = dataTransfer.getData(DataTransfers.RESOURCES);
	if (rawResources) {
		return (JSON.parse(rawResources) as string[]).map(resource => URI.parse(resource));
	}
	const paths: URI[] = [];
	for (const file of dataTransfer.files) {
		const filePath = getPathForFile(file);
		if (filePath) {
			paths.push(URI.file(filePath));
		}
	}
	return paths;
}

export function getTerminalResourcesFromDragEvent(event: IPartialDragEvent): URI[] | undefined {
	const resources = event.dataTransfer?.getData(TerminalDataTransfers.Terminals);
	if (resources) {
		const json = JSON.parse(resources);
		const result = [];
		for (const entry of json) {
			result.push(URI.parse(entry));
		}
		return result.length === 0 ? undefined : result;
	}
	return undefined;
}

export function getInstanceFromResource<T extends Pick<ITerminalInstance, 'resource'>>(instances: T[], resource: URI | undefined): T | undefined {
	if (resource) {
		for (const instance of instances) {
			// Note that the URI's workspace and instance id might not originally be from this window
			// Don't bother checking the scheme and assume instances only contains terminals
			if (instance.resource.path === resource.path) {
				return instance;
			}
		}
	}
	return undefined;
}
