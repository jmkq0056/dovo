/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

const closeAfterSetting = 'maut.tabs.closeAfterMinutes';
const sweepInterval = 60_000;
/** Schemes of editors that are safe to close and reopen by resource. */
const reopenableSchemes = new Set<string>([Schemas.file, Schemas.vscodeRemote, Schemas.vscodeUserData]);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'maut.tabs',
	title: localize('maut.tabs.title', "Dovo tabs"),
	type: 'object',
	properties: {
		[closeAfterSetting]: {
			type: 'number',
			default: 20,
			minimum: 0,
			markdownDescription: localize('maut.tabs.closeAfterMinutes', "Close editor tabs you haven't looked at for this many minutes. Pinned tabs, tabs with unsaved changes, terminals and visible tabs are never closed. `0` turns this off."),
		},
	},
});

/**
 * Closes editor tabs that have not been looked at for a while, so tabs don't pile up over a long
 * session. Only file-backed, saved, unpinned, non-visible editors qualify, and every sweep can be
 * undone from the notification it shows.
 */
class MautTabTidy extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.mautcode.tabTidy';

	/** When each editor was last the active editor (or first seen, for editors restored at startup). */
	private readonly _lastSeen = new WeakMap<EditorInput, number>();

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this._register(this._editorService.onDidActiveEditorChange(() => this._markSeen()));
		this._register(this._editorService.onDidVisibleEditorsChange(() => this._markSeen()));
		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this._sweep(), sweepInterval);
		this._markSeen();
	}

	private _markSeen(): void {
		const now = Date.now();
		for (const editor of this._editorService.visibleEditors) {
			this._lastSeen.set(editor, now);
		}
	}

	private _sweep(): void {
		const minutes = this._configurationService.getValue<number>(closeAfterSetting);
		if (!minutes || minutes <= 0) {
			return;
		}
		this._markSeen();
		const cutoff = Date.now() - minutes * 60_000;
		const visible = new Set(this._editorService.visibleEditors);
		const closed: URI[] = [];
		for (const group of this._editorGroupsService.groups) {
			const stale = group.editors.filter(editor => {
				const seen = this._lastSeen.get(editor);
				if (seen === undefined) {
					// Restored or opened in the background: start its clock now.
					this._lastSeen.set(editor, Date.now());
					return false;
				}
				return seen < cutoff
					&& !visible.has(editor)
					&& !group.isSticky(editor)
					&& !editor.isDirty()
					&& editor.typeId !== 'workbench.editors.terminal'
					&& !!editor.resource && reopenableSchemes.has(editor.resource.scheme);
			});
			if (stale.length) {
				closed.push(...stale.map(editor => editor.resource!));
				group.closeEditors(stale, { preserveFocus: true });
			}
		}
		if (!closed.length) {
			return;
		}
		this._notificationService.prompt(
			Severity.Info,
			closed.length === 1
				? localize('maut.tabs.closedOne', "Closed 1 tab you hadn't looked at in {0} minutes.", minutes)
				: localize('maut.tabs.closedMany', "Closed {0} tabs you hadn't looked at in {1} minutes.", closed.length, minutes),
			[{
				label: localize('maut.tabs.reopen', "Reopen"),
				run: () => this._editorService.openEditors(closed.map(resource => ({ resource, options: { pinned: true, inactive: true, preserveFocus: true } }))),
			}],
		);
	}
}

registerWorkbenchContribution2(MautTabTidy.ID, MautTabTidy, WorkbenchPhase.Eventually);
