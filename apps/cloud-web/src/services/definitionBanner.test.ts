import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideDefinitionBanner, isDefinitionBannerHidden } from './definitionBanner';

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

describe('the definition banner', () => {
  it('shows until the person hides it, then stays hidden', () => {
    storage();
    expect(isDefinitionBannerHidden()).toBe(false);
    hideDefinitionBanner();
    expect(isDefinitionBannerHidden()).toBe(true);
  });

  it('shows when storage refuses, and hiding it costs nothing', () => {
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
    expect(isDefinitionBannerHidden()).toBe(false);
    expect(() => hideDefinitionBanner()).not.toThrow();
  });
});
