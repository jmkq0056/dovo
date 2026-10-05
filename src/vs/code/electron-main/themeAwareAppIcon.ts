/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { FileAccess } from '../../base/common/network.js';
import { isMacintosh, isWindows } from '../../base/common/platform.js';

/**
 * Dovo's app icon follows the appearance: the bright icon in light mode and the dark one in dark
 * mode, in the macOS Dock and on Windows' taskbar and window frames. The appearance is the one the
 * workbench theme sets (which follows the system unless you pick a theme yourself).
 */
export class ThemeAwareAppIcon extends Disposable {

	constructor() {
		super();
		if (!isMacintosh && !isWindows) {
			return;
		}
		const onThemeUpdated = () => this._apply();
		nativeTheme.on('updated', onThemeUpdated);
		this._register(toDisposable(() => nativeTheme.removeListener('updated', onThemeUpdated)));
		if (isWindows) {
			const onWindowCreated = (_event: Electron.Event, window: BrowserWindow) => window.setIcon(this._image());
			app.on('browser-window-created', onWindowCreated);
			this._register(toDisposable(() => app.removeListener('browser-window-created', onWindowCreated)));
		}
		this._apply();
	}

	private _image(): Electron.NativeImage {
		const variant = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
		const platform = isMacintosh ? 'mac' : 'win';
		return nativeImage.createFromPath(FileAccess.asFileUri(`vs/code/electron-main/media/dovo-${platform}-${variant}.png`).fsPath);
	}

	private _apply(): void {
		const image = this._image();
		if (image.isEmpty()) {
			return;
		}
		if (isMacintosh) {
			app.dock?.setIcon(image);
		} else {
			for (const window of BrowserWindow.getAllWindows()) {
				window.setIcon(image);
			}
		}
	}
}
