import { describe, expect, it } from 'vitest';
import { parseFieldPath, readFieldPath } from './fieldPath';

const PROBLEM =
    'Write a field path as `.name` or `.name.name`, e.g. `.head`: names are letters, digits and _, and a path walks objects only.';

describe('parseFieldPath', () => {
    it.each([
        ['.url', ['url'], '.url'],
        ['.head.oid', ['head', 'oid'], '.head.oid'],
        ['._x1', ['_x1'], '._x1'],
        ['  .url  ', ['url'], '.url'],
    ])('parses %j', (text, names, normalised) => {
        expect(parseFieldPath(text)).toEqual({ ok: true, path: { names, text: normalised } });
    });

    it.each(['url', '.', '..a', '.a.', '.1a', '.a[0]', '.a | b', '.a-b', '', 3, null])('refuses %j', (text) => {
        expect(parseFieldPath(text)).toEqual({ ok: false, problem: PROBLEM });
    });
});

describe('readFieldPath', () => {
    const path = (text: string) => {
        const parsed = parseFieldPath(text);
        if (!parsed.ok) throw new Error(parsed.problem);
        return parsed.path;
    };

    it.each([
        ['.a.b', { a: { b: 2 } }, { found: true, value: 2 }],
        ['.a.b', { a: { b: null } }, { found: true, value: null }],
        ['.a.b', { a: [{ b: 1 }] }, { found: false, at: '.a' }],
        ['.a.b', {}, { found: false, at: '.a' }],
        ['.a.b', { a: 'x' }, { found: false, at: '.a' }],
        ['.a.b', { a: {} }, { found: false, at: '.a.b' }],
    ])('reads %s of %j', (text, value, expected) => {
        expect(readFieldPath(value, path(text))).toEqual(expected);
    });
});
