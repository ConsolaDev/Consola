import { describe, expect, it } from 'vitest';
import {
  addPlaceholder,
  bringToFront,
  canSplit,
  choosePlaceholder,
  closeGroup,
  closeTab,
  defaultLayout,
  type Edge,
  firstFreeId,
  groupOfTab,
  groupPosition,
  groupsOf,
  isInFront,
  type LayoutNode,
  moveTab,
  NEW_TAB,
  openKind,
  pressShortcut,
  type SidePanelLayout,
  type SplitOrientation,
  setVisible,
  splitWithTab,
  toggleMaximize,
  visibleGroups,
} from './layout';

const group = (id: string, tabs: string[], active: string | null = tabs[0] ?? null) =>
  ({ type: 'group', id, tabs, active }) as const;
const split = (orientation: SplitOrientation, ...children: LayoutNode[]) =>
  ({ type: 'split', orientation, children }) as const;
const shown = (root: LayoutNode, extra: Partial<SidePanelLayout> = {}): SidePanelLayout => ({
  ...defaultLayout(),
  visible: true,
  root,
  ...extra,
});

describe('defaultLayout', () => {
  it('is hidden with one empty group', () => {
    expect(defaultLayout()).toEqual({
      version: 1,
      visible: false,
      root: group('g1', [], null),
      maximized: null,
      lastGroupOf: {},
    });
  });
});

describe('openKind', () => {
  it('opens into the first group and shows the panel', () => {
    expect(openKind(defaultLayout(), 'changes')).toEqual(shown(group('g1', ['changes'])));
  });

  it('brings an open kind to the front where it is', () => {
    const hidden = {
      ...shown(split('stacked', group('g1', ['changes', 'files']), group('g2', ['terminal']))),
      visible: false,
    };
    expect(openKind(hidden, 'files')).toEqual(
      shown(
        split('stacked', group('g1', ['changes', 'files'], 'files'), group('g2', ['terminal'])),
      ),
    );
  });

  it('returns a kind to the group it was last closed in', () => {
    const layout = shown(split('stacked', group('g1', ['changes']), group('g2', ['terminal'])), {
      lastGroupOf: { files: 'g2' },
    });
    expect(openKind(layout, 'files').root).toEqual(
      split('stacked', group('g1', ['changes']), group('g2', ['terminal', 'files'], 'files')),
    );
  });

  it('falls back to the first group', () => {
    const layout = shown(split('stacked', group('g1', ['changes']), group('g2', ['terminal'])), {
      lastGroupOf: { files: 'g9' },
    });
    expect(openKind(layout, 'files').root).toEqual(
      split('stacked', group('g1', ['changes', 'files'], 'files'), group('g2', ['terminal'])),
    );
  });

  it('replaces the placeholder in front', () => {
    const layout = shown(group('g1', ['changes', NEW_TAB], NEW_TAB));
    expect(openKind(layout, 'files')).toEqual(shown(group('g1', ['changes', 'files'], 'files')));
  });

  it('keeps a placeholder that is behind another tab', () => {
    const layout = shown(group('g1', [NEW_TAB, 'changes'], 'changes'));
    expect(openKind(layout, 'files').root).toEqual(
      group('g1', [NEW_TAB, 'changes', 'files'], 'files'),
    );
  });

  it('restores the split to show a kind in the hidden group', () => {
    const layout = shown(
      split('stacked', group('g1', ['changes']), group('g2', ['files', 'terminal'])),
      { maximized: 'g1' },
    );
    const next = openKind(layout, 'terminal');
    expect(next.maximized).toBeNull();
    expect(groupOfTab(next, 'terminal')).toEqual(group('g2', ['files', 'terminal'], 'terminal'));
  });
});

describe('bringToFront', () => {
  it('fronts a tab in its group', () => {
    const layout = shown(group('g1', ['changes', 'files']));
    expect(bringToFront(layout, 'g1', 'files')).toEqual(
      shown(group('g1', ['changes', 'files'], 'files')),
    );
  });

  it('restores the split to front a tab in the hidden group', () => {
    const layout = shown(
      split('stacked', group('g1', ['changes']), group('g2', ['files', 'terminal'])),
      { maximized: 'g1' },
    );
    const next = bringToFront(layout, 'g2', 'terminal');
    expect(next.maximized).toBeNull();
    expect(groupOfTab(next, 'terminal')?.active).toBe('terminal');
  });
});

describe('closeTab', () => {
  it('hands the front to the tab before, else after', () => {
    const tabs = ['changes', 'files', 'terminal'];
    expect(closeTab(shown(group('g1', tabs, 'files')), 'g1', 'files').root).toEqual(
      group('g1', ['changes', 'terminal'], 'changes'),
    );
    expect(closeTab(shown(group('g1', tabs, 'changes')), 'g1', 'changes').root).toEqual(
      group('g1', ['files', 'terminal'], 'files'),
    );
  });

  it('leaves the front alone when closing a tab behind it', () => {
    const layout = shown(group('g1', ['changes', 'files', 'terminal'], 'terminal'));
    expect(closeTab(layout, 'g1', 'changes').root).toEqual(
      group('g1', ['files', 'terminal'], 'terminal'),
    );
  });

  it('removes an emptied group and the other fills the panel', () => {
    const layout = shown(split('side-by-side', group('g1', ['changes']), group('g2', ['files'])), {
      maximized: 'g2',
    });
    expect(closeTab(layout, 'g2', 'files')).toEqual(
      shown(group('g1', ['changes']), { maximized: null, lastGroupOf: {} }),
    );
  });

  it('forgets what it remembered of a removed group, so a group reusing its id inherits nothing', () => {
    const layout = shown(split('stacked', group('g1', ['changes']), group('g2', ['files'])), {
      lastGroupOf: { terminal: 'g2', 'pull-request': 'g1' },
    });
    expect(closeTab(layout, 'g2', 'files').lastGroupOf).toEqual({ 'pull-request': 'g1' });
  });

  it('remembers the group a closed kind was in', () => {
    const layout = shown(
      split('stacked', group('g1', ['changes']), group('g2', ['files', 'terminal'])),
    );
    expect(closeTab(layout, 'g2', 'files').lastGroupOf).toEqual({ files: 'g2' });
  });

  it('remembers nothing for a closed placeholder', () => {
    const layout = shown(group('g1', ['changes', NEW_TAB], NEW_TAB));
    expect(closeTab(layout, 'g1', NEW_TAB)).toEqual(shown(group('g1', ['changes'])));
  });

  it('hides the panel when the last tab of the last group closes', () => {
    expect(closeTab(shown(group('g1', ['changes'])), 'g1', 'changes')).toEqual({
      ...defaultLayout(),
      visible: false,
    });
  });

  it('the last group keeps its own id when it empties, and forgets what it remembered', () => {
    const layout = shown(group('g2', ['files']), { lastGroupOf: { changes: 'g2' } });
    expect(closeTab(layout, 'g2', 'files')).toEqual({
      ...defaultLayout(),
      root: group('g2', [], null),
    });
  });

  it('closing the last tab of a group forgets where that kind was closed before', () => {
    // Files was closed in g1 once, and is open in g2 now.
    const layout = shown(split('stacked', group('g1', ['changes']), group('g2', ['files'])), {
      lastGroupOf: { files: 'g1' },
    });
    expect(closeTab(layout, 'g2', 'files').lastGroupOf).toEqual({});
  });

  it('returns the same layout for a tab that is not there', () => {
    const layout = shown(group('g1', ['changes']));
    expect(closeTab(layout, 'g1', 'files')).toBe(layout);
    expect(closeTab(layout, 'g2', 'changes')).toBe(layout);
  });
});

describe('closeGroup', () => {
  it('closes every tab in the group and the other fills the panel', () => {
    const layout = shown(
      split('stacked', group('g1', ['changes']), group('g2', ['files', 'terminal'])),
    );
    expect(closeGroup(layout, 'g2')).toEqual(shown(group('g1', ['changes'])));
  });

  it('closing the only group hides the panel', () => {
    expect(closeGroup(shown(group('g1', ['changes', 'files'])), 'g1')).toEqual(defaultLayout());
  });

  it('forgets where the kinds it closes were closed before', () => {
    const layout = shown(
      split('stacked', group('g1', ['changes']), group('g2', ['files', 'terminal'])),
      { lastGroupOf: { files: 'g1', terminal: 'g1', 'pull-request': 'g1' } },
    );
    expect(closeGroup(layout, 'g2').lastGroupOf).toEqual({ 'pull-request': 'g1' });
  });

  it('returns the same layout for a group that is not there, or holds nothing', () => {
    const layout = shown(group('g1', ['changes']));
    expect(closeGroup(layout, 'g2')).toBe(layout);
    const empty = defaultLayout();
    expect(closeGroup(empty, 'g1')).toBe(empty);
  });
});

describe('moveTab', () => {
  it('reorders within a group', () => {
    const layout = shown(group('g1', ['changes', 'files', 'terminal']));
    expect(moveTab(layout, 'terminal', 'g1', 0).root).toEqual(
      group('g1', ['terminal', 'changes', 'files'], 'terminal'),
    );
  });

  it('counts the index after the tab has left its place', () => {
    const layout = shown(group('g1', ['changes', 'files', 'terminal']));
    expect(moveTab(layout, 'changes', 'g1', 1).root).toEqual(
      group('g1', ['files', 'changes', 'terminal'], 'changes'),
    );
    expect(moveTab(layout, 'changes', 'g1', 2).root).toEqual(
      group('g1', ['files', 'terminal', 'changes'], 'changes'),
    );
  });

  it('moves to the other group at an index and fronts it there', () => {
    const layout = shown(
      split('stacked', group('g1', ['changes', 'files'], 'files'), group('g2', ['terminal'])),
    );
    expect(moveTab(layout, 'files', 'g2', 0).root).toEqual(
      split(
        'stacked',
        group('g1', ['changes'], 'changes'),
        group('g2', ['files', 'terminal'], 'files'),
      ),
    );
  });

  it("moving a group's only tab away removes the group", () => {
    const layout = shown(split('stacked', group('g1', ['changes']), group('g2', ['terminal'])));
    expect(moveTab(layout, 'changes', 'g2', 1)).toEqual(
      shown(group('g2', ['terminal', 'changes'], 'changes')),
    );
  });

  it('restores the split when a tab moves into the hidden group', () => {
    const layout = shown(
      split('stacked', group('g1', ['changes', 'files']), group('g2', ['terminal'])),
      { maximized: 'g1' },
    );
    expect(moveTab(layout, 'files', 'g2', 1).maximized).toBeNull();
  });

  it('returns the same layout when there is nothing to move', () => {
    const layout = shown(group('g1', ['changes', 'files', NEW_TAB], 'files'));
    expect(moveTab(layout, 'files', 'g1', 1)).toBe(layout);
    expect(moveTab(layout, 'terminal', 'g1', 0)).toBe(layout);
    expect(moveTab(layout, 'files', 'g2', 0)).toBe(layout);
    expect(moveTab(layout, NEW_TAB, 'g1', 0)).toBe(layout);
  });
});

describe('split', () => {
  it('canSplit needs room for a group, a tab with company, and never the placeholder', () => {
    const two = shown(
      split('stacked', group('g1', ['changes', 'files']), group('g2', ['terminal'])),
    );
    expect(canSplit(two, 'g1', 'files')).toBe(false);
    expect(canSplit(shown(group('g1', ['changes'])), 'g1', 'changes')).toBe(false);
    expect(canSplit(shown(group('g1', ['changes', NEW_TAB])), 'g1', NEW_TAB)).toBe(false);
    expect(canSplit(shown(group('g1', ['changes', 'files'])), 'g1', 'files')).toBe(true);
  });

  it.each<[Edge, SplitOrientation, 'kept-first' | 'new-first']>([
    ['bottom', 'stacked', 'kept-first'],
    ['top', 'stacked', 'new-first'],
    ['right', 'side-by-side', 'kept-first'],
    ['left', 'side-by-side', 'new-first'],
  ])('splits toward the %s edge', (edge, orientation, order) => {
    const kept = group('g1', ['changes']);
    const added = group('g2', ['files'], 'files');
    const layout = shown(group('g1', ['changes', 'files'], 'files'));
    expect(splitWithTab(layout, 'g1', 'files', edge)).toEqual(
      shown(split(orientation, ...(order === 'kept-first' ? [kept, added] : [added, kept]))),
    );
  });

  it('refuses a third group', () => {
    const layout = shown(
      split('stacked', group('g1', ['changes', 'files']), group('g2', ['terminal'])),
    );
    expect(splitWithTab(layout, 'g1', 'files', 'bottom')).toBe(layout);
  });

  it('names a new group with the first free id', () => {
    const layout = shown(group('g2', ['changes', 'files']));
    expect(splitWithTab(layout, 'g2', 'files', 'right').root).toEqual(
      split('side-by-side', group('g2', ['changes']), group('g1', ['files'])),
    );
  });

  it('firstFreeId is the lowest id not taken', () => {
    expect(firstFreeId(new Set())).toBe('g1');
    expect(firstFreeId(new Set(['g1', 'g3']))).toBe('g2');
    expect(firstFreeId(new Set(['g2', 'g1']))).toBe('g3');
  });
});

describe('toggleMaximize', () => {
  it('maximizes a group and restores it', () => {
    const layout = shown(split('stacked', group('g1', ['changes']), group('g2', ['files'])));
    const maximized = toggleMaximize(layout, 'g2');
    expect(maximized.maximized).toBe('g2');
    expect(toggleMaximize(maximized, 'g2')).toEqual(layout);
  });

  it('does nothing with one group', () => {
    const layout = shown(group('g1', ['changes', 'files']));
    expect(toggleMaximize(layout, 'g1')).toBe(layout);
  });
});

describe('visibility', () => {
  const tree = split(
    'stacked',
    group('g1', ['changes']),
    group('g2', ['files', 'terminal'], 'terminal'),
  );

  it('visibleGroups is empty while hidden and only the maximized group while maximized', () => {
    expect(visibleGroups({ ...shown(tree), visible: false })).toEqual([]);
    expect(visibleGroups(shown(tree, { maximized: 'g1' }))).toEqual([group('g1', ['changes'])]);
    expect(visibleGroups(shown(tree))).toEqual(groupsOf(shown(tree)));
  });

  it('isInFront only for the front tab of a group on screen', () => {
    expect(isInFront(shown(tree, { maximized: 'g1' }), 'terminal')).toBe(false);
    expect(isInFront({ ...shown(tree), visible: false }, 'terminal')).toBe(false);
    expect(isInFront(shown(tree), 'files')).toBe(false);
    expect(isInFront(shown(tree), 'terminal')).toBe(true);
    expect(isInFront(shown(tree, { maximized: 'g2' }), 'terminal')).toBe(true);
  });

  it('groupPosition names where a group sits', () => {
    expect(groupPosition(shown(group('g1', ['changes'])), 'g1')).toBe('only');
    const stacked = shown(split('stacked', group('g1', ['changes']), group('g2', ['files'])));
    expect(groupPosition(stacked, 'g1')).toBe('top');
    expect(groupPosition(stacked, 'g2')).toBe('bottom');
    const sideBySide = shown(
      split('side-by-side', group('g1', ['changes']), group('g2', ['files'])),
    );
    expect(groupPosition(sideBySide, 'g1')).toBe('left');
    expect(groupPosition(sideBySide, 'g2')).toBe('right');
  });
});

describe('placeholder', () => {
  it('addPlaceholder opens a new tab in front, never a second one', () => {
    const once = addPlaceholder(defaultLayout(), 'g1');
    expect(once).toEqual(shown(group('g1', [NEW_TAB], NEW_TAB)));
    expect(addPlaceholder(once, 'g1')).toBe(once);
    const behind = shown(group('g1', ['changes', NEW_TAB], 'changes'));
    expect(addPlaceholder(behind, 'g1')).toEqual(shown(group('g1', ['changes', NEW_TAB], NEW_TAB)));
  });

  it('addPlaceholder in the hidden group restores the split', () => {
    const layout = shown(split('stacked', group('g1', ['changes']), group('g2', ['files'])), {
      maximized: 'g1',
    });
    expect(addPlaceholder(layout, 'g2').maximized).toBeNull();
  });

  it('choosePlaceholder turns it into the kind in place', () => {
    const layout = shown(group('g1', ['changes', NEW_TAB, 'terminal'], NEW_TAB));
    expect(choosePlaceholder(layout, 'g1', 'files')).toEqual(
      shown(group('g1', ['changes', 'files', 'terminal'], 'files')),
    );
  });

  it('choosing a kind open elsewhere fronts it there and drops the placeholder', () => {
    const layout = shown(
      split(
        'stacked',
        group('g1', ['changes', NEW_TAB], NEW_TAB),
        group('g2', ['files', 'terminal'], 'terminal'),
      ),
    );
    expect(choosePlaceholder(layout, 'g1', 'files')).toEqual(
      shown(
        split('stacked', group('g1', ['changes']), group('g2', ['files', 'terminal'], 'files')),
      ),
    );
  });

  it('choosing a kind open elsewhere removes the group the placeholder leaves empty', () => {
    const layout = shown(split('stacked', group('g1', ['changes']), group('g2', [NEW_TAB])));
    expect(choosePlaceholder(layout, 'g2', 'changes')).toEqual(shown(group('g1', ['changes'])));
  });

  it('choosing a kind open beside the placeholder fronts it and drops the placeholder', () => {
    const layout = shown(group('g1', ['changes', 'files', NEW_TAB], NEW_TAB));
    expect(choosePlaceholder(layout, 'g1', 'changes')).toEqual(
      shown(group('g1', ['changes', 'files'], 'changes')),
    );
  });

  it('choosePlaceholder does nothing in a group without one', () => {
    const layout = shown(group('g1', ['changes']));
    expect(choosePlaceholder(layout, 'g1', 'files')).toBe(layout);
  });
});

describe('setVisible', () => {
  it('showing a panel with no tabs opens the placeholder', () => {
    expect(setVisible(defaultLayout(), true)).toEqual(shown(group('g1', [NEW_TAB], NEW_TAB)));
  });

  it('hiding keeps every tab, and showing brings them back', () => {
    const layout = shown(split('stacked', group('g1', ['changes']), group('g2', ['files'])), {
      maximized: 'g2',
    });
    const hidden = setVisible(layout, false);
    expect(hidden).toEqual({ ...layout, visible: false });
    expect(setVisible(hidden, true)).toEqual(layout);
  });

  it('returns the same layout when nothing changes', () => {
    const layout = shown(group('g1', ['changes']));
    expect(setVisible(layout, true)).toBe(layout);
    const hidden = { ...layout, visible: false };
    expect(setVisible(hidden, false)).toBe(hidden);
  });
});

describe('pressShortcut', () => {
  it('hides the panel, keeping the tabs, when the kind is in front and visible', () => {
    const layout = shown(group('g1', ['changes', 'files'], 'files'));
    expect(pressShortcut(layout, 'files')).toEqual({ ...layout, visible: false });
  });

  it('otherwise opens the kind', () => {
    const tree = split(
      'stacked',
      group('g1', ['changes', 'files'], 'files'),
      group('g2', ['terminal']),
    );
    const cases: Array<[SidePanelLayout, string]> = [
      [shown(tree), 'changes'],
      [{ ...shown(tree), visible: false }, 'files'],
      [shown(tree), 'pull-request'],
      [shown(tree, { maximized: 'g1' }), 'terminal'],
    ];
    for (const [layout, kind] of cases) {
      expect(pressShortcut(layout, kind)).toEqual(openKind(layout, kind));
    }
  });
});

describe('returns its input when the action does not apply', () => {
  const layout = shown(
    split('stacked', group('g1', ['changes', 'files']), group('g2', ['terminal'])),
  );

  it.each<[string, (l: SidePanelLayout) => SidePanelLayout]>([
    ['opening the kind in front', (l) => openKind(l, 'changes')],
    ['fronting the tab in front', (l) => bringToFront(l, 'g1', 'changes')],
    ['fronting a tab the group does not hold', (l) => bringToFront(l, 'g2', 'changes')],
    ['splitting from a group that is not there', (l) => splitWithTab(l, 'g3', 'files', 'top')],
    ['maximizing a group that is not there', (l) => toggleMaximize(l, 'g3')],
    ['adding a placeholder to a group that is not there', (l) => addPlaceholder(l, 'g3')],
    ['choosing a placeholder in a group that is not there', (l) => choosePlaceholder(l, 'g3', 'x')],
  ])('%s', (_, act) => {
    expect(act(layout)).toBe(layout);
  });
});
