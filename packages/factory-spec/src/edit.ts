import { isMap, isPair, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import { parseAutomationEntry } from './entry';

/**
 * `text` with one more automation at the end of its `automations` list, and
 * every other byte as the person wrote it.
 *
 * The entry is spliced in as text, never re-serialised with the document:
 * re-printing would re-indent the file, re-wrap its long lines, re-space its
 * flow maps and move the line numbers the panel shows problems at. It goes
 * after the list's last item (before any commented-out examples that follow
 * it), at the column the list's items start at. An empty list — absent,
 * `automations:` with nothing under it, or `[]` — gets the entry as its only
 * item. The result is parsed again, and refused unless it loads with the
 * entry last; a file that does not parse to begin with is refused too.
 */
export function appendAutomationEntry(text: string, entryYaml: string): string {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw new Error(`factory.yml does not parse, so nothing was added: ${doc.errors[0].message}`);
    const entry = parseDocument(entryYaml);
    if (entry.errors.length > 0 || !isSeq(entry.contents) || entry.contents.items.length !== 1) {
        throw new Error('Expected exactly one automation, written as a list item.');
    }
    const lines = entryYaml.replace(/\n+$/, '').split('\n');
    const before = automationsCount(doc);
    const result = splice(text, doc, lines);
    const after = parseDocument(result);
    if (after.errors.length > 0 || automationsCount(after) !== before + 1) {
        throw new Error('Could not add the automation to factory.yml without changing the rest of it; add it by hand.');
    }
    return result;
}

function splice(text: string, doc: Document, lines: string[]): string {
    const block = (column: number) => lines.map((line) => `${' '.repeat(column)}${line}`).join('\n') + '\n';
    const list = doc.get('automations', true);

    if (isSeq(list) && !list.flow && list.items.length > 0) {
        const first = list.range?.[0] ?? 0;
        const column = first - (text.lastIndexOf('\n', first - 1) + 1);
        const last = list.items[list.items.length - 1] as { range?: [number, number, number] };
        return insertAfterLineOf(text, last.range?.[1] ?? list.range![1], block(column));
    }

    const pair = isMap(doc.contents) ? doc.contents.items.find((item) => isPair(item) && isScalar(item.key) && item.key.value === 'automations') : undefined;
    const key = pair && isPair(pair) && isScalar(pair.key) ? pair.key : undefined;
    if (!key?.range) {
        // No list at all: a new one at the end of the file. A file with
        // nothing in it yet (empty, or only comments) needs its version too.
        const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n';
        const version = doc.contents === null ? 'version: 1\n' : '';
        return `${text}${separator}${version}automations:\n${block(2)}`;
    }
    if (list === null || list === undefined || (isScalar(list) && list.value === null)) {
        // `automations:` and nothing under it: the entry goes right below the key.
        return insertAfterLineOf(text, key.range[1], block(2));
    }
    if (isSeq(list) && list.flow && list.items.length === 0 && list.range) {
        // `automations: []`: the brackets become a block list holding the entry.
        const end = text.indexOf('\n', list.range[1]);
        const rest = end === -1 ? '' : text.slice(end + 1);
        return `${text.slice(0, list.range[0]).replace(/[ \t]+$/, '')}\n${block(2)}${rest}`;
    }
    throw new Error('`automations` in factory.yml is not a list Consola can add to; add the entry by hand.');
}

/** `text` with `block` inserted at the start of the line after the one holding `offset`. */
function insertAfterLineOf(text: string, offset: number, block: string): string {
    const newline = text.indexOf('\n', Math.max(0, offset - 1));
    if (newline === -1) return `${text}\n${block}`;
    return text.slice(0, newline + 1) + block + text.slice(newline + 1);
}

function automationsCount(doc: Document): number {
    const list = doc.get('automations', true);
    return isSeq(list) ? list.items.length : 0;
}

/**
 * `text` with the automation called `name` swapped for `entryYaml`, and every
 * byte outside that entry as the person wrote it: the comments around it, its
 * neighbours, the commented-out examples after the list.
 *
 * The entry's lines are replaced as text, from the start of its dash line to
 * the end of the line its last value ends on, and re-indented to the column
 * the item's dash was at. A flow-style item (`- { name: … }`) is replaced the
 * same way and comes out as a block. `entryYaml` is anything
 * `parseAutomationEntry` accepts, and must keep the name. The result is parsed
 * again, and refused unless it loads with the same number of automations and
 * the new entry where the old one was.
 */
export function replaceAutomationEntry(text: string, name: string, entryYaml: string): string {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw new Error(`factory.yml does not parse, so nothing was changed: ${doc.errors[0].message}`);
    const found = findEntry(text, doc, name);
    if (!found) throw new Error(`There is no automation named "${name}" in factory.yml.`);
    const entry = parseAutomationEntry(entryYaml);
    if (!entry.ok) throw new Error(entry.issues[0].message);
    if (entry.automation.name !== name) {
        throw new Error(`The new entry is named "${entry.automation.name}"; replacing "${name}" must keep its name.`);
    }

    const indent = ' '.repeat(found.column);
    const block = entry.item
        .split('\n')
        .map((line) => (line === '' ? line : `${indent}${line}`))
        .join('\n');
    const result = text.slice(0, found.start) + block + text.slice(lineEnd(text, found.end));

    const after = parseDocument(result);
    const list = after.get('automations', true);
    const replaced = isSeq(list) ? list.items[found.index] : undefined;
    if (
        after.errors.length > 0 ||
        automationsCount(after) !== automationsCount(doc) ||
        !isMap(replaced) ||
        replaced.get('name') !== name
    ) {
        throw new Error('Could not replace the automation in factory.yml without changing the rest of it; edit it by hand.');
    }
    return result;
}

/**
 * The automation called `name` exactly as written in `text`, dedented to a
 * column-0 list item (`- name: …`), or `null` when there is no such entry.
 */
export function automationEntryText(text: string, name: string): string | null {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) return null;
    const found = findEntry(text, doc, name);
    if (!found) return null;
    return text
        .slice(found.start, lineEnd(text, found.end))
        .split('\n')
        .map((line) => line.slice(Math.min(found.column, line.length - line.trimStart().length)))
        .join('\n');
}

interface FoundEntry {
    index: number;
    /** Offset of the start of the item's dash line. */
    start: number;
    /** An offset inside the item's last line. */
    end: number;
    /** Column of the item's dash. */
    column: number;
}

function findEntry(text: string, doc: Document, name: string): FoundEntry | null {
    const list = doc.get('automations', true);
    if (!isSeq(list)) return null;
    const index = list.items.findIndex((item) => isMap(item) && item.get('name') === name);
    const item = list.items[index] as { range?: [number, number, number] } | undefined;
    if (!item?.range) return null;
    const start = text.lastIndexOf('\n', item.range[0] - 1) + 1;
    return { index, start, end: Math.max(start, item.range[1] - 1), column: /^ */.exec(text.slice(start))![0].length };
}

/** Offset of the newline ending the line that holds `offset` (the text's length on the last line). */
function lineEnd(text: string, offset: number): number {
    const newline = text.indexOf('\n', offset);
    return newline === -1 ? text.length : newline;
}
