/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dovo's system monitor: CPU, memory, thermal state, battery and disk, sampled cheaply. The
// workbench shows it next to the command center and asks for a fresh sample every few seconds.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';

/** What the title bar readout and its hover show. Sizes are in bytes, percentages 0..100. */
export interface ISystemSample {
	readonly platform: NodeJS.Platform;
	readonly cpu: number;
	readonly cores: readonly number[];
	readonly load: readonly number[];
	readonly memory: {
		readonly total: number;
		readonly used: number;
		readonly app?: number;
		readonly wired?: number;
		readonly compressed?: number;
		readonly cached?: number;
		readonly pressure?: 'normal' | 'warn' | 'critical';
		readonly swapUsed?: number;
		readonly swapTotal?: number;
	};
	readonly dovo?: { readonly cpu: number; readonly memory: number; readonly processes: number };
	readonly thermal?: { readonly state: 'nominal' | 'fair' | 'serious' | 'critical'; readonly speedLimit?: number };
	readonly battery?: { readonly percent: number; readonly charging: boolean; readonly remaining?: string };
	readonly disk?: { readonly free: number; readonly total: number };
	readonly uptime: number;
}

/** How long the slower readings are reused before they're read again. */
const slowEvery = 30_000;
const processesEvery = 10_000;

function run(command: string, args: string[]): Promise<string> {
	return new Promise(resolve => {
		execFile(command, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : stdout));
	});
}

interface ICpuTimes { readonly idle: number; readonly total: number }

function cpuTimes(): ICpuTimes[] {
	return os.cpus().map(cpu => {
		const t = cpu.times;
		return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
	});
}

class SystemStats {

	private _cpuBefore = cpuTimes();
	private _slowAt = 0;
	private _slow: Pick<ISystemSample, 'thermal' | 'battery' | 'disk'> = {};
	private _processesAt = 0;
	private _dovo: ISystemSample['dovo'];
	private readonly _appRoot = appRoot();

	async sample(): Promise<ISystemSample> {
		const now = Date.now();
		const cpuNow = cpuTimes();
		const cores = cpuNow.map((times, i) => {
			const before = this._cpuBefore[i];
			const total = times.total - (before?.total ?? 0);
			const idle = times.idle - (before?.idle ?? 0);
			return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0;
		});
		this._cpuBefore = cpuNow;
		const cpu = cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : 0;
		const [memory] = await Promise.all([
			this._memory(),
			now - this._slowAt > slowEvery ? this._readSlow(now) : Promise.resolve(),
			now - this._processesAt > processesEvery ? this._readDovo(now) : Promise.resolve(),
		]);
		return {
			platform: process.platform,
			cpu,
			cores,
			load: os.loadavg(),
			memory,
			dovo: this._dovo,
			...this._slow,
			uptime: os.uptime(),
		};
	}

	private async _memory(): Promise<ISystemSample['memory']> {
		const total = os.totalmem();
		if (process.platform !== 'darwin') {
			return { total, used: total - os.freemem() };
		}
		const [vmStat, pressure, swap] = await Promise.all([
			run('/usr/bin/vm_stat', []),
			run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
			run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
		]);
		const pageSize = Number(/page size of (?<size>\d+) bytes/.exec(vmStat)?.groups?.size ?? 16384);
		const pages = (label: string) => Number(new RegExp(`${label}:\\s+(?<n>\\d+)`).exec(vmStat)?.groups?.n ?? 0) * pageSize;
		// How Activity Monitor counts it: app memory (anonymous minus purgeable), wired and compressed.
		const app = Math.max(0, pages('Anonymous pages') - pages('Pages purgeable'));
		const wired = pages('Pages wired down');
		const compressed = pages('Pages occupied by compressor');
		const cached = pages('File-backed pages') + pages('Pages purgeable');
		const level = Number(pressure.trim());
		const swapUsed = parseSize(/used = (?<v>[\d.]+[KMGT]?)/.exec(swap)?.groups?.v);
		const swapTotal = parseSize(/total = (?<v>[\d.]+[KMGT]?)/.exec(swap)?.groups?.v);
		return {
			total,
			used: vmStat ? Math.min(total, app + wired + compressed) : total - os.freemem(),
			app,
			wired,
			compressed,
			cached,
			pressure: level >= 4 ? 'critical' : level >= 2 ? 'warn' : 'normal',
			swapUsed,
			swapTotal,
		};
	}

	private async _readSlow(now: number): Promise<void> {
		this._slowAt = now;
		const slow: { -readonly [K in 'thermal' | 'battery' | 'disk']?: ISystemSample[K] } = {};
		try {
			const stats = await fs.promises.statfs(process.platform === 'win32' ? (process.env.SystemDrive ?? 'C:') + '\\' : '/');
			slow.disk = { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
		} catch {
			// statfs isn't available everywhere.
		}
		if (process.platform === 'darwin') {
			const [therm, batt] = await Promise.all([run('/usr/bin/pmset', ['-g', 'therm']), run('/usr/bin/pmset', ['-g', 'batt'])]);
			const speedLimit = Number(/CPU_Speed_Limit\s*=\s*(?<n>\d+)/.exec(therm)?.groups?.n ?? 100);
			const warning = Number(/[Tt]hermal [Ww]arning [Ll]evel\s*[=:]?\s*(?<n>\d+)/.exec(therm)?.groups?.n ?? 0);
			slow.thermal = {
				state: warning >= 3 || speedLimit < 50 ? 'critical' : warning >= 2 || speedLimit < 80 ? 'serious' : warning >= 1 || speedLimit < 100 ? 'fair' : 'nominal',
				speedLimit: speedLimit < 100 ? speedLimit : undefined,
			};
			const battery = /(?<percent>\d+)%;\s*(?<state>[^;]+);\s*(?<remaining>[^\s]+)?/.exec(batt)?.groups;
			if (battery) {
				const state = battery.state.trim();
				slow.battery = {
					percent: Number(battery.percent),
					charging: state === 'charging' || state === 'charged' || state === 'finishing charge',
					remaining: battery.remaining && /^\d+:\d+$/.test(battery.remaining) && battery.remaining !== '0:00' ? battery.remaining : undefined,
				};
			}
		}
		this._slow = slow;
	}

	/** CPU and memory of every Dovo process (main, renderers, extension host, terminals' hosts). */
	private async _readDovo(now: number): Promise<void> {
		this._processesAt = now;
		if (process.platform === 'win32' || !this._appRoot) {
			return;
		}
		const table = await run('/bin/ps', ['-axo', 'pcpu=,rss=,command=']);
		let cpu = 0;
		let memory = 0;
		let processes = 0;
		for (const line of table.split('\n')) {
			const match = /^\s*(?<cpu>[\d.]+)\s+(?<rss>\d+)\s+(?<command>.*)$/.exec(line);
			if (!match?.groups || !match.groups.command.startsWith(this._appRoot)) {
				continue;
			}
			cpu += Number(match.groups.cpu);
			memory += Number(match.groups.rss) * 1024;
			processes++;
		}
		this._dovo = processes ? { cpu, memory, processes } : undefined;
	}
}

/** The running app's bundle (macOS) or install folder, to find all of Dovo's processes. */
function appRoot(): string | undefined {
	const exec = process.execPath;
	const bundle = /^(?<root>.*?\.app)\//.exec(exec)?.groups?.root;
	return bundle ?? undefined;
}

function parseSize(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const match = /^(?<n>[\d.]+)(?<unit>[KMGT]?)$/.exec(value);
	if (!match?.groups) {
		return undefined;
	}
	const factor = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match.groups.unit] ?? 1;
	return Number(match.groups.n) * factor;
}

/** Registers the commands the workbench's title bar readout uses. */
export function registerSystemStats(context: vscode.ExtensionContext): void {
	const stats = new SystemStats();
	context.subscriptions.push(
		vscode.commands.registerCommand('_dovo.systemMonitor.sample', () => stats.sample()),
		vscode.commands.registerCommand('_dovo.systemMonitor.openActivityMonitor', () => {
			if (process.platform === 'darwin') {
				execFile('/usr/bin/open', ['-a', 'Activity Monitor']);
			} else if (process.platform === 'win32') {
				execFile('taskmgr.exe');
			}
		}),
	);
}
