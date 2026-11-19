import { beforeEach, describe, expect, it } from 'vitest';
import { keepShownSessions, showBrowserSlot, useBrowserSlotStore } from './browserSlotStore';

describe('browserSlotStore', () => {
  beforeEach(() => {
    useBrowserSlotStore.setState({ sessionId: null, shownSessionIds: [] });
  });

  it('names the session whose panel is on screen until it goes', () => {
    const hide = showBrowserSlot('a');
    expect(useBrowserSlotStore.getState().sessionId).toBe('a');
    hide();
    expect(useBrowserSlotStore.getState().sessionId).toBeNull();
  });

  it("does not clear another session's slot that took over first", () => {
    const hideA = showBrowserSlot('a');
    showBrowserSlot('b');
    hideA();
    expect(useBrowserSlotStore.getState().sessionId).toBe('b');
  });

  it('forgets shown sessions outside the ones kept, and changes nothing when all are kept', () => {
    showBrowserSlot('a')();
    showBrowserSlot('b')();
    showBrowserSlot('c')();
    keepShownSessions(new Set(['a', 'c', 'z']));
    expect(useBrowserSlotStore.getState().shownSessionIds).toEqual(['a', 'c']);
    const before = useBrowserSlotStore.getState();
    keepShownSessions(new Set(['a', 'c']));
    expect(useBrowserSlotStore.getState()).toBe(before);
  });

  it('remembers every session shown, once each, first shown first', () => {
    showBrowserSlot('a')();
    showBrowserSlot('b')();
    showBrowserSlot('a')();
    expect(useBrowserSlotStore.getState().shownSessionIds).toEqual(['a', 'b']);
  });
});
