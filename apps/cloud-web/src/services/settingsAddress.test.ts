import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentSettingsPageId, onSettingsPageChange } from './settingsAddress';

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
  return { listeners, moveTo };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('currentSettingsPageId', () => {
  it('is the settings page the hash names', () => {
    pageAt('#/settings/connections');
    expect(currentSettingsPageId()).toBe('connections');
  });

  it('is null for Settings alone, or another section', () => {
    pageAt('#/settings');
    expect(currentSettingsPageId()).toBeNull();
    pageAt('#/overview');
    expect(currentSettingsPageId()).toBeNull();
  });
});

describe('onSettingsPageChange', () => {
  it('hears each change of the address with the page it names, until stopped', () => {
    const { listeners, moveTo } = pageAt('#/settings');
    const heard: (string | null)[] = [];
    const stop = onSettingsPageChange((id) => heard.push(id));

    moveTo('#/settings/connections');
    moveTo('#/overview');
    stop();
    moveTo('#/settings/connections');

    expect(heard).toEqual(['connections', null]);
    expect(listeners.size).toBe(0);
  });
});
