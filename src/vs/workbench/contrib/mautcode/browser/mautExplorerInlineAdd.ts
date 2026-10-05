/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Maut code: inline `@` button on every row in the file explorer that runs
//  `maut.cli.add` with that row's resource — adds the file/folder to the active
//  Maut Claude terminal as an @-mention without needing a right-click.

import * as DOM from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IExplorerFileContribution, explorerFileContribRegistry } from '../../files/browser/explorerFileContrib.js';

class MautExplorerInlineAddContribution extends Disposable implements IExplorerFileContribution {

	private resource: URI | undefined;
	private readonly button: HTMLAnchorElement;

	constructor(
		container: HTMLElement,
		@ICommandService commandService: ICommandService,
	) {
		super();
		const button = document.createElement('a');
		button.className = 'maut-explorer-inline-add codicon codicon-mention';
		button.title = 'Add to Claude';
		button.setAttribute('role', 'button');
		button.style.display = 'none';
		container.appendChild(button);
		this.button = button;

		this._register(DOM.addDisposableListener(button, 'click', (e) => {
			DOM.EventHelper.stop(e, true);
			if (this.resource) {
				commandService.executeCommand('maut.cli.add', this.resource).catch(() => { });
			}
		}));
		this._register(DOM.addDisposableListener(button, 'mousedown', (e) => {
			DOM.EventHelper.stop(e, true);
		}));
	}

	setResource(resource: URI | undefined): void {
		this.resource = resource;
		this.button.style.display = resource ? 'inline-flex' : 'none';
	}

	override dispose(): void {
		this.button.remove();
		super.dispose();
	}
}

explorerFileContribRegistry.register({
	create: (insta, container) => insta.createInstance(MautExplorerInlineAddContribution, container),
});
