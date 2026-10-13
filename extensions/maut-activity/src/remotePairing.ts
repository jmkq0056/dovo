/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pairing Dovo Remote, the iPhone app that controls this Mac. The title bar's QR button shows a
// code that holds everything the phone needs to find this Mac: its name, the account to sign in
// as, and every address it can be reached at (Tailscale first, then the local network). When
// dovo-remote-host is installed the code also carries its secret token, and the phone streams
// from it (hardware video, direct input) instead of macOS Screen Sharing; the code is shown only
// on this Mac's own screen. Without the host the phone falls back to Screen Sharing and asks for
// the account password once.

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import qrcode from 'qrcode-generator';
import * as vscode from 'vscode';

/** What the workbench's pairing panel shows. */
interface IPairingInfo {
	readonly supported: boolean;
	readonly name: string;
	readonly user: string;
	readonly port: number;
	readonly hosts: readonly string[];
	/** Whether Screen Sharing answers on this Mac right now. */
	readonly sharing: boolean;
	/** Whether Dovo's own remote host (faster video streaming) answers right now. */
	readonly host: boolean;
	readonly tailscale: boolean;
	readonly url: string;
	/** The QR code, one string per row, '1' for a dark module. */
	readonly modules: readonly string[];
}

const SCREEN_SHARING_PORT = 5900;
/** Written by dovo-remote-host on its first run: the secret the phone proves itself with, and its port. */
const HOST_CONFIG = path.join(os.homedir(), '.dovo', 'remote-host.json');
const ID_KEY = 'dovo.remote.pairingId';
const TAILSCALE = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];

function run(command: string, args: string[]): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile(command, args, { timeout: 3000 }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
	});
}

/** The remote host's token and port, when it has been installed. */
async function hostConfig(): Promise<{ token: string; port: number } | undefined> {
	try {
		const config = JSON.parse(await fs.promises.readFile(HOST_CONFIG, 'utf8')) as { token?: string; port?: number };
		return config.token ? { token: config.token, port: config.port ?? 5961 } : undefined;
	} catch {
		return undefined;
	}
}

/** Whether something accepts connections on `port` on this Mac. */
function listening(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect({ host: '127.0.0.1', port });
		const done = (on: boolean) => {
			socket.destroy();
			resolve(on);
		};
		socket.setTimeout(800, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

/** Tailscale's MagicDNS name and addresses for this Mac, when Tailscale is installed and up. */
async function tailscaleHosts(): Promise<string[]> {
	const cli = TAILSCALE.find(candidate => fs.existsSync(candidate));
	if (!cli) {
		return [];
	}
	const output = await run(cli, ['status', '--json']);
	if (!output) {
		return [];
	}
	try {
		const status = JSON.parse(output) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } };
		if (status.BackendState !== 'Running' || !status.Self) {
			return [];
		}
		const hosts = (status.Self.TailscaleIPs ?? []).filter(address => net.isIPv4(address));
		const dnsName = status.Self.DNSName?.replace(/\.$/, '');
		return dnsName ? [dnsName, ...hosts] : hosts;
	} catch {
		return [];
	}
}

/** Tailscale hands out addresses in 100.64.0.0/10. */
function isTailscaleAddress(address: string): boolean {
	const [first, second] = address.split('.').map(Number);
	return first === 100 && second >= 64 && second <= 127;
}

async function pairingInfo(context: vscode.ExtensionContext): Promise<IPairingInfo> {
	let id = context.globalState.get<string>(ID_KEY);
	if (!id) {
		id = crypto.randomUUID();
		await context.globalState.update(ID_KEY, id);
	}
	const config = await hostConfig();
	const [computerName, localHostName, tailscale, sharing, host] = await Promise.all([
		run('/usr/sbin/scutil', ['--get', 'ComputerName']),
		run('/usr/sbin/scutil', ['--get', 'LocalHostName']),
		tailscaleHosts(),
		listening(SCREEN_SHARING_PORT),
		config ? listening(config.port) : Promise.resolve(false),
	]);
	const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => (entries ?? []).map(entry => ({ name, ...entry })));
	const tailscaleAddresses = interfaces.filter(entry => entry.family === 'IPv4' && isTailscaleAddress(entry.address)).map(entry => entry.address);
	// Wi-Fi and Ethernet only (en0, en1, ...): bridges for virtual machines and containers aren't reachable from the phone.
	const lan = interfaces.filter(entry => entry.family === 'IPv4' && /^en\d+$/.test(entry.name) && !entry.internal && !entry.address.startsWith('169.254.') && !isTailscaleAddress(entry.address)).map(entry => entry.address);
	const hosts = [...new Set([...tailscale, ...tailscaleAddresses, ...lan, ...(localHostName ? [`${localHostName}.local`] : [])])];
	const name = computerName || os.hostname();
	const user = os.userInfo().username;
	const query = [
		'v=1',
		`id=${encodeURIComponent(id)}`,
		`name=${encodeURIComponent(name)}`,
		`user=${encodeURIComponent(user)}`,
		`port=${SCREEN_SHARING_PORT}`,
		`hosts=${hosts.map(encodeURIComponent).join(',')}`,
		...(config ? [`token=${config.token}`, `hp=${config.port}`] : []),
	].join('&');
	const url = `dovo-remote://pair?${query}`;
	const qr = qrcode(0, 'M');
	qr.addData(url);
	qr.make();
	const modules: string[] = [];
	for (let row = 0; row < qr.getModuleCount(); row++) {
		let line = '';
		for (let column = 0; column < qr.getModuleCount(); column++) {
			line += qr.isDark(row, column) ? '1' : '0';
		}
		modules.push(line);
	}
	return { supported: true, name, user, port: SCREEN_SHARING_PORT, hosts, sharing, host, tailscale: tailscale.length > 0 || tailscaleAddresses.length > 0, url, modules };
}

/** Registers the commands the workbench's pairing panel uses. */
export function registerRemotePairing(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('_dovo.remote.pairing', async (): Promise<IPairingInfo> => {
			if (process.platform !== 'darwin') {
				return { supported: false, name: os.hostname(), user: '', port: SCREEN_SHARING_PORT, hosts: [], sharing: false, host: false, tailscale: false, url: '', modules: [] };
			}
			return pairingInfo(context);
		}),
		vscode.commands.registerCommand('_dovo.remote.openSharingSettings', () => {
			execFile('/usr/bin/open', ['x-apple.systempreferences:com.apple.Sharing-Settings.extension']);
		}),
	);
}
