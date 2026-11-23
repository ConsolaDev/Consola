import { afterEach, describe, expect, it, vi } from 'vitest';
import { readUnfolded, writeUnfolded } from './foldStore';

/** The tests run in Node, so the page's `window` is a stand-in with just what the module reads. */
function storage(items: Map<string, string> = new Map()) {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
    },
  });
  return items;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the unfolded factories', () => {
  it('are kept per workspace', () => {
    storage();
    writeUnfolded('ws-acme', ['f-1', 'f-2']);
    writeUnfolded('ws-sprocket', ['f-9']);
    expect(readUnfolded('ws-acme')).toEqual(['f-1', 'f-2']);
    expect(readUnfolded('ws-sprocket')).toEqual(['f-9']);
    expect(readUnfolded('ws-other')).toEqual([]);
  });

  it('read anything unreadable as none', () => {
    storage(new Map([['consola-cloud.unfolded-factories.ws-acme', '{nope']]));
    expect(readUnfolded('ws-acme')).toEqual([]);
  });

  it('are only a convenience: storage that refuses, or is missing, costs nothing', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      },
    });
    expect(readUnfolded('ws-acme')).toEqual([]);
    expect(() => writeUnfolded('ws-acme', ['f-1'])).not.toThrow();

    vi.stubGlobal('window', {});
    expect(readUnfolded('ws-acme')).toEqual([]);
    expect(() => writeUnfolded('ws-acme', ['f-1'])).not.toThrow();
  });
});
