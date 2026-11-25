import { describe, expect, it } from 'vitest';
import { closeTab, keptTabs, NO_TABS, openTab, tabsAfterDelete } from './factoryTabs';

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

  it('moves the editor to a neighbour when the file in front is deleted', () => {
    const listed = ['factory.yml', 'automations/triage.yaml', 'agents/reviewer.md'];
    // Another tab is open: it comes forward, as closing the tab would bring it.
    expect(
      tabsAfterDelete(
        { open: ['factory.yml', 'agents/reviewer.md'], active: 'agents/reviewer.md' },
        'agents/reviewer.md',
        listed,
      ),
    ).toEqual({ open: ['factory.yml'], active: 'factory.yml' });
    // No other tab: the file after it in the list opens, else the one before.
    expect(
      tabsAfterDelete({ open: ['factory.yml'], active: 'factory.yml' }, 'factory.yml', listed),
    ).toEqual({ open: ['automations/triage.yaml'], active: 'automations/triage.yaml' });
    expect(
      tabsAfterDelete(
        { open: ['agents/reviewer.md'], active: 'agents/reviewer.md' },
        'agents/reviewer.md',
        listed,
      ),
    ).toEqual({ open: ['automations/triage.yaml'], active: 'automations/triage.yaml' });
    // The last file: nothing is left to show.
    expect(tabsAfterDelete({ open: ['a'], active: 'a' }, 'a', ['a'])).toEqual(NO_TABS);
  });

  it('only closes the tab of a deleted file that is not in front', () => {
    const tabs = { open: ['a', 'b'], active: 'a' };
    expect(tabsAfterDelete(tabs, 'b', ['a', 'b', 'c'])).toEqual({ open: ['a'], active: 'a' });
    expect(tabsAfterDelete(tabs, 'c', ['a', 'b', 'c'])).toBe(tabs);
  });

  it('closes the tabs of files a version no longer holds', () => {
    expect(keptTabs({ open: ['a', 'b', 'c'], active: 'b' }, ['a', 'c'])).toEqual({
      open: ['a', 'c'],
      active: 'c',
    });
  });
});
