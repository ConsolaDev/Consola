import { LineCounter, parseDocument, type Document } from 'yaml';
import type { ZodIssue } from 'zod';
import { automationSchema, fileSchema, type Automation } from './schema';

export interface FactorySpecIssue {
    message: string;
    /** Dotted path into the document, e.g. `automations[0].mode`. Empty for whole-file problems. */
    path: string;
    /** 1-based line, when the problem can be pinned to one. */
    line?: number;
    /** Name of the automation the problem belongs to, when it has a readable one. */
    automation?: string;
}

export interface FactorySpecParseResult {
    automations: Automation[];
    issues: FactorySpecIssue[];
}

/**
 * Parse and validate one factory.yml.
 *
 * Never throws. Each automation is validated on its own, so one bad entry
 * reports an issue while its siblings still load. A problem with the file as
 * a whole — YAML syntax, a missing `version` — loads nothing: half-reading a
 * file whose shape is unknown could run something the person did not write.
 */
export function parseFactorySpec(text: string): FactorySpecParseResult {
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter, prettyErrors: false });
    const lineOf = (offset: number | undefined) =>
        offset === undefined ? undefined : lineCounter.linePos(offset).line;

    if (doc.errors.length > 0) {
        return {
            automations: [],
            issues: doc.errors.map((error) => ({
                message: firstLine(error.message),
                path: '',
                line: error.linePos?.[0]?.line ?? lineOf(error.pos?.[0]),
            })),
        };
    }

    const root: unknown = doc.toJS();
    // An empty (or comments-only) file is a valid "no automations yet".
    if (root === null || root === undefined) return { automations: [], issues: [] };

    const envelope = fileSchema.safeParse(root);
    if (!envelope.success) {
        return {
            automations: [],
            issues: envelope.error.issues.map((issue) => toIssue(issue, [], doc, lineOf)),
        };
    }

    const schema = automationSchema();
    const automations: Automation[] = [];
    const issues: FactorySpecIssue[] = [];
    const seen = new Set<string>();

    envelope.data.automations.forEach((raw, index) => {
        const base: Array<string | number> = ['automations', index];
        const name = readableName(raw);
        const line = lineOf(nodeAt(doc, base)?.range?.[0]);
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
            for (const issue of parsed.error.issues) {
                issues.push({ ...toIssue(issue, base, doc, lineOf), ...(name ? { automation: name } : {}) });
            }
            return;
        }
        if (seen.has(parsed.data.name)) {
            issues.push({
                message: `Duplicate automation name "${parsed.data.name}"; names must be unique.`,
                path: formatPath([...base, 'name']),
                line: lineOf(nodeAt(doc, [...base, 'name'])?.range?.[0]) ?? line,
                automation: parsed.data.name,
            });
            return;
        }
        seen.add(parsed.data.name);
        automations.push({ ...parsed.data, ...(line ? { line } : {}) });
    });

    return { automations, issues };
}

function toIssue(
    issue: ZodIssue,
    base: Array<string | number>,
    doc: Document,
    lineOf: (offset: number | undefined) => number | undefined
): FactorySpecIssue {
    const fullPath = [...base, ...issue.path];
    // A strict object reports unknown keys at the object itself; pointing at
    // the offending key is far more useful.
    const keyPath =
        issue.code === 'unrecognized_keys' && issue.keys.length > 0
            ? [...fullPath, issue.keys[0]]
            : fullPath;
    return {
        message: issue.message,
        path: formatPath(fullPath),
        line: lineOf(closestNode(doc, keyPath)?.range?.[0]),
    };
}

interface RangedNode {
    range?: [number, number, number];
}

function nodeAt(doc: Document, path: Array<string | number>): RangedNode | undefined {
    if (path.length === 0) return doc.contents as RangedNode | undefined;
    const node = doc.getIn(path, true) as RangedNode | undefined;
    return node && typeof node === 'object' ? node : undefined;
}

/** The node at `path`, or its nearest existing ancestor — a missing key has no node of its own. */
function closestNode(doc: Document, path: Array<string | number>): RangedNode | undefined {
    for (let length = path.length; length >= 0; length--) {
        const node = nodeAt(doc, path.slice(0, length));
        if (node?.range) return node;
    }
    return undefined;
}

function formatPath(path: Array<string | number>): string {
    return path
        .map((part, index) => (typeof part === 'number' ? `[${part}]` : index === 0 ? part : `.${part}`))
        .join('');
}

function readableName(raw: unknown): string | undefined {
    if (raw && typeof raw === 'object' && 'name' in raw) {
        const name = (raw as { name: unknown }).name;
        if (typeof name === 'string' && name.trim()) return name.trim();
    }
    return undefined;
}

function firstLine(message: string): string {
    return message.split('\n')[0].trim();
}
