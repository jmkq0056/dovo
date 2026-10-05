/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Maut code: workbench-level Maut contributions. Hides the auxiliary bar at startup and
 *  registers the inline "@" file-explorer button.
 */

import './media/mautcode.css';
import './mautExplorerInlineAdd.js';
import './mautTerminalAppearance.js';
import './mautTypeTrigger.js';
import './mautTripleClickReveal.js';
import './mautTabTidy.js';
import './mautFinder.js';
import './mautStartup.js';
import './mautChangeHighlight.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';

class MautCodeStartup extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.mautcode.startup';

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super();
		try {
			layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		} catch { /* noop */ }
	}
}

registerWorkbenchContribution2(MautCodeStartup.ID, MautCodeStartup, WorkbenchPhase.AfterRestored);
