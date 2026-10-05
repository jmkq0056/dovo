/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The part of an xterm terminal the screen reader needs: its size and its visible lines. */
export interface IScreen {
	readonly rows: number;
	readonly cols: number;
	readonly buffer: {
		readonly active: {
			readonly viewportY: number;
			getLine(y: number): {
				translateToString(trimRight?: boolean): string;
				getCell(x: number): { isInverse(): number; isBold(): number; getFgColor(): number; getFgColorMode(): number } | undefined;
			} | undefined;
		};
	};
}

export interface IScreenMenu {
	readonly kind: 'command' | 'file';
	readonly items: { readonly name: string; readonly detail: string; readonly selected: boolean }[];
}

export interface IScreenDialog {
	readonly question: string;
	readonly details: string[];
	readonly options: { readonly key: string; readonly text: string; readonly selected: boolean }[];
	readonly hint: string;
}

export interface IScreenState {
	/** The rows of Claude's screen the input frame shows. */
	readonly frame: { readonly from: number; readonly to: number };
	/** Where Claude's live area (spinner, queued messages) ends, above the prompt and its menu. */
	readonly liveTop: number;
	readonly menu?: IScreenMenu;
	readonly dialog?: IScreenDialog;
	readonly notice?: string;
	/** Claude's footer under the prompt box ("bypass permissions on (shift+tab to cycle)"). */
	readonly footer?: string;
}

const ruleRegex = /^\s*[\u2500\u2501]{8,}\s*$/;
// A command (with an optional "(alias)") or a file (+ path), then its description however it's
// spaced: in a narrow terminal a long command runs right into its description.
const menuItemRegex = /^\s{1,4}(?:\u276f\s*)?(?<name>\/[\w:.-]+(?:\s\([^)]*\))?|\+\s\S+)(?:\s*(?<detail>\S.*))?$/;
const optionRegex = /^\s*(?<mark>\u276f)?\s*(?<key>\d)\.\s+(?<text>\S.*)$/;

/**
 * What's at the bottom of Claude's screen, so the Reader can show it properly: the prompt box
 * (the input frame shows just that), Claude's / and @ menu above it and its notices (drawn as
 * HTML), or a question with numbered options in place of the prompt box (a card with buttons).
 */
export function readScreen(raw: IScreen): IScreenState {
	const buffer = raw.buffer.active;
	const lineAt = (row: number) => buffer.getLine(buffer.viewportY + row);
	const text = (row: number) => lineAt(row)?.translateToString(true) ?? '';
	let last = raw.rows - 1;
	while (last > 0 && !text(last).trim()) {
		last--;
	}
	const rules: number[] = [];
	for (let row = last; row >= 0 && rules.length < 2; row--) {
		if (ruleRegex.test(text(row))) {
			rules.push(row);
		}
	}

	// A question: numbered options, with "Esc to cancel" under them. In a short terminal that hint
	// can fall off the screen; then the options themselves (one marked with the chevron) tell.
	const hintRow = (() => {
		for (let row = last; row >= Math.max(0, last - 6); row--) {
			if (/Esc to cancel/i.test(text(row))) {
				return row;
			}
		}
		if (!rules.length || !ruleRegex.test(text(Math.max(0, last - 1)))) {
			for (let row = last; row >= Math.max(0, last - 4); row--) {
				const match = optionRegex.exec(text(row));
				if (match?.groups && rules.length < 2) {
					return last + 1;
				}
			}
		}
		return -1;
	})();
	if (hintRow >= 0) {
		const options: { key: string; text: string; selected: boolean }[] = [];
		let first = -1;
		// Walking up: an option's wrapped lines come before (below) the option itself.
		let wrapped: string[] = [];
		for (let row = hintRow - 1; row >= 0 && row >= hintRow - 30; row--) {
			const line = text(row);
			const match = optionRegex.exec(line);
			if (match?.groups) {
				options.unshift({ key: match.groups.key, text: [match.groups.text.trim(), ...wrapped].join(' '), selected: !!match.groups.mark });
				wrapped = [];
				first = row;
			} else if (/^\s{4,}\S/.test(line)) {
				wrapped.unshift(line.trim());
			} else if (line.trim() && options.length) {
				break;
			} else if (!line.trim()) {
				wrapped = [];
			}
		}
		if (options.length && first > 0) {
			// The question is the line right above the options; what's above it, up to the rule, is detail.
			let questionRow = first - 1;
			while (questionRow > 0 && !text(questionRow).trim()) {
				questionRow--;
			}
			let top = questionRow;
			while (top > 0 && !ruleRegex.test(text(top - 1)) && questionRow - top < 24) {
				top--;
			}
			const details: string[] = [];
			for (let row = top; row < questionRow; row++) {
				const line = text(row).replace(/\s+$/, '');
				if (line.trim() && !/^\s*[\u254c\u2504\u2508-]{8,}\s*$/.test(line)) {
					details.push(line.replace(/^\s/, ''));
				}
			}
			const frameRow = Math.min(hintRow, last);
			return {
				frame: { from: frameRow, to: frameRow },
				liveTop: Math.max(0, top - 1),
				dialog: { question: text(questionRow).trim(), details: details.slice(0, 16), options, hint: hintRow <= last ? text(hintRow).trim() : '' },
			};
		}
	}

	if (rules.length === 2) {
		const promptTop = rules[1];
		// Claude's menu: item rows (and their wrapped descriptions) right above the prompt box.
		const items: { name: string; detail: string; row: number; file?: boolean }[] = [];
		let menuTop = promptTop;
		for (let row = promptTop - 1; row >= 0; row--) {
			const line = text(row);
			const match = menuItemRegex.exec(line);
			if (match?.groups) {
				items.unshift({ name: match.groups.name.replace(/^\+\s/, ''), detail: (match.groups.detail ?? '').trim(), row, file: match.groups.name.startsWith('+') });
				menuTop = row;
			} else if (/^\s{8,}\S/.test(line) && row < promptTop) {
				menuTop = row;
				items.unshift({ name: '', detail: line.trim(), row });
			} else {
				break;
			}
		}
		// Wrapped description lines belong to the item above them.
		const merged: { name: string; detail: string; row: number; file?: boolean }[] = [];
		for (const item of items) {
			if (!item.name && merged.length) {
				merged[merged.length - 1].detail += ` ${item.detail}`;
			} else if (item.name) {
				merged.push({ ...item });
			}
		}
		// Wrapped lines above the first item belong to nothing (a notice, say): the menu starts at its first item.
		menuTop = merged.length ? merged[0].row : promptTop;
		let menu: IScreenMenu | undefined;
		if (merged.length) {
			// The highlighted row is the one drawn differently from the rest.
			// Sampled on the first character and on the name itself (file rows mark the name, not the +).
			const style = (row: number, name: string) => {
				const line = lineAt(row);
				const content = text(row);
				const at = (x: number) => {
					const cell = x >= 0 ? line?.getCell(x) : undefined;
					return cell ? `${cell.isInverse()}:${cell.isBold()}:${cell.getFgColorMode()}:${cell.getFgColor()}` : '';
				};
				return `${at(content.length - content.trimStart().length)}|${at(content.indexOf(name))}`;
			};
			const styles = merged.map(item => style(item.row, item.name));
			const counts = new Map<string, number>();
			styles.forEach(value => counts.set(value, (counts.get(value) ?? 0) + 1));
			const odd = merged.length > 1 ? styles.findIndex(value => counts.get(value) === 1) : 0;
			menu = {
				kind: merged.some(item => item.file) ? 'file' : 'command',
				items: merged.map((item, index) => ({ name: item.name, detail: item.detail, selected: index === odd })),
			};
		} else {
			menuTop = promptTop;
		}
		// A notice: right-aligned on the row above the prompt box (and its menu).
		let notice: string | undefined;
		const above = menuTop > 0 ? text(menuTop - 1) : '';
		const indent = above.length - above.trimStart().length;
		let liveTop = menuTop;
		if (above.trim() && indent > raw.cols * 0.3) {
			notice = above.trim();
			liveTop--;
		}
		// The frame shows only the lines you type into, between the box's two rules; the rules and
		// the footer under them stay out (the footer is repeated as text under the input).
		const footer = [];
		for (let row = rules[0] + 1; row <= last; row++) {
			const line = text(row).trim();
			if (line) {
				footer.push(line);
			}
		}
		const from = Math.min(promptTop + 1, rules[0] - 1);
		return { frame: { from, to: Math.max(from, rules[0] - 1) }, liveTop, menu, notice, footer: footer.join(' \u00b7 ') };
	}

	// Anything else Claude shows (a picker, a full-screen dialog): from its rule down, as it is.
	const top = rules.length ? rules[0] : Math.max(0, last - 11);
	return { frame: { from: top, to: last }, liveTop: top };
}
