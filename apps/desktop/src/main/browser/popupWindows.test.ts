import { describe, expect, it } from 'vitest';
import { PopupRegistry, type PopupHandle } from './popupWindows';

function fakePopup(): PopupHandle & { destroyed: boolean } {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

/** Whose a popup is: its page's id and its opener's tab are made up per test. */
const owner = (sessionId: string, workspaceId: string, host: string, contentsId = 0) => ({
  sessionId,
  workspaceId,
  host,
  contentsId,
  openerTabId: `${sessionId}-tab`,
});

describe('PopupRegistry', () => {
  it('destroys only the popups the match names', () => {
    const registry = new PopupRegistry();
    const mine = fakePopup();
    const theirs = fakePopup();
    registry.track(mine, owner('s1', 'w1', 'a'));
    registry.track(theirs, owner('s2', 'w2', 'b'));

    registry.closeWhere((owner) => owner.sessionId === 's1');

    expect(mine.destroyed).toBe(true);
    expect(theirs.destroyed).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('closes everything on quit, and skips one already gone', () => {
    const registry = new PopupRegistry();
    const gone = fakePopup();
    const open = fakePopup();
    registry.track(gone, owner('s1', 'w1', 'a'));
    registry.track(open, owner('s1', 'w1', 'a'));
    gone.destroyed = true;

    registry.closeAll();

    expect(open.destroyed).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('forgets a popup that closed by itself', () => {
    const registry = new PopupRegistry();
    const popup = fakePopup();
    registry.track(popup, owner('s1', 'w1', 'a'));
    registry.forget(popup);
    expect(registry.size).toBe(0);
  });

  it("names the tab whose page opened a popup, by the popup's page, until the popup closes", () => {
    const registry = new PopupRegistry();
    const popup = fakePopup();
    registry.track(popup, owner('s1', 'w1', 'a', 20));
    expect(registry.openerTabOf(20)).toBe('s1-tab');
    expect(registry.openerTabOf(21)).toBeUndefined();
    registry.forget(popup);
    expect(registry.openerTabOf(20)).toBeUndefined();
  });
});
