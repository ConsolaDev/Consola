import { describe, expect, it } from 'vitest';
import { PersonInputClock, PERSON_INPUT_MS } from './popupPolicy';
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

describe('PopupRegistry', () => {
  it('destroys only the popups the match names', () => {
    const registry = new PopupRegistry();
    const mine = fakePopup();
    const theirs = fakePopup();
    registry.track(mine, { sessionId: 's1', workspaceId: 'w1', host: 'a' });
    registry.track(theirs, { sessionId: 's2', workspaceId: 'w2', host: 'b' });

    registry.closeWhere((owner) => owner.sessionId === 's1');

    expect(mine.destroyed).toBe(true);
    expect(theirs.destroyed).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('closes everything on quit, and skips one already gone', () => {
    const registry = new PopupRegistry();
    const gone = fakePopup();
    const open = fakePopup();
    registry.track(gone, { sessionId: 's1', workspaceId: 'w1', host: 'a' });
    registry.track(open, { sessionId: 's1', workspaceId: 'w1', host: 'a' });
    gone.destroyed = true;

    registry.closeAll();

    expect(open.destroyed).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('forgets a popup that closed by itself', () => {
    const registry = new PopupRegistry();
    const popup = fakePopup();
    registry.track(popup, { sessionId: 's1', workspaceId: 'w1', host: 'a' });
    registry.forget(popup);
    expect(registry.size).toBe(0);
  });
});

describe('PersonInputClock', () => {
  it('counts input only for a short while, and never before any', () => {
    let now = 10_000;
    const clock = new PersonInputClock(() => now);
    expect(clock.isRecent()).toBe(false);
    clock.touch();
    now += PERSON_INPUT_MS;
    expect(clock.isRecent()).toBe(true);
    now += 1;
    expect(clock.isRecent()).toBe(false);
  });
});
