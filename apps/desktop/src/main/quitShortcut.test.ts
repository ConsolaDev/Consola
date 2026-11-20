import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIT_DOUBLE_PRESS_MS, QUIT_HOLD_MS, createQuitShortcut } from './quitShortcut';

const REPEAT_MS = 35;

function setup() {
  const notify = vi.fn<(state: 'down' | 'up') => void>();
  const conceal = vi.fn();
  const quit = vi.fn();
  const handle = createQuitShortcut({ notify, conceal, quit });
  let prevented = 0;
  const send = (
    type: 'keyDown' | 'keyUp',
    key: string,
    { meta = key.toLowerCase() === 'q' || key === 'Meta', repeat = false, shift = false } = {},
  ) => {
    handle(
      { preventDefault: () => (prevented += 1) },
      {
        type,
        key,
        meta,
        control: false,
        alt: false,
        shift,
        isAutoRepeat: repeat,
      },
    );
  };
  /** Hold ⌘Q, auto-repeating, for `ms` after its first keydown. */
  const holdFor = (ms: number) => {
    send('keyDown', 'q');
    for (let elapsed = REPEAT_MS; elapsed <= ms; elapsed += REPEAT_MS) {
      vi.advanceTimersByTime(REPEAT_MS);
      send('keyDown', 'q', { repeat: true });
    }
  };
  return { notify, conceal, quit, send, holdFor, prevented: () => prevented };
}

describe('createQuitShortcut', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('swallows a single ⌘Q and shows the hint instead of quitting', () => {
    const t = setup();
    t.send('keyDown', 'q');

    expect(t.prevented()).toBe(1);
    expect(t.notify).toHaveBeenCalledWith('down');
    expect(t.quit).not.toHaveBeenCalled();

    t.send('keyUp', 'q');
    expect(t.notify).toHaveBeenLastCalledWith('up');
    vi.advanceTimersByTime(5000);
    expect(t.quit).not.toHaveBeenCalled();
  });

  it('quits on a second press inside the double-press window', () => {
    const t = setup();
    t.send('keyDown', 'q');
    t.send('keyUp', 'q');
    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS - 100);
    t.send('keyDown', 'q');

    expect(t.quit).toHaveBeenCalledTimes(1);
    expect(t.conceal).not.toHaveBeenCalled();
  });

  it('counts a second press as double even when macOS swallowed the first keyUp', () => {
    const t = setup();
    t.send('keyDown', 'q');
    vi.advanceTimersByTime(200);
    t.send('keyDown', 'q');

    expect(t.quit).toHaveBeenCalledTimes(1);
  });

  it('does not quit on two presses further apart than the window', () => {
    const t = setup();
    t.send('keyDown', 'q');
    t.send('keyUp', 'q');
    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS + 100);
    t.send('keyDown', 'q');

    expect(t.quit).not.toHaveBeenCalled();
  });

  it('lets go of the hint when the press ends without a keyUp', () => {
    const t = setup();
    t.send('keyDown', 'q');
    vi.advanceTimersByTime(QUIT_HOLD_MS + 1000);

    expect(t.notify).toHaveBeenLastCalledWith('up');
    expect(t.quit).not.toHaveBeenCalled();
  });

  it('hides the window once held, then quits on release', () => {
    const t = setup();
    t.holdFor(QUIT_HOLD_MS + REPEAT_MS);

    expect(t.conceal).toHaveBeenCalledTimes(1);
    expect(t.quit).not.toHaveBeenCalled();

    t.send('keyUp', 'q');
    expect(t.quit).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting while repeats still arrive, then quits once they stop', () => {
    const t = setup();
    t.holdFor(QUIT_HOLD_MS + 1000);
    expect(t.quit).not.toHaveBeenCalled();

    // No keyUp ever comes: the repeats simply stop.
    vi.advanceTimersByTime(1000);
    expect(t.quit).toHaveBeenCalledTimes(1);
  });

  it('quits after a quiet moment when ⌘ is released first', () => {
    const t = setup();
    t.holdFor(QUIT_HOLD_MS + REPEAT_MS);
    t.send('keyUp', 'Meta', { meta: false });
    expect(t.quit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(t.quit).toHaveBeenCalledTimes(1);
  });

  it('does not quit when the hold is let go too early', () => {
    const t = setup();
    t.holdFor(QUIT_HOLD_MS - 200);
    t.send('keyUp', 'q');
    vi.advanceTimersByTime(5000);

    expect(t.conceal).not.toHaveBeenCalled();
    expect(t.quit).not.toHaveBeenCalled();
  });

  it('leaves other ⌘ chords alone, and they cancel a pending double press', () => {
    const t = setup();
    t.send('keyDown', 'q');
    t.send('keyUp', 'q');
    t.send('keyDown', 'w', { meta: true });
    expect(t.prevented()).toBe(1);

    t.send('keyDown', 'q');
    expect(t.quit).not.toHaveBeenCalled();
  });

  it('ignores ⇧⌘Q', () => {
    const t = setup();
    t.send('keyDown', 'q', { shift: true });

    expect(t.prevented()).toBe(0);
    expect(t.notify).not.toHaveBeenCalled();
  });
});
