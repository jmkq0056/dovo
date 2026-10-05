/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PDF Page Picker: a webview that renders every page of a PDF as a thumbnail with a checkbox,
//  then on submit extracts the selected pages into a fresh PDF in ~/.maut-tmp/ and posts an
//  @-mention into the Maut CLI.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { appendToMautCli } from './cliBridge';
import { buildOutName, sanitize } from './tempStore';

export async function openPdfPagePicker(extUri: vscode.Uri, sourceUri: vscode.Uri): Promise<void> {
	const panel = vscode.window.createWebviewPanel(
		'maut.pdfPagePicker',
		`Pick pages · ${path.basename(sourceUri.fsPath)}`,
		{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [extUri, vscode.Uri.file(path.dirname(sourceUri.fsPath))],
		},
	);

	const pdfData = fs.readFileSync(sourceUri.fsPath);
	const dataUrl = `data:application/pdf;base64,${pdfData.toString('base64')}`;

	panel.webview.html = renderHtml(panel.webview, dataUrl, path.basename(sourceUri.fsPath));

	panel.webview.onDidReceiveMessage(async (msg) => {
		if (msg?.type !== 'extract') { return; }
		const pages: number[] = Array.isArray(msg.pages) ? msg.pages : [];
		if (pages.length === 0) {
			vscode.window.showWarningMessage('Dovo: no pages selected.');
			return;
		}
		try {
			const out = await extractPages(sourceUri.fsPath, pages);
			appendToMautCli([out]);
			panel.dispose();
		} catch (err) {
			vscode.window.showErrorMessage(`Dovo PDF extract failed: ${err}`);
		}
	});
}

async function extractPages(src: string, pages: number[]): Promise<string> {
	const { PDFDocument } = await import('pdf-lib');
	const srcBytes = fs.readFileSync(src);
	const srcDoc = await PDFDocument.load(srcBytes, { updateMetadata: false });
	const outDoc = await PDFDocument.create();
	// pdf-lib uses 0-based indices
	const indices = pages.filter(n => n >= 1 && n <= srcDoc.getPageCount()).map(n => n - 1);
	const copied = await outDoc.copyPages(srcDoc, indices);
	for (const p of copied) { outDoc.addPage(p); }
	const bytes = await outDoc.save();
	const suffix = `--pages-${sanitize(pages.join('-'))}`.slice(0, 60);
	const out = buildOutName(src, suffix, 'pdf');
	fs.writeFileSync(out, bytes);
	return out;
}

function renderHtml(webview: vscode.Webview, dataUrl: string, fileName: string): string {
	const csp = `default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline' https: blob:; worker-src blob:; connect-src ${webview.cspSource} data: blob:;`;
	return /* html */ `<!doctype html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
	html, body { height: 100%; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
	body { display: flex; flex-direction: column; }
	header { padding: 10px 14px; display: flex; gap: 10px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); }
	header .title { font-size: 13px; font-weight: 600; }
	header .meta { font-size: 11px; color: var(--vscode-descriptionForeground); }
	header .spacer { flex: 1; }
	header .actions { display: flex; gap: 8px; }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	.grid { flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; padding: 12px; }
	.thumb { background: var(--vscode-input-background); border: 2px solid transparent; border-radius: 6px; padding: 6px; cursor: pointer; user-select: none; display: flex; flex-direction: column; align-items: center; gap: 4px; }
	.thumb.selected { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
	.thumb canvas { max-width: 100%; height: auto; background: white; border-radius: 3px; }
	.thumb .label { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); }
	.thumb.selected .label { color: var(--vscode-list-activeSelectionForeground); font-weight: 600; }
	.loading { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
	<div>
		<div class="title">${fileName}</div>
		<div class="meta" id="meta">loading…</div>
	</div>
	<div class="spacer"></div>
	<div class="actions">
		<input id="range" type="text" placeholder="3-15, 20, 22-25" style="background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; min-width: 180px; outline: none;" />
		<button class="secondary" id="applyRange">Apply</button>
		<button class="secondary" id="all">All</button>
		<button class="secondary" id="none">None</button>
		<button id="extract" disabled>Add 0 pages to Claude</button>
	</div>
</header>
<div class="grid" id="grid"><div class="loading">Rendering pages…</div></div>

<script type="module">
	const vscode = acquireVsCodeApi();
	const grid = document.getElementById('grid');
	const meta = document.getElementById('meta');
	const extractBtn = document.getElementById('extract');
	const allBtn = document.getElementById('all');
	const noneBtn = document.getElementById('none');
	const selected = new Set();

	function updateExtract() {
		extractBtn.disabled = selected.size === 0;
		extractBtn.textContent = 'Add ' + selected.size + ' page' + (selected.size === 1 ? '' : 's') + ' to Claude';
	}

	function toggle(n, node) {
		if (selected.has(n)) { selected.delete(n); node.classList.remove('selected'); }
		else { selected.add(n); node.classList.add('selected'); }
		updateExtract();
	}

	const { getDocument, GlobalWorkerOptions } = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
	GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

	const dataUrl = ${JSON.stringify(dataUrl)};
	const raw = atob(dataUrl.split(',')[1]);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) { bytes[i] = raw.charCodeAt(i); }

	const doc = await getDocument({ data: bytes }).promise;
	meta.textContent = doc.numPages + ' pages';
	grid.innerHTML = '';

	for (let p = 1; p <= doc.numPages; p++) {
		const node = document.createElement('div');
		node.className = 'thumb';
		const cv = document.createElement('canvas');
		const label = document.createElement('div');
		label.className = 'label';
		label.textContent = 'Page ' + p;
		node.appendChild(cv);
		node.appendChild(label);
		node.addEventListener('click', () => toggle(p, node));
		grid.appendChild(node);
		const page = await doc.getPage(p);
		const viewport = page.getViewport({ scale: 0.4 });
		cv.width = viewport.width; cv.height = viewport.height;
		await page.render({ canvasContext: cv.getContext('2d'), viewport }).promise;
	}

	function parseRange(text, max) {
		const out = new Set();
		for (const part of text.split(/[,\s]+/).filter(Boolean)) {
			const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
			if (m) {
				const a = Math.max(1, parseInt(m[1], 10));
				const b = Math.min(max, parseInt(m[2], 10));
				if (a <= b) { for (let i = a; i <= b; i++) { out.add(i); } }
			} else if (/^\d+$/.test(part)) {
				const n = parseInt(part, 10);
				if (n >= 1 && n <= max) { out.add(n); }
			}
		}
		return out;
	}

	function applyRange() {
		const parsed = parseRange(document.getElementById('range').value, doc.numPages);
		selected.clear();
		grid.querySelectorAll('.thumb').forEach((node, idx) => {
			const n = idx + 1;
			if (parsed.has(n)) { selected.add(n); node.classList.add('selected'); }
			else { node.classList.remove('selected'); }
		});
		updateExtract();
	}

	document.getElementById('applyRange').addEventListener('click', applyRange);
	document.getElementById('range').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); applyRange(); }
	});

	allBtn.addEventListener('click', () => {
		selected.clear();
		for (let p = 1; p <= doc.numPages; p++) { selected.add(p); }
		grid.querySelectorAll('.thumb').forEach(n => n.classList.add('selected'));
		updateExtract();
	});
	noneBtn.addEventListener('click', () => {
		selected.clear();
		grid.querySelectorAll('.thumb').forEach(n => n.classList.remove('selected'));
		updateExtract();
	});
	extractBtn.addEventListener('click', () => {
		const pages = [...selected].sort((a,b)=>a-b);
		vscode.postMessage({ type: 'extract', pages });
	});
</script>
</body></html>`;
}
