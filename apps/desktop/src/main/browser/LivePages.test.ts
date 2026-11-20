import type { BrowserWindow } from 'electron';
import { describe, expect, it } from 'vitest';
import { LivePages } from './LivePages';

const window = { name: 'A' } as unknown as BrowserWindow;

describe('tool calls on a tab', () => {
  it('counts overlapping calls, each released once', () => {
    const pages = new LivePages(() => 0);
    const first = pages.hold('tab1', window);
    const second = pages.hold('tab1', window);
    first.release();
    first.release();
    expect(pages.inCall('tab1')).toBe(true);
    second.release();
    expect(pages.inCall('tab1')).toBe(false);
  });

  it('marks a call that needs no page without making its tab live', () => {
    const pages = new LivePages(() => 0);
    const mark = pages.hold('tab1', window, { mount: false });
    expect(mark.added).toBe(false);
    expect(pages.inCall('tab1')).toBe(true);
    expect(pages.has('tab1')).toBe(false);
    // A rule run while it is marked leaves it unloaded: being marked is not being live.
    expect(pages.evaluate(() => true)).toEqual([]);
    expect(pages.has('tab1')).toBe(false);
    mark.release();
    expect(pages.inCall('tab1')).toBe(false);
    expect(pages.has('tab1')).toBe(false);
  });

  it('a call from before the tab’s page went cannot let go of a newer call', () => {
    const pages = new LivePages(() => 0);
    const stale = pages.hold('tab1', window);
    // The page went (destroyed, replaced, its window gone), and a new call holds the tab.
    pages.drop('tab1');
    const current = pages.hold('tab1', window);
    stale.release();
    expect(pages.inCall('tab1')).toBe(true);
    current.release();
    expect(pages.inCall('tab1')).toBe(false);
  });
});
