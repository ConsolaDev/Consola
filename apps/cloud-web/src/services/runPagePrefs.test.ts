import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRunPagePrefs, writeRunPagePrefs } from './runPagePrefs';

/** The tests run in Node, so the page's storage is a stand-in. */
function storageWith(stored: Record<string, string>, refuse = false) {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => {
        if (refuse) throw new Error('refused');
        return stored[key] ?? null;
      },
      setItem: (key: string, value: string) => {
        if (refuse) throw new Error('refused');
        stored[key] = value;
      },
    },
  });
  return stored;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('run page preferences', () => {
  it('shows the panel open and nothing folded before anything is kept', () => {
    storageWith({});
    expect(readRunPagePrefs()).toEqual({ infoPanel: true, folded: [] });
  });

  it('keeps what was written', () => {
    storageWith({});
    writeRunPagePrefs({ infoPanel: false, folded: ['budget'] });
    expect(readRunPagePrefs()).toEqual({ infoPanel: false, folded: ['budget'] });
  });

  it('reads what it does not recognise as the defaults', () => {
    storageWith({ 'consola-cloud:run-page': '{"infoPanel":"yes","folded":[1,"run"]}' });
    expect(readRunPagePrefs()).toEqual({ infoPanel: true, folded: ['run'] });
    storageWith({ 'consola-cloud:run-page': 'not json' });
    expect(readRunPagePrefs()).toEqual({ infoPanel: true, folded: [] });
  });

  it('works on with a browser that keeps nothing', () => {
    storageWith({}, true);
    expect(() => writeRunPagePrefs({ infoPanel: false, folded: [] })).not.toThrow();
    expect(readRunPagePrefs()).toEqual({ infoPanel: true, folded: [] });
  });
});
