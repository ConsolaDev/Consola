import { beforeEach, describe, expect, it } from 'vitest';
import { showBrowserSlot, useBrowserSlotStore } from './browserSlotStore';

describe('browserSlotStore', () => {
  beforeEach(() => {
    useBrowserSlotStore.setState({ sessionId: null });
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
});
