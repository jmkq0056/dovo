/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Dovo Markdown Preview: custom renderer.
 *  - markdown-it (with anchor + task-lists) parses on the extension side.
 *  - Webview hosts the rendered HTML with a sticky TOC sidebar and Dovo typography.
 *  - Live re-render on save. Theme-aware (Ember dark / light).
 *  - Cmd+Shift+V or the editor-title button toggles between preview and source.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface Heading {
	level: number;
	text: string;
	slug: string;
}

interface PreviewState {
	panel: vscode.WebviewPanel;
	uri: vscode.Uri;
}

const previews = new Map<string, PreviewState>();

function uriKey(uri: vscode.Uri): string { return uri.toString(); }

async function buildMarkdownIt() {
	const MarkdownIt = (await import('markdown-it')).default;
	const anchor = (await import('markdown-it-anchor')).default;
	// markdown-it-task-lists has no @types; cast at import.
	const taskLists = ((await import('markdown-it-task-lists' as string)) as { default: unknown }).default;
	const md = MarkdownIt({
		html: true,
		linkify: true,
		typographer: true,
		breaks: false,
	});
	md.use(anchor as any, {
		slugify: slugify,
		permalink: (anchor as any).permalink?.linkInsideHeader?.({
			symbol: '#',
			placement: 'before',
			ariaHidden: true,
		}),
	});
	md.use(taskLists as any, { enabled: false, label: true });
	return md;
}

function slugify(s: string): string {
	return s.toLowerCase().trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-');
}

function extractHeadings(text: string): Heading[] {
	const out: Heading[] = [];
	const lines = text.split(/\r?\n/);
	let inFence = false;
	for (const line of lines) {
		if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
		if (inFence) { continue; }
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!m) { continue; }
		const level = m[1].length;
		const content = m[2].replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/[*_`]/g, '').trim();
		out.push({ level, text: content, slug: slugify(content) });
	}
	return out;
}

function renderToc(headings: Heading[]): string {
	if (headings.length === 0) { return '<div class="toc-empty">No headings</div>'; }
	const minLevel = Math.min(...headings.map(h => h.level));
	const items = headings.map(h => {
		const indent = (h.level - minLevel) * 12;
		return `<a href="#${h.slug}" data-slug="${h.slug}" class="toc-link level-${h.level}" style="padding-left:${8 + indent}px">${escapeHtml(h.text)}</a>`;
	}).join('');
	return `<nav class="toc"><div class="toc-title">Contents</div>${items}</nav>`;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function themeKindToClass(): string {
	const kind = vscode.window.activeColorTheme.kind;
	return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'maut-light' : 'maut-dark';
}

async function renderHtml(panel: vscode.WebviewPanel, uri: vscode.Uri): Promise<void> {
	let text: string;
	try { text = fs.readFileSync(uri.fsPath, 'utf8'); }
	catch { text = '*(file not readable)*'; }
	const md = await buildMarkdownIt();
	const body = md.render(text);
	const headings = extractHeadings(text);
	const toc = renderToc(headings);
	const baseDir = path.dirname(uri.fsPath);
	const baseUri = panel.webview.asWebviewUri(vscode.Uri.file(baseDir)).toString() + '/';
	const themeClass = themeKindToClass();
	const fileName = path.basename(uri.fsPath);
	panel.webview.html = wrap(panel.webview, themeClass, fileName, toc, body, baseUri);
}

function wrap(webview: vscode.Webview, themeClass: string, title: string, toc: string, body: string, baseUri: string): string {
	const csp = `default-src 'none'; img-src ${webview.cspSource} https: data: blob: ${baseUri}; style-src ${webview.cspSource} 'unsafe-inline' https:; script-src 'unsafe-inline' https:; font-src https:; connect-src https:;`;
	return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base href="${baseUri}">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/atom-one-dark.min.css" id="hljs-css-dark">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/atom-one-light.min.css" id="hljs-css-light" disabled>
<style>
:root {
	--accent: #f59e0b;
	--accent-hover: #fbbf24;
}
.maut-dark {
	--bg: #1f1a1d;
	--fg: #f3ebe1;
	--muted: #b3a89b;
	--subtle: #7d7268;
	--border: #352d29;
	--code-bg: #181416;
	--toc-bg: #1a1618;
	--toc-hover: #2a2321;
}
.maut-light {
	--accent: #c2410c;
	--accent-hover: #9a3412;
	--bg: #f3eee6;
	--fg: #2b2724;
	--muted: #5f5850;
	--subtle: #8c847a;
	--border: #e0d8cc;
	--code-bg: #ebe4d8;
	--toc-bg: #ede7dd;
	--toc-hover: #e5ddd0;
}
html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--fg); }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', 'SF Pro Text', system-ui, sans-serif; font-size: 15px; line-height: 1.7; }
.layout { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } .toc { display: none; } }
.toc { position: sticky; top: 0; height: 100vh; overflow-y: auto; background: var(--toc-bg); border-right: 1px solid var(--border); padding: 24px 0 24px 16px; }
.toc-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--subtle); margin: 0 0 10px 12px; font-weight: 600; }
.toc-empty { color: var(--subtle); font-size: 13px; padding: 0 16px; }
.toc-link { display: block; padding: 4px 12px 4px 8px; color: var(--muted); text-decoration: none; font-size: 13px; border-left: 2px solid transparent; transition: color .1s, border-color .1s; }
.toc-link:hover { color: var(--accent-hover); }
.toc-link.active { color: var(--accent); border-left-color: var(--accent); background: var(--toc-hover); }
.toc-link.level-1 { font-weight: 600; }
.content-wrap { padding: 56px 8px; overflow-x: hidden; }
.content { max-width: 760px; margin: 0 auto; padding: 0 32px; }
.file-name { font-family: ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--subtle); margin: 0 0 12px 0; }
h1, h2, h3, h4, h5, h6 { font-weight: 700; line-height: 1.25; margin-top: 36px; margin-bottom: 16px; scroll-margin-top: 24px; color: var(--fg); }
h1 { font-size: 2.2em; color: var(--accent); border-bottom: 2px solid var(--border); padding-bottom: 10px; margin-top: 0; }
h2 { font-size: 1.6em; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
h3 { font-size: 1.25em; }
h4 { font-size: 1.05em; color: var(--accent-hover); }
h5, h6 { font-size: 0.95em; color: var(--muted); }
h1 .header-anchor, h2 .header-anchor, h3 .header-anchor, h4 .header-anchor, h5 .header-anchor, h6 .header-anchor { color: var(--subtle); text-decoration: none; opacity: 0; padding-right: 6px; }
h1:hover .header-anchor, h2:hover .header-anchor, h3:hover .header-anchor, h4:hover .header-anchor, h5:hover .header-anchor, h6:hover .header-anchor { opacity: 1; }
p { margin: 0 0 16px 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); text-decoration: underline; }
code { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: var(--code-bg); color: var(--fg); padding: 2px 6px; border-radius: 4px; }
pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; overflow-x: auto; margin: 16px 0; font-size: 13px; line-height: 1.55; }
pre code, pre code.hljs { background: transparent; padding: 0; font-size: 13px; }
blockquote { border-left: 4px solid var(--accent); padding: 0 16px; margin: 16px 0; color: var(--muted); font-style: italic; }
table { border-collapse: collapse; margin: 16px 0; width: 100%; font-size: 14px; }
th, td { border: 1px solid var(--border); padding: 8px 14px; text-align: left; }
th { background: var(--toc-bg); font-weight: 600; }
img { max-width: 100%; height: auto; border-radius: 6px; margin: 16px 0; }
hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
ul, ol { padding-left: 28px; margin: 12px 0; }
li { margin: 6px 0; }
li > p { margin: 4px 0; }
.task-list-item { list-style: none; padding-left: 0; }
.task-list-item input[type=checkbox] { margin: 0 8px 0 -22px; transform: translateY(2px); }
.task-list-item input[type=checkbox]:checked + label { color: var(--muted); text-decoration: line-through; }
kbd { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; background: var(--code-bg); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 1px 6px; }
dl dt { font-weight: 600; margin-top: 12px; }
dl dd { margin-left: 20px; color: var(--muted); }
.callout { padding: 12px 16px; border-radius: 6px; margin: 16px 0; background: var(--code-bg); border-left: 4px solid var(--accent); }
</style>
</head>
<body class="${themeClass}">
<div class="layout">
${toc}
<div class="content-wrap">
<article class="content">
<div class="file-name">${escapeHtml(title)}</div>
${body}
</article>
</div>
</div>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/highlight.min.js"></script>
<script>
(function () {
	const isLight = document.body.classList.contains('maut-light');
	document.getElementById('hljs-css-dark').disabled = isLight;
	document.getElementById('hljs-css-light').disabled = !isLight;
	document.querySelectorAll('pre code').forEach(b => { try { hljs.highlightElement(b); } catch (e) {} });

	const tocLinks = Array.from(document.querySelectorAll('.toc-link'));
	const headings = tocLinks.map(a => document.getElementById(a.dataset.slug)).filter(Boolean);
	const map = new Map(tocLinks.map(a => [a.dataset.slug, a]));

	const obs = new IntersectionObserver(entries => {
		entries.forEach(e => {
			if (e.isIntersecting) {
				tocLinks.forEach(a => a.classList.remove('active'));
				const link = map.get(e.target.id);
				if (link) { link.classList.add('active'); link.scrollIntoView({ block: 'nearest' }); }
			}
		});
	}, { rootMargin: '-10% 0px -80% 0px', threshold: 0 });
	headings.forEach(h => obs.observe(h));

	tocLinks.forEach(a => a.addEventListener('click', (ev) => {
		ev.preventDefault();
		const target = document.getElementById(a.dataset.slug);
		if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', '#' + a.dataset.slug); }
	}));

	// Persist + restore scroll position across re-renders.
	const vscode = acquireVsCodeApi();
	const state = vscode.getState() || {};
	if (typeof state.scrollY === 'number') { setTimeout(() => window.scrollTo(0, state.scrollY), 0); }
	window.addEventListener('scroll', () => { vscode.setState({ scrollY: window.scrollY }); }, { passive: true });
}());
</script>
</body>
</html>`;
}

async function openPreview(uri: vscode.Uri): Promise<void> {
	const key = uriKey(uri);
	const existing = previews.get(key);
	if (existing) {
		existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Active, false);
		await renderHtml(existing.panel, uri);
		return;
	}
	const panel = vscode.window.createWebviewPanel(
		'maut.markdownPreview',
		path.basename(uri.fsPath),
		{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.file(path.dirname(uri.fsPath))],
		},
	);
	panel.iconPath = new vscode.ThemeIcon('preview') as unknown as vscode.Uri;
	previews.set(key, { panel, uri });
	panel.onDidDispose(() => { previews.delete(key); });
	await renderHtml(panel, uri);

	// Close the original source tab if open in the same group.
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input as { uri?: vscode.Uri } | undefined;
			if (input?.uri?.toString() === uri.toString() && !(tab.input as any)?.viewType?.includes?.('webview')) {
				try { await vscode.window.tabGroups.close(tab); } catch { /* noop */ }
			}
		}
	}
}

async function toggleSourcePreview(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (editor && editor.document.languageId === 'markdown') {
		await openPreview(editor.document.uri);
		return;
	}
	const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
	const input = activeTab?.input as { viewType?: string } | undefined;
	if (input?.viewType === 'mainThreadWebview-maut.markdownPreview') {
		// find the URI from previews map
		const entry = Array.from(previews.entries()).find(([, st]) => st.panel === (activeTab as any)._input);
		if (entry) {
			const [, st] = entry;
			st.panel.dispose();
			await vscode.window.showTextDocument(st.uri, { preview: false });
		}
	}
}

const recentlyOpened = new Set<string>();

function isMarkdownDoc(doc?: vscode.TextDocument): boolean {
	return !!doc && doc.languageId === 'markdown' && (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled');
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('maut.markdown.toggle', toggleSourcePreview),
		vscode.workspace.onDidOpenTextDocument(async (doc) => {
			const cfg = vscode.workspace.getConfiguration('maut.markdown');
			if (!cfg.get<boolean>('previewByDefault', true)) { return; }
			if (!isMarkdownDoc(doc)) { return; }
			const key = doc.uri.toString();
			if (recentlyOpened.has(key)) { return; }
			recentlyOpened.add(key);
			setTimeout(() => recentlyOpened.delete(key), 1500);
			setTimeout(() => { void openPreview(doc.uri); }, 50);
		}),
		vscode.workspace.onDidSaveTextDocument(async (doc) => {
			if (!isMarkdownDoc(doc)) { return; }
			const state = previews.get(uriKey(doc.uri));
			if (state) { await renderHtml(state.panel, doc.uri); }
		}),
		vscode.window.onDidChangeActiveColorTheme(async () => {
			// Re-render all open previews so they pick up the new theme.
			for (const st of previews.values()) {
				try { await renderHtml(st.panel, st.uri); } catch { /* noop */ }
			}
		}),
	);
}

export function deactivate(): void { /* noop */ }
