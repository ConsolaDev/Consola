import { describe, expect, it, vi } from 'vitest';
import { ViewingTracker } from './ViewingTracker';

describe('ViewingTracker', () => {
  it('counts a session as viewed only in a focused window', () => {
    const tracker = new ViewingTracker(() => {});
    tracker.viewing(1, 'inst-a');
    expect(tracker.isViewedInFocusedWindow('inst-a')).toBe(false);

    tracker.focused(1, true);
    expect(tracker.isViewedInFocusedWindow('inst-a')).toBe(true);

    tracker.focused(1, false);
    expect(tracker.isViewedInFocusedWindow('inst-a')).toBe(false);
  });

  it('announces when a window comes to look at a terminal, by switching to it or by gaining focus', () => {
    const onViewed = vi.fn();
    const tracker = new ViewingTracker(onViewed);
    tracker.focused(1, true);
    tracker.viewing(1, 'inst-a');
    tracker.viewing(1, 'inst-b');
    expect(onViewed.mock.calls).toEqual([['inst-a'], ['inst-b']]);

    tracker.focused(1, false);
    tracker.focused(1, true);
    expect(onViewed).toHaveBeenLastCalledWith('inst-b');
  });

  it('does not announce an unfocused window or a cleared view', () => {
    const onViewed = vi.fn();
    const tracker = new ViewingTracker(onViewed);
    tracker.viewing(1, 'inst-a');
    tracker.focused(1, true);
    onViewed.mockClear();

    tracker.viewing(1, null);
    expect(onViewed).not.toHaveBeenCalled();
    expect(tracker.isViewedInFocusedWindow('inst-a')).toBe(false);
  });

  it('keeps windows apart and forgets a closed one', () => {
    const tracker = new ViewingTracker(() => {});
    tracker.viewing(1, 'inst-a');
    tracker.focused(1, true);
    tracker.viewing(2, 'inst-a');

    tracker.closed(1);
    expect(tracker.isViewedInFocusedWindow('inst-a')).toBe(false);
  });
});

describe('ViewingTracker.onReport', () => {
  it('hears a report that names nothing, which onViewed never does', () => {
    const onViewed = vi.fn();
    const tracker = new ViewingTracker(onViewed);
    const reported = vi.fn();
    tracker.onReport(reported);

    tracker.viewing(1, null);

    expect(reported).toHaveBeenCalledTimes(1);
    expect(onViewed).not.toHaveBeenCalled();
  });

  it('hears a focus report too, and stops after unsubscribing', () => {
    const tracker = new ViewingTracker(() => {});
    const reported = vi.fn();
    const stop = tracker.onReport(reported);

    tracker.focused(1, true);
    expect(reported).toHaveBeenCalledTimes(1);

    stop();
    tracker.viewing(1, 'inst-a');
    expect(reported).toHaveBeenCalledTimes(1);
  });
});

describe('ViewingTracker.isShown', () => {
  it('is true for a shown terminal whether or not the window has focus', () => {
    const tracker = new ViewingTracker(() => {});
    tracker.viewing(1, 'inst-a');
    expect(tracker.isShown('inst-a')).toBe(true);
    expect(tracker.isViewedInFocusedWindow('inst-a')).toBe(false);
    tracker.viewing(1, null);
    expect(tracker.isShown('inst-a')).toBe(false);
  });
});
