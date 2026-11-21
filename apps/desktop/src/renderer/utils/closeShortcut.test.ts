import { describe, expect, it } from 'vitest';
import { type CloseState, closeTarget } from './closeShortcut';

/**
 * A session pane with nothing else open, the Files tab in front on screen
 * (so a preview, when one is open, is showing), and the keyboard outside the
 * browser.
 */
function state(overrides: Partial<CloseState> = {}): CloseState {
  return {
    overlay: null,
    activeSessionId: 's1',
    activePreviewTabId: null,
    filesTabOnScreen: true,
    shownBrowserTabId: null,
    keyboard: { in: 'elsewhere' },
    ...overrides,
  };
}

describe('closeTarget', () => {
  it('closes the Inbox or Automations before anything under it', () => {
    expect(closeTarget(state({ overlay: 'inbox', activePreviewTabId: '/a.ts' }))).toBe('overlay');
    expect(
      closeTarget(
        state({ overlay: 'automations', activeSessionId: null, activePreviewTabId: null }),
      ),
    ).toBe('overlay');
  });

  it('closes the active preview tab beside a session', () => {
    expect(closeTarget(state({ activePreviewTabId: '/a.ts' }))).toBe('preview-tab');
  });

  it('leaves a preview alone while the Files tab is behind or hidden', () => {
    expect(closeTarget(state({ activePreviewTabId: '/a.ts', filesTabOnScreen: false }))).toBeNull();
  });

  it('leaves tabs alone when no session pane is showing them', () => {
    expect(closeTarget(state({ activeSessionId: null, activePreviewTabId: '/a.ts' }))).toBeNull();
  });

  it('closes nothing, and never the session, when nothing else is open', () => {
    expect(closeTarget(state())).toBeNull();
  });
});

describe('closeTarget with the browser', () => {
  it('closes the page the keyboard is in, before the preview tab', () => {
    expect(
      closeTarget(
        state({
          shownBrowserTabId: 'tab-b',
          activePreviewTabId: '/a.ts',
          keyboard: { in: 'page', tabId: 'tab-b' },
        }),
      ),
    ).toBe('browser-tab');
  });

  it('closes the shown tab from the panel’s toolbar or tab strip', () => {
    expect(
      closeTarget(
        state({
          shownBrowserTabId: 'tab-b',
          activePreviewTabId: '/a.ts',
          keyboard: { in: 'browser-panel' },
        }),
      ),
    ).toBe('browser-tab');
  });

  it('closes the shown tab from a page main has not bound to its tab yet', () => {
    expect(
      closeTarget(state({ shownBrowserTabId: 'tab-b', keyboard: { in: 'page', tabId: null } })),
    ).toBe('browser-tab');
  });

  it('never closes a browser tab the keyboard is not in', () => {
    // The keyboard in the terminal, or anywhere else: main's rule, unchanged.
    expect(closeTarget(state({ shownBrowserTabId: 'tab-b', activePreviewTabId: '/a.ts' }))).toBe(
      'preview-tab',
    );
    expect(closeTarget(state({ shownBrowserTabId: 'tab-b' }))).toBeNull();
    // A page that is not the one showing is not the browser beside the session.
    expect(
      closeTarget(
        state({
          shownBrowserTabId: 'tab-b',
          activePreviewTabId: '/a.ts',
          keyboard: { in: 'page', tabId: 'tab-a' },
        }),
      ),
    ).toBe('preview-tab');
  });

  it('closes the Inbox or Automations first, wherever the keyboard is', () => {
    expect(
      closeTarget(
        state({
          overlay: 'inbox',
          shownBrowserTabId: 'tab-b',
          keyboard: { in: 'page', tabId: 'tab-b' },
        }),
      ),
    ).toBe('overlay');
  });

  it('closes nothing from the panel once its last tab is gone: not the preview tab, not the panel', () => {
    // A run of ⌘W in the browser ends with the browser's tabs.
    expect(
      closeTarget(state({ activePreviewTabId: '/a.ts', keyboard: { in: 'browser-panel' } })),
    ).toBeNull();
    expect(closeTarget(state({ keyboard: { in: 'browser-panel' } }))).toBeNull();
    // Elsewhere, the preview tab is still the nearest thing.
    expect(closeTarget(state({ activePreviewTabId: '/a.ts' }))).toBe('preview-tab');
  });

  it('closes no browser tab without a session pane', () => {
    expect(
      closeTarget(
        state({
          activeSessionId: null,
          shownBrowserTabId: 'tab-b',
          keyboard: { in: 'page', tabId: 'tab-b' },
        }),
      ),
    ).toBeNull();
  });
});
