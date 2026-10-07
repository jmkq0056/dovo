/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** markdown-it-task-lists ships no types: the plugin and the options this extension passes. */
declare module 'markdown-it-task-lists' {
	import type { PluginWithOptions } from 'markdown-it';
	const taskLists: PluginWithOptions<{ enabled?: boolean; label?: boolean; labelAfter?: boolean }>;
	export default taskLists;
}
