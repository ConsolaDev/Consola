import { describe, expect, it } from 'vitest';
import type { PollTrigger } from '@consola/factory-spec';
import { readCheckResult } from './checkResult';
import type { PolledItem } from './checkResult';
import type { ItemRef } from '../views';

const PR_URL = /^https:\/\/github\.com\/sprocket\/catalog-portal\/(pull|issues)\/(\d+)$/;
const workItems = {
  parseUrl(connection: string, url: string): ItemRef | null {
    const match = connection === 'github' ? PR_URL.exec(url) : null;
    if (!match) return null;
    return {
      repo: 'sprocket/catalog-portal',
      number: Number(match[2]),
      type: match[1] === 'pull' ? 'pr' : 'issue',
    } as unknown as ItemRef;
  },
  keyOf: (ref: ItemRef) =>
    `github:${(ref as any).repo}:${(ref as any).type}:${(ref as any).number}`,
  urlOf: (ref: ItemRef) => `https://github.com/${(ref as any).repo}/pull/${(ref as any).number}`,
};

const pollTrigger = (extra: Partial<PollTrigger>): PollTrigger => ({
  kind: 'poll',
  run: 'x',
  everyMs: 60000,
  timeoutMs: 60000,
  ...extra,
});
const withItem = pollTrigger({ item: { connection: 'github', path: '.url' } });
const read = (stdout: unknown, trigger: PollTrigger, truncated = false) =>
  readCheckResult({
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    truncated,
    trigger,
    workItems,
  });
const pr = (n: number, extra: Record<string, unknown> = {}) => ({
  url: `https://github.com/sprocket/catalog-portal/pull/${n}`,
  ...extra,
});

describe('readCheckResult accepts', () => {
  it('an empty array', () => {
    expect(read('[]', withItem)).toEqual({ ok: true, items: [] });
  });

  it("the spec's template output", () => {
    const rows = [51, 52, 53].map((n) => pr(n, { title: `T${n}`, head: `h${n}` }));
    const result = read(rows, pollTrigger({ item: withItem.item, changed: '.head' }));
    expect(result.ok && result.items.map((i) => [i.key, i.rev, i.title, i.url])).toEqual([
      [
        'github:sprocket/catalog-portal:pr:51',
        'h51',
        'T51',
        'https://github.com/sprocket/catalog-portal/pull/51',
      ],
      [
        'github:sprocket/catalog-portal:pr:52',
        'h52',
        'T52',
        'https://github.com/sprocket/catalog-portal/pull/52',
      ],
      [
        'github:sprocket/catalog-portal:pr:53',
        'h53',
        'T53',
        'https://github.com/sprocket/catalog-portal/pull/53',
      ],
    ]);
    expect(result.ok && result.items[0].workItem).toMatchObject({ number: 51 });
  });

  it.each([
    [
      [{ id: 7 }, { id: 'a' }],
      ['7', 'a'],
    ],
    [
      [{ id: '1' }, { id: 2 }],
      ['1', '2'],
    ],
  ])('keys from .id: %j', (rows, keys) => {
    const result = read(rows, pollTrigger({ key: '.id' }));
    expect(result.ok && result.items.map((i) => [i.key, i.url])).toEqual(keys.map((k) => [k, '']));
  });

  it.each([
    [{ head: 'abc' }, 'abc'],
    [{ head: 4 }, '4'],
    [{ head: true }, 'true'],
    [{ head: false }, 'false'],
    [{ head: null }, ''],
    [{}, ''],
  ])('a revision from %j is %j', (extra, rev) => {
    const result = read([pr(1, extra)], pollTrigger({ item: withItem.item, changed: '.head' }));
    expect(result.ok && result.items[0].rev).toBe(rev);
  });

  it('sets no rev without changed:', () => {
    const result = read([pr(1, { head: 'x' })], withItem);
    expect(result.ok && 'rev' in result.items[0]).toBe(false);
  });

  it('cuts a 100-character title to 80 ending in an ellipsis', () => {
    const result = read([{ id: 1, title: 'a'.repeat(100) }], pollTrigger({ key: '.id' }));
    const title = result.ok ? result.items[0].title : '';
    expect(Array.from(title)).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps an 80-character title whole', () => {
    const result = read([{ id: 1, title: 'a'.repeat(80) }], pollTrigger({ key: '.id' }));
    expect(result.ok && result.items[0].title).toBe('a'.repeat(80));
  });

  it('titles an untitled item by its fallback, or by its key', () => {
    const byItem = read([pr(51)], withItem);
    expect(byItem.ok && byItem.items[0].title).toBe('PR #51');
    const byKey = read([{ id: 'abc' }], pollTrigger({ key: '.id' }));
    expect(byKey.ok && byKey.items[0].title).toBe('abc');
  });

  it('hands back the object exactly as printed, its url included', () => {
    const row = pr(51, { title: 'T', nested: { a: [1] } });
    const result = read([row], withItem);
    const item: PolledItem | undefined = result.ok ? result.items[0] : undefined;
    expect(item?.object).toEqual(row);
  });
});

describe('readCheckResult refuses', () => {
  const big = { pad: 'x'.repeat(70 * 1024) };
  const manyItems = Array.from({ length: 501 }, (_, i) => ({ id: i }));
  const keyed = pollTrigger({ key: '.id' });
  const changed = pollTrigger({ item: withItem.item, changed: '.head' });
  it.each<[string, () => ReturnType<typeof read>, string | RegExp]>([
    ['truncated', () => read('[]', keyed, true), 'Its stdout is over 1 MB.'],
    ['not json', () => read('not json', keyed), /^Its stdout is not JSON \(/],
    [
      'an object',
      () => read('{"a":1}', keyed),
      'Its stdout is a JSON object, not an array of objects.',
    ],
    ['a number', () => read('42', keyed), 'Its stdout is a JSON number, not an array of objects.'],
    ['null', () => read('null', keyed), 'Its stdout is JSON null, not an array of objects.'],
    ['a string', () => read('"x"', keyed), 'Its stdout is a JSON string, not an array of objects.'],
    ['a number item', () => read('[1]', keyed), 'Item 0 is a number, not an object.'],
    [
      'too many items',
      () => read(manyItems, keyed),
      'It returned 501 items; a check returns at most 500.',
    ],
    [
      'a big item',
      () => read([{ id: 0 }, { id: 1 }, { id: 2, ...big }], keyed),
      'Item 2 is over 64 KB.',
    ],
    ['a missing key', () => read([{ id: 0 }, {}], keyed), 'Item 1 has no key at `.id`.'],
    [
      'an object key',
      () => read([{ id: {} }], keyed),
      "Item 0's key at `.id` is not text or a number.",
    ],
    [
      'an empty key',
      () => read([{ id: '' }], keyed),
      "Item 0's key at `.id` is not text or a number.",
    ],
    [
      'a boolean key',
      () => read([{ id: true }], keyed),
      "Item 0's key at `.id` is not text or a number.",
    ],
    [
      'duplicate keys',
      () => read([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'a' }], keyed),
      'Items 0 and 3 have the same key "a".',
    ],
    [
      '1 and "1"',
      () => read([{ id: '1' }, { id: 1 }], keyed),
      'Items 0 and 1 have the same key "1".',
    ],
    [
      'a foreign url',
      () => read([pr(1), pr(2), { url: 'https://example.com/x' }], withItem),
      'Item 2\'s `.url` is not a github work item URL: "https://example.com/x".',
    ],
    [
      'one work item twice',
      () => read([pr(51), pr(52), pr(51)], withItem),
      'Items 0 and 2 name the same work item (sprocket/catalog-portal#51).',
    ],
    [
      'an object revision',
      () =>
        read(
          [pr(1, { head: 'a' }), pr(2, { head: 'a' }), pr(3, { head: 'a' }), pr(4, { head: {} })],
          changed,
        ),
      "Item 3's `.head` is an object; `changed:` needs text, a number, true or false.",
    ],
  ])('%s', (_name, run, expected) => {
    const result = run();
    expect(result.ok).toBe(false);
    const problem = result.ok ? '' : result.problem;
    if (typeof expected === 'string') expect(problem).toBe(expected);
    else expect(problem).toMatch(expected);
  });
});
