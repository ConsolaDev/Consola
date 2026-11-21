import { describe, expect, it } from 'vitest';
import { asRunTarget } from './runTarget';

describe('asRunTarget', () => {
  it('accepts a work item, a key or a url, and copies only their fields', () => {
    expect(
      asRunTarget({ workItem: { repo: 'sprocket/catalog-portal', number: 51, type: 'pr', x: 1 } }),
    ).toStrictEqual({
      workItem: { repo: 'sprocket/catalog-portal', number: 51, type: 'pr' },
    });
    expect(asRunTarget({ key: 'alice/42' })).toStrictEqual({ key: 'alice/42' });
    expect(
      asRunTarget({ url: 'https://github.com/sprocket/catalog-portal/pull/51' }),
    ).toStrictEqual({
      url: 'https://github.com/sprocket/catalog-portal/pull/51',
    });
  });

  it.each([
    null,
    'sprocket/catalog-portal#51',
    7,
    [],
    {},
    { key: '' },
    { key: 3 },
    { key: 'a', url: 'b' },
    { url: '' },
    { workItem: null },
    { workItem: { repo: 'sprocket/catalog-portal', number: 0, type: 'pr' } },
    { workItem: { repo: 'sprocket/catalog-portal', number: 1.5, type: 'pr' } },
    { workItem: { repo: 'sprocket/catalog-portal', number: 51, type: 'branch' } },
    { workItem: { repo: '', number: 51, type: 'pr' } },
  ])('refuses %j', (value) => {
    expect(() => asRunTarget(value)).toThrow('Not a run target.');
  });
});
