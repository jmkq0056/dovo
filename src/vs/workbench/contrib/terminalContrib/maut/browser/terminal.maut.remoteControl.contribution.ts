/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';

const remoteControlUrlRegex = /https:\/\/claude\.ai\/code\/(?<session>session_[A-Za-z0-9]+)/g;
const answeredSessionsKey = 'maut.remoteControl.answeredSessions';
const maxAnsweredSessions = 200;

/**
 * Sessions already offered in this window, shared by all terminals so a link visible in two
 * terminals (or redrawn many times by Claude's TUI) only prompts once.
 */
const offeredSessions = new Set<string>();

/**
 * When Claude Code's `/remote-control` prints its claude.ai session link, offer to continue the
 * session in the Claude desktop app (via its `claude://` deep link) instead of a browser tab.
 */
class TerminalClaudeRemoteControlContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.maut.remoteControl';

	private readonly _scheduledScan = this._register(new MutableDisposable());
	private _xterm: RawXtermTerminal | undefined;

	constructor(
		_ctx: ITerminalContributionContext,
		@IDialogService private readonly _dialogService: IDialogService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
	}

	xtermOpen(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this._xterm = xterm.raw;
		this._register(xterm.raw.onRender(() => this._scheduleScan()));
	}

	private _scheduleScan(): void {
		const element = this._xterm?.element;
		if (this._scheduledScan.value || !element) {
			return;
		}
		this._scheduledScan.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(element), () => {
			this._scheduledScan.clear();
			this._scan();
		});
	}

	private _scan(): void {
		const xterm = this._xterm;
		if (!xterm) {
			return;
		}
		const buffer = xterm.buffer.active;
		// Join soft-wrapped rows so a link split across the terminal width still matches.
		let text = '';
		for (let row = 0; row < xterm.rows; row++) {
			const line = buffer.getLine(buffer.viewportY + row);
			if (!line) {
				continue;
			}
			text += (line.isWrapped ? '' : '\n') + line.translateToString(true);
		}
		if (!text.includes('claude.ai/code/session_')) {
			return;
		}
		for (const match of text.matchAll(remoteControlUrlRegex)) {
			const session = match.groups?.session;
			if (session && !offeredSessions.has(session) && !this._getAnsweredSessions().includes(session)) {
				offeredSessions.add(session);
				this._offer(session);
			}
		}
	}

	private async _offer(session: string): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			type: 'question',
			message: localize('maut.remoteControl.message', "Continue this session in the Claude app?"),
			detail: localize('maut.remoteControl.detail', "Remote Control is on. Open {0} in the Claude desktop app to keep working from there.", session),
			primaryButton: localize({ key: 'maut.remoteControl.open', comment: ['&& denotes a mnemonic'] }, "&&Open in Claude App"),
			cancelButton: localize('maut.remoteControl.notNow', "Not Now"),
		});
		this._rememberAnswered(session);
		if (confirmed) {
			await this._openerService.open(URI.parse(`claude://claude.ai/code/${session}`), { openExternal: true });
		}
	}

	private _getAnsweredSessions(): string[] {
		try {
			const value = JSON.parse(this._storageService.get(answeredSessionsKey, StorageScope.APPLICATION, '[]'));
			return Array.isArray(value) ? value : [];
		} catch {
			return [];
		}
	}

	private _rememberAnswered(session: string): void {
		const sessions = this._getAnsweredSessions().filter(s => s !== session);
		sessions.push(session);
		this._storageService.store(answeredSessionsKey, JSON.stringify(sessions.slice(-maxAnsweredSessions)), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

registerTerminalContribution(TerminalClaudeRemoteControlContribution.ID, TerminalClaudeRemoteControlContribution);
