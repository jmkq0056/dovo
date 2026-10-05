/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Converters: docx/xlsx/csv/pdf/html  →  TXT or JSON.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildOutName } from './tempStore';

export async function fileToTxt(uri: vscode.Uri): Promise<string | undefined> {
	const ext = path.extname(uri.fsPath).toLowerCase();
	const src = uri.fsPath;
	switch (ext) {
		case '.docx':
		case '.doc':
			return docxToTxt(src);
		case '.xlsx':
		case '.xls':
			return xlsxToTxt(src);
		case '.csv':
		case '.tsv':
			return csvToTxt(src);
		case '.pdf':
			return pdfToTxt(src);
		case '.html':
		case '.htm':
			return htmlToTxt(src);
		default:
			vscode.window.showWarningMessage(`Dovo: no TXT converter for ${ext}.`);
			return undefined;
	}
}

export async function fileToJson(uri: vscode.Uri): Promise<string | undefined> {
	const ext = path.extname(uri.fsPath).toLowerCase();
	const src = uri.fsPath;
	switch (ext) {
		case '.xlsx':
		case '.xls':
			return xlsxToJson(src);
		case '.csv':
		case '.tsv':
			return csvToJson(src);
		default:
			vscode.window.showWarningMessage(`Dovo: no JSON converter for ${ext}.`);
			return undefined;
	}
}

async function docxToTxt(src: string): Promise<string> {
	const mammoth = await import('mammoth');
	const result = await mammoth.extractRawText({ path: src });
	const out = buildOutName(src, '', 'txt');
	fs.writeFileSync(out, result.value);
	return out;
}

async function xlsxToTxt(src: string): Promise<string> {
	const XLSX = await import('xlsx');
	const wb = XLSX.readFile(src);
	const lines: string[] = [];
	for (const sheetName of wb.SheetNames) {
		lines.push(`# Sheet: ${sheetName}`);
		const text = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName], { FS: '\t' });
		lines.push(text);
		lines.push('');
	}
	const out = buildOutName(src, '', 'txt');
	fs.writeFileSync(out, lines.join('\n'));
	return out;
}

async function xlsxToJson(src: string): Promise<string> {
	const XLSX = await import('xlsx');
	const wb = XLSX.readFile(src);
	const obj: Record<string, unknown[]> = {};
	for (const sheetName of wb.SheetNames) {
		obj[sheetName] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
	}
	const out = buildOutName(src, '', 'json');
	fs.writeFileSync(out, JSON.stringify(obj, null, 2));
	return out;
}

async function csvToTxt(src: string): Promise<string> {
	const data = fs.readFileSync(src);
	const out = buildOutName(src, '', 'txt');
	fs.writeFileSync(out, data);
	return out;
}

async function csvToJson(src: string): Promise<string> {
	const raw = fs.readFileSync(src, 'utf8');
	const isTsv = path.extname(src).toLowerCase() === '.tsv';
	const sep = isTsv ? '\t' : ',';
	const lines = raw.split(/\r?\n/).filter(l => l.length > 0);
	if (lines.length === 0) {
		const out = buildOutName(src, '', 'json');
		fs.writeFileSync(out, '[]');
		return out;
	}
	const headers = lines[0].split(sep).map(h => h.trim());
	const rows = lines.slice(1).map(line => {
		const cells = line.split(sep);
		const obj: Record<string, string> = {};
		headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
		return obj;
	});
	const out = buildOutName(src, '', 'json');
	fs.writeFileSync(out, JSON.stringify(rows, null, 2));
	return out;
}

async function pdfToTxt(src: string): Promise<string> {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const data = new Uint8Array(fs.readFileSync(src));
	const loadingTask = pdfjs.getDocument({ data });
	const doc = await loadingTask.promise;
	const parts: string[] = [];
	for (let i = 1; i <= doc.numPages; i++) {
		const page = await doc.getPage(i);
		const text = await page.getTextContent();
		const line = (text.items as Array<{ str?: string }>).map(t => t.str ?? '').join(' ');
		parts.push(`# Page ${i}\n${line}\n`);
	}
	const out = buildOutName(src, '', 'txt');
	fs.writeFileSync(out, parts.join('\n'));
	return out;
}

async function htmlToTxt(src: string): Promise<string> {
	const raw = fs.readFileSync(src, 'utf8');
	const stripped = raw
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const out = buildOutName(src, '', 'txt');
	fs.writeFileSync(out, stripped);
	return out;
}

/** Returns absolute path to LibreOffice's `soffice` binary if installed, else undefined. */
function findSoffice(): string | undefined {
	const candidates = [
		'/Applications/LibreOffice.app/Contents/MacOS/soffice',
		'/opt/homebrew/bin/soffice',
		'/usr/local/bin/soffice',
		'/usr/bin/soffice',
	];
	for (const c of candidates) {
		try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* skip */ }
	}
	return undefined;
}

function appExists(appName: string): boolean {
	const candidates = [
		`/Applications/${appName}.app`,
		`/System/Applications/${appName}.app`,
	];
	return candidates.some(c => { try { fs.accessSync(c); return true; } catch { return false; } });
}

function runOsa(script: string): Promise<{ code: number; stderr: string }> {
	return new Promise(resolve => {
		execFile('osascript', ['-e', script], (err, _stdout, stderr) => {
			resolve({
				code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
				stderr: String(stderr ?? ''),
			});
		});
	});
}

async function convertViaLibreOffice(soffice: string, src: string, outDir: string): Promise<string | undefined> {
	await new Promise<void>((resolve, reject) => {
		execFile(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, src], (err) => {
			if (err) { reject(err); } else { resolve(); }
		});
	});
	const base = path.basename(src, path.extname(src));
	const produced = path.join(outDir, `${base}.pdf`);
	return fs.existsSync(produced) ? produced : undefined;
}

async function convertViaWord(src: string, out: string): Promise<boolean> {
	// Microsoft Word AppleScript: open, save as PDF, close without saving.
	const script = `
		tell application "Microsoft Word"
			set theDoc to open file name (POSIX file ${JSON.stringify(src)} as string)
			save as theDoc file name (POSIX file ${JSON.stringify(out)} as string) file format format PDF
			close theDoc saving no
		end tell
	`;
	const r = await runOsa(script);
	if (r.code !== 0) {
		vscode.window.showErrorMessage(`Microsoft Word conversion failed: ${r.stderr.trim().slice(0, 400)}`);
		return false;
	}
	return fs.existsSync(out);
}

async function convertViaPowerPoint(src: string, out: string): Promise<boolean> {
	const script = `
		tell application "Microsoft PowerPoint"
			set thePres to open POSIX file ${JSON.stringify(src)}
			save thePres in POSIX file ${JSON.stringify(out)} as save as PDF
			close thePres saving no
		end tell
	`;
	const r = await runOsa(script);
	if (r.code !== 0) {
		vscode.window.showErrorMessage(`Microsoft PowerPoint conversion failed: ${r.stderr.trim().slice(0, 400)}`);
		return false;
	}
	return fs.existsSync(out);
}

export async function officeToPdf(uri: vscode.Uri): Promise<string | undefined> {
	const src = uri.fsPath;
	const ext = path.extname(src).toLowerCase();
	const outBase = buildOutName(src, '', 'pdf');
	const outDir = path.dirname(outBase);

	// 1) Try LibreOffice
	const soffice = findSoffice();
	if (soffice) {
		try {
			const produced = await convertViaLibreOffice(soffice, src, outDir);
			if (produced) { return produced; }
		} catch { /* fall through */ }
	}

	// 2) Try Microsoft Office app for the right extension
	if (ext === '.docx' || ext === '.doc') {
		if (appExists('Microsoft Word')) {
			const ok = await convertViaWord(src, outBase);
			if (ok) { return outBase; }
		}
	} else if (ext === '.pptx' || ext === '.ppt') {
		if (appExists('Microsoft PowerPoint')) {
			const ok = await convertViaPowerPoint(src, outBase);
			if (ok) { return outBase; }
		}
	}

	vscode.window.showErrorMessage('Dovo: no converter available. Install LibreOffice.app, or Microsoft Word / PowerPoint, to convert this file to PDF.');
	return undefined;
}
