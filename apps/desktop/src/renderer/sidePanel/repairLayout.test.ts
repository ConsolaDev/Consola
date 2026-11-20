import { describe, expect, it } from 'vitest';
import {
  defaultLayout,
  type LayoutNode,
  NEW_TAB,
  openKind,
  type SidePanelLayout,
  type SplitOrientation,
  setVisible,
} from './layout';
import { repairLayout } from './repairLayout';

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

describe('repairLayout', () => {
  it('answers the default for anything unusable', () => {
    for (const raw of unusable) expect(repairLayout(raw, known)).toEqual(defaultLayout());
  });

  it('keeps a well-formed split as it is', () => {
    const stored = shown(
      split(
        'stacked',
        group('g1', ['changes', NEW_TAB], NEW_TAB),
        group('g2', ['files', 'terminal'], 'terminal'),
      ),
      { maximized: 'g2', lastGroupOf: { changes: 'g2' } },
    );
    expect(repairLayout(stored, known)).toEqual(stored);
    const lone = { ...shown(group('g1', ['files'])), visible: false };
    expect(repairLayout(lone, known)).toEqual(lone);
  });

  it('drops a kind this build does not know', () => {
    const stored = shown(group('g1', ['changes', 'browser'], 'browser'));
    expect(repairLayout(stored, known)).toEqual(shown(group('g1', ['changes'], 'changes')));
  });

  it('keeps one tab per kind and one placeholder per group', () => {
    const stored = shown(
      split(
        'side-by-side',
        group('g1', ['changes', NEW_TAB, 'changes', NEW_TAB, 'files']),
        group('g2', [NEW_TAB, 'files', 'terminal', NEW_TAB], 'files'),
      ),
    );
    expect(repairLayout(stored, known)).toEqual(
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
    const stored = shown(
      split(
        'stacked',
        split('side-by-side', group('g1', ['changes']), group('g2', ['files'])),
        group('g3', ['terminal']),
      ),
    );
    expect(repairLayout(stored, known)).toEqual(
      shown(split('stacked', group('g1', ['changes']), group('g2', ['files']))),
    );

    const unoriented = {
      ...stored,
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
    const gone = shown(split('stacked', group('g1', ['changes']), group('g2', ['files'])), {
      maximized: 'g3',
    });
    expect(repairLayout(gone, known)).toEqual({ ...gone, maximized: null });

    const alone = shown(split('stacked', group('g1', ['changes']), group('g2', ['browser'])), {
      maximized: 'g1',
    });
    expect(repairLayout(alone, known)).toEqual(shown(group('g1', ['changes'])));
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
    const missing = shown(
      split(
        'stacked',
        { type: 'group', tabs: ['changes'], active: 'changes' } as unknown as LayoutNode,
        group('g1', ['files']),
      ),
    );
    expect(repairLayout(missing, known)).toEqual(
      shown(split('stacked', group('g2', ['changes']), group('g1', ['files']))),
    );

    const repeated = shown(split('stacked', group('g1', ['changes']), group('g1', ['files'])));
    expect(repairLayout(repeated, known)).toEqual(
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
    for (const raw of [...unusable, ...malformed]) {
      const repaired = repairLayout(raw, known);
      expect(() => openKind(repaired, 'changes')).not.toThrow();
      expect(() => setVisible(repaired, true)).not.toThrow();
    }
  });
});
