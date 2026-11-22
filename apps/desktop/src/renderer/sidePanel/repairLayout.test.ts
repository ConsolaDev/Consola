import { describe, expect, it } from 'vitest';
import {
  closeTab,
  defaultLayout,
  groupsOf,
  isInFront,
  type LayoutNode,
  NEW_TAB,
  openKind,
  type SidePanelLayout,
  type SplitOrientation,
  setVisible,
} from './layout';
import { repairLayout } from './repairLayout';

/** How many tabs the layout holds, placeholders included. */
const tabCount = (layout: SidePanelLayout) =>
  groupsOf(layout).reduce((count, each) => count + each.tabs.length, 0);

const known = ['changes', 'files', 'terminal'];

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

const unusable: unknown[] = [
  undefined,
  null,
  42,
  'x',
  [],
  {},
  { version: 2 },
  { isExplorerVisible: true },
];
const malformed: unknown[] = [
  { version: 1, root: { type: 'split', children: 'x' } },
  { version: 1, root: { type: 'group', tabs: [1, null, {}], active: 7 } },
  { version: 1, root: null, lastGroupOf: [] },
];

// Stored layouts the cases below repair, each into something other than
// the default: what the layout module must then be able to act on.
const wellFormed = shown(
  split(
    'stacked',
    group('g1', ['changes', NEW_TAB], NEW_TAB),
    group('g2', ['files', 'terminal'], 'terminal'),
  ),
  { maximized: 'g2', lastGroupOf: { changes: 'g2' } },
);
const overfull = shown(
  split(
    'stacked',
    split('side-by-side', group('g1', ['changes']), group('g2', ['files'])),
    group('g3', ['terminal']),
  ),
);
const repeats = shown(
  split(
    'side-by-side',
    group('g1', ['changes', NEW_TAB, 'changes', NEW_TAB, 'files']),
    group('g2', [NEW_TAB, 'files', 'terminal', NEW_TAB], 'files'),
  ),
);
const unnamed = shown(
  split(
    'stacked',
    { type: 'group', tabs: ['changes'], active: 'changes' } as unknown as LayoutNode,
    group('g1', ['files']),
  ),
);
const sameNames = shown(split('stacked', group('g1', ['changes']), group('g1', ['files'])));
const maximizedGone = shown(split('stacked', group('g1', ['changes']), group('g2', ['files'])), {
  maximized: 'g3',
});
const maximizedAlone = shown(split('stacked', group('g1', ['changes']), group('g2', ['browser'])), {
  maximized: 'g1',
});

describe('repairLayout', () => {
  it('answers the default for anything unusable', () => {
    for (const raw of unusable) expect(repairLayout(raw, known)).toEqual(defaultLayout());
  });

  it('keeps a well-formed split as it is', () => {
    expect(repairLayout(wellFormed, known)).toEqual(wellFormed);
    const lone = { ...shown(group('g1', ['files'])), visible: false };
    expect(repairLayout(lone, known)).toEqual(lone);
  });

  it('drops a kind this build does not know', () => {
    const stored = shown(group('g1', ['changes', 'browser'], 'browser'));
    expect(repairLayout(stored, known)).toEqual(shown(group('g1', ['changes'], 'changes')));
  });

  it('keeps one tab per kind and one placeholder per group', () => {
    expect(repairLayout(repeats, known)).toEqual(
      shown(
        split(
          'side-by-side',
          group('g1', ['changes', NEW_TAB, 'files'], 'changes'),
          group('g2', [NEW_TAB, 'terminal'], NEW_TAB),
        ),
      ),
    );
  });

  it('removes empty groups and collapses a split left with one child', () => {
    const stored = shown(
      split('stacked', group('g1', ['browser']), group('g2', [], null), group('g3', ['files'])),
    );
    expect(repairLayout(stored, known)).toEqual(shown(group('g3', ['files'])));
  });

  it('keeps at most two groups', () => {
    expect(repairLayout(overfull, known)).toEqual(
      shown(split('stacked', group('g1', ['changes']), group('g2', ['files']))),
    );

    const unoriented = {
      ...overfull,
      root: {
        type: 'split',
        children: [group('g1', ['changes']), group('g2', ['files']), group('g3', ['terminal'])],
      },
    };
    expect(repairLayout(unoriented, known)).toEqual(
      shown(split('side-by-side', group('g1', ['changes']), group('g2', ['files']))),
    );
  });

  it('clears a maximized group that is gone, or that has no partner', () => {
    expect(repairLayout(maximizedGone, known)).toEqual({ ...maximizedGone, maximized: null });
    expect(repairLayout(maximizedAlone, known)).toEqual(shown(group('g1', ['changes'])));
  });

  it('hides a panel left with nothing in it', () => {
    const stored = shown(group('g1', ['browser']));
    expect(repairLayout(stored, known)).toEqual(defaultLayout());
  });

  it('hides a panel whose visible is not a boolean', () => {
    const stored = { ...shown(group('g1', ['files'])), visible: 'yes' };
    expect(repairLayout(stored, known)).toEqual({
      ...shown(group('g1', ['files'])),
      visible: false,
    });
  });

  it('renames missing or repeated group ids', () => {
    expect(repairLayout(unnamed, known)).toEqual(
      shown(split('stacked', group('g2', ['changes']), group('g1', ['files']))),
    );
    expect(repairLayout(sameNames, known)).toEqual(
      shown(split('stacked', group('g1', ['changes']), group('g2', ['files']))),
    );
  });

  it('forgets lastGroupOf entries for unknown kinds or groups that are gone', () => {
    const stored = {
      ...shown(split('stacked', group('g1', ['changes']), group('g2', ['browser']))),
      lastGroupOf: { files: 'g1', terminal: 'g2', browser: 'g1', [NEW_TAB]: 'g1', changes: 7 },
    };
    expect(repairLayout(stored, known)).toEqual(
      shown(group('g1', ['changes']), { lastGroupOf: { files: 'g1' } }),
    );

    // A renamed group was never the group an entry was written about.
    const renamed = {
      ...shown(split('stacked', group('g1', ['changes']), group('g1', ['files']))),
      lastGroupOf: { terminal: 'g2' },
    };
    expect(repairLayout(renamed, known).lastGroupOf).toEqual({});
  });

  it('never throws', () => {
    for (const raw of malformed) expect(() => repairLayout(raw, known)).not.toThrow();
  });

  it('walks a tree nested deeper than recursion could', () => {
    let root: unknown = group('g1', ['files']);
    for (let depth = 0; depth < 100_000; depth += 1) {
      root = { type: 'split', orientation: 'stacked', children: [root] };
    }
    expect(repairLayout({ ...shown(group('g1', [])), root }, known)).toEqual(
      shown(group('g1', ['files'])),
    );
  });

  it('answers a single empty group, hidden, when no group survives', () => {
    const emptied = shown(split('stacked', group('g4', ['browser']), group('g5', [], null)), {
      maximized: 'g4',
      lastGroupOf: { files: 'g4' },
    });
    const emptySplit = { ...shown(group('g1', [])), root: split('side-by-side') };
    for (const raw of [emptied, emptySplit, ...malformed]) {
      const repaired = repairLayout(raw, known);
      expect(repaired.root).toEqual(defaultLayout().root);
      expect(repaired.visible).toBe(false);
      expect(repaired.maximized).toBeNull();
    }
  });

  it('answers a layout the layout module can act on', () => {
    const repairedToDefault = [...unusable, ...malformed];
    const repairedOtherwise = [
      wellFormed,
      overfull,
      repeats,
      unnamed,
      sameNames,
      maximizedGone,
      maximizedAlone,
    ];
    for (const raw of [...repairedToDefault, ...repairedOtherwise]) {
      const repaired = repairLayout(raw, known);
      expect(() => setVisible(repaired, true)).not.toThrow();
      // Every kind opens, in front on screen, maximized groups included.
      for (const kind of known) {
        const opened = openKind(repaired, kind);
        expect(isInFront(opened, kind), kind).toBe(true);
        expect(opened.visible).toBe(true);
      }
      // Every tab closes, one at a time, until the panel hides with the last.
      let layout = repaired;
      for (let left = tabCount(layout); left > 0; left -= 1) {
        const [first] = groupsOf(layout);
        layout = closeTab(layout, first.id, first.tabs[0]);
        expect(tabCount(layout)).toBe(left - 1);
      }
      expect(layout.visible).toBe(false);
    }
    // Not all of them repair to the default, or this shows little.
    for (const raw of repairedOtherwise) {
      expect(repairLayout(raw, known)).not.toEqual(defaultLayout());
    }
  });
});
