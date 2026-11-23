import { expect, it } from 'vite-plus/test';
import { compareErrors } from './errorCounts.ts';

it('accepts exactly the known errors', () => {
  expect(compareErrors(['a', 'b'], ['b', 'a'])).toEqual({ unexpected: [], gone: [] });
});

it('reports a second identical error as unexpected', () => {
  expect(compareErrors(['a', 'a'], ['a'])).toEqual({ unexpected: ['a'], gone: [] });
});

it('reports a known error that appears fewer times than listed as gone', () => {
  expect(compareErrors(['a'], ['a', 'a'])).toEqual({ unexpected: [], gone: ['a'] });
});

it('reports an unlisted error and a missing one', () => {
  expect(compareErrors(['c'], ['a'])).toEqual({ unexpected: ['c'], gone: ['a'] });
});
