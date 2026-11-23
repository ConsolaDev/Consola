import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentHash, onHashChange, openHash, replaceHash } from './address';

/** The tests run in Node, so the page's `window` is a stand-in with just what the module reads. */
function pageAt(hash: string) {
  const listeners = new Set<() => void>();
  const replace = vi.fn();
  const location = { hash, replace };
  vi.stubGlobal('window', {
    location,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'hashchange') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'hashchange') listeners.delete(listener);
    },
  });
  /** What a browser does when the hash changes: sets it, then tells every listener. */
  const moveTo = (next: string) => {
    location.hash = next;
    for (const listener of listeners) listener();
  };
  return { location, replace, listeners, moveTo };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('currentHash', () => {
  it('is the hash as the page holds it, whole', () => {
    pageAt('#/factories/f-1/settings');
    expect(currentHash()).toBe('#/factories/f-1/settings');
  });
});

describe('openHash', () => {
  it('writes only the hash', () => {
    const { location } = pageAt('#/overview');
    openHash('#/factories/f-1/definition');
    expect(location.hash).toBe('#/factories/f-1/definition');
  });
});

describe('replaceHash', () => {
  it('replaces the address in place, with no new entry', () => {
    const { replace } = pageAt('#/factories');
    replaceHash('#/overview');
    expect(replace).toHaveBeenCalledWith('#/overview');
  });
});

describe('onHashChange', () => {
  it('hears each change', () => {
    const page = pageAt('#/overview');
    let heard = 0;
    onHashChange(() => heard++);
    page.moveTo('#/factories');
    page.moveTo('#nowhere');
    expect(heard).toBe(2);
  });

  it('stops hearing once stopped', () => {
    const page = pageAt('#/overview');
    let heard = 0;
    const stop = onHashChange(() => heard++);
    stop();
    page.moveTo('#/factories');
    expect(heard).toBe(0);
    expect(page.listeners.size).toBe(0);
  });
});
