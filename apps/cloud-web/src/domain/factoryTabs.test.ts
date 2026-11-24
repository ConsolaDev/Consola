import { describe, expect, it } from 'vitest';
import { closeTab, keptTabs, NO_TABS, openTab } from './factoryTabs';

describe('factory tabs', () => {
  it('opens a tab right of the one in front, and brings an open one forward', () => {
    let tabs = openTab(NO_TABS, 'a');
    tabs = openTab(tabs, 'b');
    tabs = openTab({ ...tabs, active: 'a' }, 'c');
    expect(tabs).toEqual({ open: ['a', 'c', 'b'], active: 'c' });
    expect(openTab(tabs, 'b')).toEqual({ open: ['a', 'c', 'b'], active: 'b' });
    expect(openTab(tabs, 'c')).toBe(tabs);
  });

  it('brings the right-hand neighbour forward when the tab in front closes, else the left', () => {
    const tabs = { open: ['a', 'b', 'c'], active: 'b' };
    expect(closeTab(tabs, 'b')).toEqual({ open: ['a', 'c'], active: 'c' });
    expect(closeTab({ ...tabs, active: 'c' }, 'c')).toEqual({ open: ['a', 'b'], active: 'b' });
    expect(closeTab(tabs, 'a')).toEqual({ open: ['b', 'c'], active: 'b' });
    expect(closeTab({ open: ['a'], active: 'a' }, 'a')).toEqual({ open: [], active: null });
    expect(closeTab(tabs, 'z')).toBe(tabs);
  });

  it('closes the tabs of files a version no longer holds', () => {
    expect(keptTabs({ open: ['a', 'b', 'c'], active: 'b' }, ['a', 'c'])).toEqual({
      open: ['a', 'c'],
      active: 'c',
    });
  });
});
