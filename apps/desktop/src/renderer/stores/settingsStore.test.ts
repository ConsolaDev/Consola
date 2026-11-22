// src/renderer/stores/settingsStore.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Node runs these with web storage off (vitest.config.ts), and without a
// storage the store gets no `persist` API to read its merge from. A Map
// stands in, as in sidePanelStore.test.ts.
vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
});

import { DEFAULT_INBOX_FILTER } from '../components/Inbox/inboxFilters';
import { INFO_SECTION_IDS } from '../infoPanel/sections';
import {
  isInfoSectionOpen,
  isShelfOpen,
  isSidebarDensity,
  sanitizeShelfOpen,
  sanitizeInboxFilters,
  useSettingsStore,
} from './settingsStore';

describe('sidebar model visibility', () => {
  it('shows models by default', () => {
    expect(useSettingsStore.getInitialState().showSidebarModel).toBe(true);
  });
});

describe('sidebar density', () => {
  it('starts on the detailed two-line row', () => {
    expect(useSettingsStore.getInitialState().sidebarDensity).toBe('detailed');
  });

  it('knows only its two densities, so a stale profile falls back', () => {
    expect(isSidebarDensity('detailed')).toBe(true);
    expect(isSidebarDensity('compact')).toBe(true);
    expect(isSidebarDensity('comfortable')).toBe(false);
    expect(isSidebarDensity(undefined)).toBe(false);
    expect(isSidebarDensity(1)).toBe(false);
  });

  it('is written by its setter', () => {
    useSettingsStore.getState().setSidebarDensity('compact');
    expect(useSettingsStore.getState().sidebarDensity).toBe('compact');
    useSettingsStore.getState().setSidebarDensity('detailed');
  });
});

describe('sanitizeInboxFilters', () => {
  it('answers an empty map for anything that is not a plain object', () => {
    expect(sanitizeInboxFilters(undefined)).toEqual({});
    expect(sanitizeInboxFilters(null)).toEqual({});
    expect(sanitizeInboxFilters('filters')).toEqual({});
    expect(sanitizeInboxFilters(42)).toEqual({});
    expect(sanitizeInboxFilters([])).toEqual({});
  });

  it('keeps a well-formed entry as is', () => {
    expect(
      sanitizeInboxFilters({ 'ws-1': { repos: ['sprocket/forum-admin'], updated: 'week' } }),
    ).toEqual({ 'ws-1': { repos: ['sprocket/forum-admin'], updated: 'week' } });
  });

  it('fills a partial entry in with the defaults', () => {
    expect(sanitizeInboxFilters({ 'ws-1': {} })).toEqual({
      'ws-1': { repos: [], updated: 'month' },
    });
  });

  it('drops non-string repos and an Updated value it does not know', () => {
    expect(
      sanitizeInboxFilters({ 'ws-1': { repos: ['a/b', 3, null, 'c/d'], updated: 'decade' } }),
    ).toEqual({ 'ws-1': { repos: ['a/b', 'c/d'], updated: 'month' } });
  });

  it('skips entries that are not objects', () => {
    expect(sanitizeInboxFilters({ 'ws-1': 'nope', 'ws-2': null })).toEqual({});
  });
});

describe('inbox filter actions', () => {
  beforeEach(() => {
    useSettingsStore.setState({ inboxFilters: {} });
  });

  it('answers the shared default for a workspace with nothing saved', () => {
    expect(useSettingsStore.getState().inboxFilterFor('ws-1')).toBe(DEFAULT_INBOX_FILTER);
  });

  it('keeps workspaces apart', () => {
    useSettingsStore.getState().setInboxRepoFilter('ws-1', ['sprocket/forum-admin']);
    useSettingsStore.getState().setInboxUpdatedFilter('ws-2', 'any');

    expect(useSettingsStore.getState().inboxFilterFor('ws-1')).toEqual({
      repos: ['sprocket/forum-admin'],
      updated: 'month',
    });
    expect(useSettingsStore.getState().inboxFilterFor('ws-2')).toEqual({
      repos: [],
      updated: 'any',
    });
  });

  it('replaces the repo list wholesale and leaves Updated alone', () => {
    useSettingsStore.getState().setInboxUpdatedFilter('ws-1', 'quarter');
    useSettingsStore.getState().setInboxRepoFilter('ws-1', ['a/b', 'c/d']);
    useSettingsStore.getState().setInboxRepoFilter('ws-1', ['c/d']);

    expect(useSettingsStore.getState().inboxFilterFor('ws-1')).toEqual({
      repos: ['c/d'],
      updated: 'quarter',
    });
  });

  it('never hands out a mutated default', () => {
    useSettingsStore.getState().setInboxRepoFilter('ws-1', ['a/b']);
    expect(DEFAULT_INBOX_FILTER.repos).toEqual([]);
    expect(useSettingsStore.getState().inboxFilterFor('ws-2')).toBe(DEFAULT_INBOX_FILTER);
  });
});

describe('sidebar shelves', () => {
  it('starts Working and Settled shut and everything else open', () => {
    expect(isShelfOpen({}, 'working')).toBe(false);
    // Settled holds only what was put away, so it starts folded.
    expect(isShelfOpen({}, 'settled')).toBe(false);
    expect(isShelfOpen({}, 'session:some-conductor')).toBe(true);
  });

  it('lets an explicit choice win over the default, both ways', () => {
    expect(isShelfOpen({ working: true }, 'working')).toBe(true);
    expect(isShelfOpen({ 'session:c': false }, 'session:c')).toBe(false);
  });

  it('toggles from the effective state, so one press opens a never-touched Working shelf', () => {
    useSettingsStore.setState({ sidebarShelfOpen: {} });
    useSettingsStore.getState().toggleSidebarShelf('working');
    expect(useSettingsStore.getState().sidebarShelfOpen).toEqual({ working: true });
    useSettingsStore.getState().toggleSidebarShelf('working');
    expect(useSettingsStore.getState().sidebarShelfOpen).toEqual({ working: false });
  });

  it('sets a tree explicitly when told which way', () => {
    useSettingsStore.setState({ sidebarShelfOpen: {} });
    useSettingsStore.getState().toggleSidebarShelf('session:c', true);
    expect(useSettingsStore.getState().sidebarShelfOpen).toEqual({ 'session:c': true });
  });

  it('keeps only booleans from a persisted blob', () => {
    expect(sanitizeShelfOpen({ working: true, a: 'yes', b: 1, c: false })).toEqual({
      working: true,
      c: false,
    });
    expect(sanitizeShelfOpen(null)).toEqual({});
    expect(sanitizeShelfOpen([true])).toEqual({});
  });
});

describe('the Open in favourite', () => {
  it('is no app until one is picked, and the pick is kept', () => {
    expect(useSettingsStore.getInitialState().openInFavourite).toBeNull();
    useSettingsStore.getState().setOpenInFavourite('intellij');
    expect(useSettingsStore.getState().openInFavourite).toBe('intellij');
    const { merge, partialize } = useSettingsStore.persist.getOptions();
    expect(partialize!(useSettingsStore.getState())).toMatchObject({
      openInFavourite: 'intellij',
    });
    const read = (saved: unknown) =>
      (
        merge!(saved, useSettingsStore.getInitialState()) as ReturnType<
          typeof useSettingsStore.getState
        >
      ).openInFavourite;
    expect(read({ openInFavourite: 'vscode' })).toBe('vscode');
    // Anything but an id reads as no pick.
    expect(read({ openInFavourite: 7 })).toBeNull();
    expect(read({ openInFavourite: '' })).toBeNull();
    expect(read(undefined)).toBeNull();
    useSettingsStore.setState({ openInFavourite: null });
  });
});

describe('info panel sections', () => {
  it('section fold state keeps only booleans, and every section starts open', () => {
    for (const id of INFO_SECTION_IDS) expect(isInfoSectionOpen({}, id)).toBe(true);
    expect(isInfoSectionOpen({}, 'branch')).toBe(true);

    useSettingsStore.setState({ infoSectionOpen: {} });
    useSettingsStore.getState().toggleInfoSection('branch');
    expect(useSettingsStore.getState().infoSectionOpen).toEqual({ branch: false });
    expect(isInfoSectionOpen(useSettingsStore.getState().infoSectionOpen, 'branch')).toBe(false);
    expect(isInfoSectionOpen(useSettingsStore.getState().infoSectionOpen, 'environment')).toBe(
      true,
    );
    useSettingsStore.getState().toggleInfoSection('branch');
    expect(isInfoSectionOpen(useSettingsStore.getState().infoSectionOpen, 'branch')).toBe(true);

    // Always written, and read back with anything but a boolean dropped.
    const { merge, partialize } = useSettingsStore.persist.getOptions();
    useSettingsStore.getState().toggleInfoSection('environment');
    expect(partialize!(useSettingsStore.getState())).toMatchObject({
      infoSectionOpen: { branch: true, environment: false },
    });
    const merged = merge!(
      { infoSectionOpen: { environment: false, branch: 'no', 'pull-request': 1 } },
      useSettingsStore.getInitialState(),
    ) as ReturnType<typeof useSettingsStore.getState>;
    expect(merged.infoSectionOpen).toEqual({ environment: false });
    const fresh = merge!(undefined, useSettingsStore.getInitialState()) as ReturnType<
      typeof useSettingsStore.getState
    >;
    expect(fresh.infoSectionOpen).toEqual({});
  });
});
