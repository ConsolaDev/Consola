/**
 * Field paths: `.name` or `.name.name`, how a poll trigger names the fields of
 * what its check command returns. A path walks objects only: no indexes, no
 * filters, no pipes. Filtering belongs in the command.
 */

export const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface FieldPath {
    names: string[];
    /** The path as written, trimmed. */
    text: string;
}

const PROBLEM =
    'Write a field path as `.name` or `.name.name`, e.g. `.head`: names are letters, digits and _, and a path walks objects only.';

export function parseFieldPath(text: unknown): { ok: true; path: FieldPath } | { ok: false; problem: string } {
    if (typeof text !== 'string') return { ok: false, problem: PROBLEM };
    const trimmed = text.trim();
    if (!trimmed.startsWith('.')) return { ok: false, problem: PROBLEM };
    const names = trimmed.slice(1).split('.');
    if (!names.every((name) => FIELD_NAME_PATTERN.test(name))) return { ok: false, problem: PROBLEM };
    return { ok: true, path: { names, text: trimmed } };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Walks objects only. `at` is the prefix that was absent or not an object. */
export function readFieldPath(value: unknown, path: FieldPath): { found: true; value: unknown } | { found: false; at: string } {
    let current = value;
    let walked = '';
    for (const name of path.names) {
        if (!isObject(current)) return { found: false, at: walked };
        walked += `.${name}`;
        if (!Object.prototype.hasOwnProperty.call(current, name)) return { found: false, at: walked };
        current = current[name];
    }
    return { found: true, value: current };
}
