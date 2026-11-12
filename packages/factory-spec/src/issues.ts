import type { Document } from 'yaml';
import type { ZodIssue } from 'zod';

/**
 * Shared by the whole-file parser and the single-entry parser: turning a zod
 * issue into a problem pinned to a line. Internal; not part of the package's
 * public surface.
 */
export interface FactorySpecIssue {
    message: string;
    /** Dotted path into the document, e.g. `automations[0].mode`. Empty for whole-file problems. */
    path: string;
    /** 1-based line, when the problem can be pinned to one. */
    line?: number;
    /** Name of the automation the problem belongs to, when it has a readable one. */
    automation?: string;
}

export function toIssue(
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

export function nodeAt(doc: Document, path: Array<string | number>): RangedNode | undefined {
    if (path.length === 0) return doc.contents as RangedNode | undefined;
    const node = doc.getIn(path, true) as RangedNode | undefined;
    return node && typeof node === 'object' ? node : undefined;
}

/** The node at `path`, or its nearest existing ancestor — a missing key has no node of its own. */
export function closestNode(doc: Document, path: Array<string | number>): RangedNode | undefined {
    for (let length = path.length; length >= 0; length--) {
        const node = nodeAt(doc, path.slice(0, length));
        if (node?.range) return node;
    }
    return undefined;
}

export function formatPath(path: Array<string | number>): string {
    return path
        .map((part, index) => (typeof part === 'number' ? `[${part}]` : index === 0 ? part : `.${part}`))
        .join('');
}
