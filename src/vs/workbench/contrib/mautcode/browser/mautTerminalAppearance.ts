/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dovo: sets a terminal's name, icon and color without the user-facing pickers, and without
// focusing it: the terminal is found by its shell's process id (or its name), never "the active one".

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

interface ISetAppearanceArgs {
	processId?: number;
	terminalName?: string;
	name?: string;
	icon?: string;
	color?: string;
}

CommandsRegistry.registerCommand('maut.terminal.setAppearance', async (accessor, args?: ISetAppearanceArgs) => {
	if (!args) {
		return;
	}
	const terminalService = accessor.get(ITerminalService);
	const groupService = accessor.get(ITerminalGroupService);
	const all: ITerminalInstance[] = [...terminalService.instances, ...groupService.instances];
	let instance: ITerminalInstance | undefined;
	if (typeof args.processId === 'number') {
		instance = all.find(t => t.processId === args.processId);
	} else if (args.terminalName) {
		instance = all.find(t => t.title === args.terminalName || t.shellLaunchConfig?.name === args.terminalName);
	} else {
		instance = terminalService.activeInstance;
	}
	if (!instance) {
		return;
	}
	if (args.name) {
		try {
			await instance.rename(args.name);
		} catch {
			// The terminal went away meanwhile.
		}
	}
	if (args.icon) {
		try {
			await instance.changeIcon({ id: args.icon });
		} catch {
			// The terminal went away meanwhile.
		}
	}
	if (args.color) {
		try {
			await instance.changeColor(args.color, true);
		} catch {
			// The terminal went away meanwhile.
		}
	}
});
