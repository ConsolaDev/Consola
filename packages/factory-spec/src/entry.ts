import { LineCounter, isMap, isSeq, parseDocument } from 'yaml';
import { formatPath, toIssue, type FactorySpecIssue } from './issues';
import { automationSchema, type Automation } from './schema';

export type AutomationEntryResult =
    | { ok: true; automation: Automation; item: string }
    | { ok: false; issues: FactorySpecIssue[] };

const NOT_ONE_ENTRY = 'Expected exactly one automation, written as a list item.';

/**
 * Validate one automation written on its own — what an agent hands the
 * runner to save — without a surrounding file.
 *
 * It accepts a `- name: …` list item or the bare mapping under it; `item` is
 * always the list-item form (starting `- `, no trailing newline, as dedented
 * as it can be), ready to splice into a file. Anything but exactly one entry
 * is refused with a reason: two items, several `---` documents, a bare
 * scalar, nothing. Never throws.
 *
 * Issue paths are relative to the entry (`mode`, `on.cron`), and `line` is a
 * line of the text as given: a bare mapping becomes an item by prefixing its
 * first line, so no line moves.
 */
export function parseAutomationEntry(yaml: string): AutomationEntryResult {
    const lines = yaml.replace(/\r\n/g, '\n').split('\n');
    const first = lines.findIndex((line) => line.trim() !== '');
    if (first === -1) return refuse(NOT_ONE_ENTRY);

    // Strip the common indent first, so both forms end up at column 0 by one rule.
    const indent = lines[first].length - lines[first].trimStart().length;
    const dedented = lines.map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length)));
    const startsItem = /^(-(\s|$)|---)/.test(dedented[first]);
    const normalized = startsItem
        ? dedented
        : dedented.map((line, index) => (index === first ? `- ${line}` : line === '' ? line : `  ${line}`));
    const source = normalized.join('\n');

    const lineCounter = new LineCounter();
    const doc = parseDocument(source, { lineCounter, prettyErrors: false });
    const lineOf = (offset: number | undefined) =>
        offset === undefined ? undefined : lineCounter.linePos(offset).line;

    if (doc.errors.some((error) => error.code === 'MULTIPLE_DOCS')) return refuse(NOT_ONE_ENTRY);
    if (doc.errors.length > 0) {
        return {
            ok: false,
            issues: doc.errors.map((error) => ({
                message: error.message.split('\n')[0].trim(),
                path: '',
                line: error.linePos?.[0]?.line ?? lineOf(error.pos?.[0]),
            })),
        };
    }
    if (!isSeq(doc.contents) || doc.contents.items.length !== 1 || !isMap(doc.contents.items[0])) {
        return refuse(NOT_ONE_ENTRY);
    }

    const parsed = automationSchema().safeParse(doc.toJS()[0]);
    if (!parsed.success) {
        return {
            ok: false,
            issues: parsed.error.issues.map((issue) => ({
                ...toIssue(issue, [0], doc, lineOf),
                path: formatPath(issue.code === 'unrecognized_keys' && issue.keys.length > 0 ? [...issue.path, issue.keys[0]] : issue.path),
            })),
        };
    }

    const item = normalized.slice(first).join('\n').trimEnd();
    return { ok: true, automation: parsed.data, item };
}

function refuse(message: string): AutomationEntryResult {
    return { ok: false, issues: [{ message, path: '' }] };
}
