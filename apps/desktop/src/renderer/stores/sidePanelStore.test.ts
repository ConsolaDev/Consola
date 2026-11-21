import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Node runs these with web storage off (vitest.config.ts), so the store would
// persist nowhere. A Map stands in, as in automationsStore.test.ts, so what
// the store writes can be read back.
const { storage } = vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  return { storage: data };
});

import {
  defaultLayout,
  groupsOf,
  isInFront,
  NEW_TAB,
  type SidePanelLayout,
} from '../sidePanel/layout';
import { repairLayout } from '../sidePanel/repairLayout';
import { DAY_MS, rankShortcutKinds, sanitizeUsage } from '../sidePanel/usage';
import { TAB_KIND_IDS, type TabKindId } from '../sidePanel/tabKinds';
import {
  FOCUS_REQUEST_TTL_MS,
  mergeSidePanelState,
  partializeSidePanel,
  SIDE_PANEL_STORAGE_KEY,
  useSidePanelStore,
} from './sidePanelStore';

const NOW = Date.UTC(2026, 10, 20, 12);

const state = () => useSidePanelStore.getState();
const usesOf = (kind: TabKindId) => state().uses[kind]?.length ?? 0;
const totalUses = () => Object.values(state().uses).reduce((sum, times) => sum + times.length, 0);
const firstGroupId = () => groupsOf(state().layout)[0].id;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useSidePanelStore.setState(useSidePanelStore.getInitialState(), true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mergeSidePanelState', () => {
  const current = () => useSidePanelStore.getInitialState();

  it('starts remembering, with the default layout and no uses, when nothing is stored', () => {
    const merged = mergeSidePanelState(undefined, current(), NOW);
    expect(merged.rememberLayout).toBe(true);
    expect(merged.layout).toEqual(defaultLayout());
    expect(merged.uses).toEqual({});
    expect(merged.focusRequest).toBeNull();
  });

  it('gives the defaults for junk, and never throws', () => {
    for (const junk of [null, 'side panel', 42, [], { rememberLayout: 'yes', uses: 'many' }]) {
      const merged = mergeSidePanelState(junk, current(), NOW);
      expect(merged.rememberLayout).toBe(true);
      expect(merged.layout).toEqual(defaultLayout());
      expect(merged.uses).toEqual({});
    }
  });

  // A kind this build does not know, and the same kind twice: a profile from another build.
  const stored = {
    version: 1,
    visible: true,
    root: {
      type: 'split',
      orientation: 'stacked',
      children: [
        { type: 'group', id: 'g1', tabs: ['browser', 'changes'], active: 'browser' },
        { type: 'group', id: 'g2', tabs: ['changes', NEW_TAB], active: 'changes' },
      ],
    },
    maximized: null,
    lastGroupOf: {},
  };

  it('repairs a saved layout while remembering', () => {
    const merged = mergeSidePanelState(
      { layout: stored, uses: {}, rememberLayout: true },
      current(),
      NOW,
    );
    expect(merged.rememberLayout).toBe(true);
    expect(merged.layout).toEqual(repairLayout(stored, TAB_KIND_IDS));
    expect(merged.layout).not.toEqual(defaultLayout());
  });

  it('ignores a saved layout while not remembering', () => {
    const merged = mergeSidePanelState(
      { layout: stored, uses: {}, rememberLayout: false },
      current(),
      NOW,
    );
    expect(merged.rememberLayout).toBe(false);
    expect(merged.layout).toEqual(defaultLayout());
  });

  it('sanitizes the uses', () => {
    const uses = {
      changes: [NOW - 2 * DAY_MS, 'yesterday', NOW + 1_000, NOW - 40 * DAY_MS, NOW - DAY_MS],
      browser: [NOW],
    };
    const merged = mergeSidePanelState({ uses, rememberLayout: true }, current(), NOW);
    expect(merged.uses).toEqual(sanitizeUsage(uses, TAB_KIND_IDS, NOW));
    expect(merged.uses).toEqual({ changes: [NOW - 2 * DAY_MS, NOW - DAY_MS] });
  });

  it('ranks the shortcut kinds from the sanitized uses', () => {
    const uses = { changes: [NOW - DAY_MS, NOW], browser: [NOW, NOW] };
    const merged = mergeSidePanelState({ uses, rememberLayout: true }, current(), NOW);
    expect(merged.shortcutKinds).toEqual(
      rankShortcutKinds(sanitizeUsage(uses, TAB_KIND_IDS, NOW), TAB_KIND_IDS, NOW),
    );
  });

  it('starts, before anything is read, with the kinds ranked from no uses', () => {
    expect(current().shortcutKinds).toEqual(rankShortcutKinds({}, TAB_KIND_IDS, NOW));
  });
});

describe('partializeSidePanel', () => {
  it('writes the layout only while remembering, and the uses and setting always', () => {
    state().openKind('changes');
    const remembering = partializeSidePanel(state());
    expect(remembering).toEqual({
      layout: state().layout,
      uses: state().uses,
      rememberLayout: true,
    });

    state().setRememberLayout(false);
    const forgetting = partializeSidePanel(state());
    expect(forgetting).toEqual({ uses: state().uses, rememberLayout: false });
    expect('layout' in forgetting).toBe(false);
  });
});

describe('counts what the person opens, and nothing else', () => {
  it('counts openKind, and asks for focus', () => {
    state().openKind('changes');
    expect(usesOf('changes')).toBe(1);
    expect(state().focusRequest?.kind).toBe('changes');
  });

  it('counts a shortcut that opens, not one that hides', () => {
    state().pressShortcut('changes');
    expect(usesOf('changes')).toBe(1);
    expect(state().focusRequest?.kind).toBe('changes');
    expect(state().layout.visible).toBe(true);

    state().pressShortcut('changes');
    expect(state().layout.visible).toBe(false);
    expect(usesOf('changes')).toBe(1);
  });

  it('counts choosing a kind in the placeholder', () => {
    state().addPlaceholder(firstGroupId());
    expect(totalUses()).toBe(0);
    expect(state().focusRequest?.kind).toBe(NEW_TAB);

    state().choosePlaceholder(firstGroupId(), 'changes');
    expect(usesOf('changes')).toBe(1);
    expect(state().focusRequest?.kind).toBe('changes');
  });

  it('counts bringing a kind to the front, but not the tab already there or the placeholder', () => {
    state().openKind('changes');
    state().addPlaceholder(firstGroupId());
    state().bringToFront(firstGroupId(), NEW_TAB);
    expect(usesOf('changes')).toBe(1);

    state().bringToFront(firstGroupId(), 'changes');
    expect(usesOf('changes')).toBe(2);

    state().bringToFront(firstGroupId(), 'changes');
    expect(usesOf('changes')).toBe(2);
  });

  it('counts nothing, and asks for no focus, for openKind on a kind already in front on screen', () => {
    state().openKind('changes');
    state().takeFocusRequest('changes');

    state().openKind('changes');
    expect(usesOf('changes')).toBe(1);
    // Nothing mounts, so a request here would wait for a later mount to take it.
    expect(state().focusRequest).toBeNull();
  });

  it('counts openKind on a kind behind another tab, once, and asks for focus', () => {
    state().openKind('changes');
    state().addPlaceholder(firstGroupId());
    state().takeFocusRequest('changes');

    state().openKind('changes');
    expect(usesOf('changes')).toBe(2);
    expect(state().focusRequest?.kind).toBe('changes');
  });

  it('counts openKind on a kind in a hidden panel, once, and asks for focus', () => {
    state().openKind('changes');
    state().setVisible(false);
    state().takeFocusRequest('changes');

    state().openKind('changes');
    expect(state().layout.visible).toBe(true);
    expect(usesOf('changes')).toBe(2);
    expect(state().focusRequest?.kind).toBe('changes');
  });

  it('counts openKind on a kind in a group Maximize hides, once, and asks for focus', () => {
    state().openKind('changes');
    state().addPlaceholder(firstGroupId());
    state().splitWithTab(firstGroupId(), 'changes', 'right');
    state().toggleMaximize(firstGroupId());
    state().takeFocusRequest('changes');

    state().openKind('changes');
    expect(state().layout.maximized).toBeNull();
    expect(usesOf('changes')).toBe(2);
    expect(state().focusRequest?.kind).toBe('changes');
  });

  it('counts nothing for bringToFront while the panel is hidden, though the tab is fronted', () => {
    state().openKind('changes');
    state().addPlaceholder(firstGroupId());
    state().setVisible(false);
    state().takeFocusRequest(NEW_TAB);

    state().bringToFront(firstGroupId(), 'changes');
    expect(groupsOf(state().layout)[0].active).toBe('changes');
    expect(usesOf('changes')).toBe(1);
    expect(state().focusRequest).toBeNull();
  });

  it('counts nothing for choosing, in a placeholder, a kind in front in the other group', () => {
    state().openKind('changes');
    state().addPlaceholder(firstGroupId());
    state().splitWithTab(firstGroupId(), 'changes', 'right');
    const [placeholderGroup, changesGroup] = groupsOf(state().layout);
    expect(placeholderGroup.active).toBe(NEW_TAB);
    expect(changesGroup.active).toBe('changes');
    state().takeFocusRequest(NEW_TAB);

    state().choosePlaceholder(placeholderGroup.id, 'changes');
    expect(groupsOf(state().layout)).toHaveLength(1);
    expect(usesOf('changes')).toBe(1);
    expect(state().focusRequest).toBeNull();
  });

  it('counts none of closing, moving, splitting, maximizing or showing', () => {
    state().openKind('changes');
    state().addPlaceholder(firstGroupId());
    state().bringToFront(firstGroupId(), 'changes');
    const counted = totalUses();
    state().takeFocusRequest('changes');

    state().splitWithTab(firstGroupId(), 'changes', 'right');
    const [placeholderGroup, changesGroup] = groupsOf(state().layout);
    expect(changesGroup.tabs).toEqual(['changes']);
    state().toggleMaximize(changesGroup.id);
    expect(state().layout.maximized).toBe(changesGroup.id);
    state().toggleMaximize(changesGroup.id);
    state().moveTab('changes', placeholderGroup.id, 0);
    expect(groupsOf(state().layout)).toHaveLength(1);
    state().setVisible(false);
    state().setVisible(true);
    state().toggleVisible();
    state().closeTab(firstGroupId(), 'changes');
    state().closeGroup(firstGroupId());

    expect(totalUses()).toBe(counted);
    expect(state().focusRequest).toBeNull();
  });
});

describe('the shortcut set does not change while the app runs', () => {
  it('keeps the same set through any number of uses', () => {
    const before = state().shortcutKinds;
    for (let i = 0; i < 20; i += 1) {
      state().openKind('changes');
      state().closeTab(firstGroupId(), 'changes');
    }
    expect(usesOf('changes')).toBe(20);
    expect(state().shortcutKinds).toBe(before);
  });
});

describe('the "+" list asks for focus only when the person opens it', () => {
  it('asks when "+" opens the placeholder, and counts no use', () => {
    state().openKind('changes');
    state().takeFocusRequest('changes');
    const counted = totalUses();

    state().addPlaceholder(firstGroupId());
    expect(state().focusRequest).toEqual({ kind: NEW_TAB, at: NOW });
    expect(totalUses()).toBe(counted);
  });

  it('asks when "+" fronts a placeholder behind another tab', () => {
    state().addPlaceholder(firstGroupId());
    state().choosePlaceholder(firstGroupId(), 'changes');
    state().addPlaceholder(firstGroupId());
    state().bringToFront(firstGroupId(), 'changes');
    state().takeFocusRequest('changes');

    state().addPlaceholder(firstGroupId());
    expect(state().focusRequest?.kind).toBe(NEW_TAB);
  });

  it('does not ask when "+" finds the list already in front, which mounts nothing', () => {
    state().addPlaceholder(firstGroupId());
    state().takeFocusRequest(NEW_TAB);

    state().addPlaceholder(firstGroupId());
    expect(state().focusRequest).toBeNull();
  });

  it('asks when showing an empty panel adds the placeholder', () => {
    state().setVisible(true);
    expect(groupsOf(state().layout)[0].active).toBe(NEW_TAB);
    expect(state().focusRequest).toEqual({ kind: NEW_TAB, at: NOW });
    expect(totalUses()).toBe(0);
  });

  it('asks when toggling shows an empty panel, as the header button and its chord do', () => {
    state().toggleVisible();
    expect(state().layout.visible).toBe(true);
    expect(state().focusRequest?.kind).toBe(NEW_TAB);
  });

  it('asks when showing a hidden panel whose front tab is the placeholder', () => {
    state().openKind('changes');
    state().addPlaceholder(firstGroupId());
    state().setVisible(false);
    state().takeFocusRequest(NEW_TAB);
    const counted = totalUses();

    state().toggleVisible();
    expect(isInFront(state().layout, NEW_TAB)).toBe(true);
    expect(state().focusRequest).toEqual({ kind: NEW_TAB, at: NOW });
    expect(totalUses()).toBe(counted);
  });

  it('asks nothing, and counts nothing, when showing a hidden panel whose front tab is a kind', () => {
    state().openKind('changes');
    state().setVisible(false);
    state().takeFocusRequest('changes');

    state().setVisible(true);
    expect(isInFront(state().layout, 'changes')).toBe(true);
    expect(usesOf('changes')).toBe(1);
    expect(state().focusRequest).toBeNull();
  });

  it('asks when its tab is clicked while behind another tab', () => {
    state().addPlaceholder(firstGroupId());
    state().choosePlaceholder(firstGroupId(), 'changes');
    state().addPlaceholder(firstGroupId());
    state().bringToFront(firstGroupId(), 'changes');
    state().takeFocusRequest('changes');
    const counted = totalUses();

    state().bringToFront(firstGroupId(), NEW_TAB);
    expect(state().focusRequest).toEqual({ kind: NEW_TAB, at: NOW });
    expect(totalUses()).toBe(counted);
  });

  it('does not ask when its tab is clicked while already in front on screen', () => {
    state().addPlaceholder(firstGroupId());
    state().takeFocusRequest(NEW_TAB);

    state().bringToFront(firstGroupId(), NEW_TAB);
    expect(state().focusRequest).toBeNull();
  });

  it('does not ask when hiding', () => {
    state().setVisible(true);
    state().takeFocusRequest(NEW_TAB);
    state().toggleVisible();
    expect(state().layout.visible).toBe(false);
    expect(state().focusRequest).toBeNull();
  });

  it('does not ask for a layout restored with the placeholder in front', async () => {
    storage.set(
      SIDE_PANEL_STORAGE_KEY,
      JSON.stringify({
        state: {
          layout: {
            ...defaultLayout(),
            visible: true,
            root: { type: 'group', id: 'g1', tabs: ['changes', NEW_TAB], active: NEW_TAB },
          },
          uses: {},
          rememberLayout: true,
        },
        version: 0,
      }),
    );
    await useSidePanelStore.persist.rehydrate();
    expect(isInFront(state().layout, NEW_TAB)).toBe(true);
    expect(state().focusRequest).toBeNull();
    expect(state().takeFocusRequest(NEW_TAB)).toBe(false);
  });
});

describe('takeFocusRequest', () => {
  it('is true once for the requested kind, then false', () => {
    state().openKind('changes');
    expect(state().takeFocusRequest('changes')).toBe(true);
    expect(state().takeFocusRequest('changes')).toBe(false);
    expect(state().focusRequest).toBeNull();
  });

  it('is false for another kind, which leaves the request in place', () => {
    useSidePanelStore.setState({ focusRequest: { kind: 'changes', at: NOW } });
    const other = 'browser' as TabKindId; // stands in for a second kind, whatever the registry holds
    expect(state().takeFocusRequest(other)).toBe(false);
    expect(state().focusRequest).toEqual({ kind: 'changes', at: NOW });
    expect(state().takeFocusRequest('changes')).toBe(true);
  });

  it('is true once for the placeholder, then false', () => {
    state().addPlaceholder(firstGroupId());
    expect(state().takeFocusRequest(NEW_TAB)).toBe(true);
    expect(state().takeFocusRequest(NEW_TAB)).toBe(false);
    expect(state().focusRequest).toBeNull();
  });

  it('never lets a kind’s request and the placeholder’s answer for each other', () => {
    state().openKind('changes');
    expect(state().takeFocusRequest(NEW_TAB)).toBe(false);
    expect(state().focusRequest?.kind).toBe('changes');

    state().addPlaceholder(firstGroupId());
    expect(state().takeFocusRequest('changes')).toBe(false);
    expect(state().focusRequest?.kind).toBe(NEW_TAB);
    expect(state().takeFocusRequest(NEW_TAB)).toBe(true);
  });

  it('is true just inside the time to live', () => {
    state().openKind('changes');
    vi.setSystemTime(NOW + FOCUS_REQUEST_TTL_MS - 1);
    expect(state().takeFocusRequest('changes')).toBe(true);
  });

  it('is false once the time to live has passed', () => {
    state().openKind('changes');
    vi.setSystemTime(NOW + FOCUS_REQUEST_TTL_MS);
    expect(state().takeFocusRequest('changes')).toBe(false);
    expect(state().focusRequest).toBeNull();
  });

  it('is false when nothing was asked for, as after a restored layout', () => {
    expect(state().focusRequest).toBeNull();
    expect(state().takeFocusRequest('changes')).toBe(false);
  });
});

describe('turning remembering off keeps the arrangement in memory', () => {
  it('leaves the layout as it is, and stops writing it', () => {
    state().openKind('changes');
    state().addPlaceholder(firstGroupId());
    const arranged: SidePanelLayout = state().layout;

    state().setRememberLayout(false);
    expect(state().rememberLayout).toBe(false);
    expect(state().layout).toBe(arranged);
    expect(partializeSidePanel(state())).not.toHaveProperty('layout');
  });
});

describe('persistence', () => {
  const written = () => JSON.parse(storage.get(SIDE_PANEL_STORAGE_KEY) ?? 'null');

  it('writes what partializeSidePanel keeps, under its key, at version 0', () => {
    state().openKind('changes');
    expect(written()).toEqual({
      state: { layout: state().layout, uses: state().uses, rememberLayout: true },
      version: 0,
    });

    state().setRememberLayout(false);
    expect(written()).toEqual({ state: { uses: state().uses, rememberLayout: false }, version: 0 });
  });

  it('reads back through mergeSidePanelState', async () => {
    const layout = {
      ...defaultLayout(),
      visible: true,
      root: { type: 'group', id: 'g1', tabs: ['changes', 'browser'], active: 'changes' },
    };
    storage.set(
      SIDE_PANEL_STORAGE_KEY,
      JSON.stringify({
        state: { layout, uses: { changes: [NOW - DAY_MS, NOW + DAY_MS] }, rememberLayout: true },
        version: 0,
      }),
    );
    await useSidePanelStore.persist.rehydrate();
    expect(state().layout).toEqual(repairLayout(layout, TAB_KIND_IDS));
    expect(state().uses).toEqual({ changes: [NOW - DAY_MS] });
    expect(state().rememberLayout).toBe(true);
  });
});
