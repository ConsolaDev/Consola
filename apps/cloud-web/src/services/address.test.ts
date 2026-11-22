import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentSectionId, onSectionChange, openSection } from './address';

/** The tests run in Node, so the page's `window` is a stand-in with just what the module reads. */
function pageAt(hash: string) {
  const listeners = new Set<() => void>();
  const location = { hash };
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
  return { location, listeners, moveTo };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('currentSectionId', () => {
  it('is the section the hash names', () => {
    pageAt('#/teams');
    expect(currentSectionId()).toBe('teams');
  });

  it('ignores a result sent back after the id', () => {
    pageAt('#/connections?github=installed');
    expect(currentSectionId()).toBe('connections');
  });

  it('is null without a section', () => {
    pageAt('');
    expect(currentSectionId()).toBeNull();
  });
});

describe('openSection', () => {
  it('writes only the hash', () => {
    const { location } = pageAt('#/overview');
    openSection('teams');
    expect(location).toEqual({ hash: '#/teams' });
  });
});

describe('onSectionChange', () => {
  it('hears each change with the section the address names now', () => {
    const page = pageAt('#/overview');
    const heard: (string | null)[] = [];
    onSectionChange((id) => heard.push(id));
    page.moveTo('#/teams');
    page.moveTo('#nowhere');
    expect(heard).toEqual(['teams', null]);
  });

  it('stops hearing once stopped', () => {
    const page = pageAt('#/overview');
    const heard: (string | null)[] = [];
    const stop = onSectionChange((id) => heard.push(id));
    stop();
    page.moveTo('#/teams');
    expect(heard).toEqual([]);
    expect(page.listeners.size).toBe(0);
  });
});
