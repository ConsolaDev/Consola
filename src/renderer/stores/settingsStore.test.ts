// src/renderer/stores/settingsStore.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INBOX_FILTER } from '../components/Inbox/inboxFilters';
import {
  sanitizeCollapsedSections,
  sanitizeInboxFilters,
  useSettingsStore,
} from './settingsStore';

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
      sanitizeInboxFilters({ 'ws-1': { repos: ['sympower/flex-portal'], updated: 'week' } })
    ).toEqual({ 'ws-1': { repos: ['sympower/flex-portal'], updated: 'week' } });
  });

  it('fills a partial entry in with the defaults', () => {
    expect(sanitizeInboxFilters({ 'ws-1': {} })).toEqual({
      'ws-1': { repos: [], updated: 'month' },
    });
  });

  it('drops non-string repos and an Updated value it does not know', () => {
    expect(
      sanitizeInboxFilters({ 'ws-1': { repos: ['a/b', 3, null, 'c/d'], updated: 'decade' } })
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
    useSettingsStore.getState().setInboxRepoFilter('ws-1', ['sympower/flex-portal']);
    useSettingsStore.getState().setInboxUpdatedFilter('ws-2', 'any');

    expect(useSettingsStore.getState().inboxFilterFor('ws-1')).toEqual({
      repos: ['sympower/flex-portal'],
      updated: 'month',
    });
    expect(useSettingsStore.getState().inboxFilterFor('ws-2')).toEqual({ repos: [], updated: 'any' });
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

describe('sanitizeCollapsedSections', () => {
  it('answers an empty list for anything that is not an array', () => {
    expect(sanitizeCollapsedSections(undefined)).toEqual([]);
    expect(sanitizeCollapsedSections(null)).toEqual([]);
    expect(sanitizeCollapsedSections('scope-a')).toEqual([]);
    expect(sanitizeCollapsedSections({ 'scope-a': true })).toEqual([]);
  });

  it('keeps a well-formed list as is', () => {
    expect(sanitizeCollapsedSections(['scope-a', 'group-b'])).toEqual(['scope-a', 'group-b']);
  });

  it('drops entries that are not strings', () => {
    expect(sanitizeCollapsedSections(['scope-a', 3, null, {}, 'group-b'])).toEqual([
      'scope-a',
      'group-b',
    ]);
  });

  it('dedupes, so a doubled id still unfolds on one click', () => {
    expect(sanitizeCollapsedSections(['scope-a', 'scope-a'])).toEqual(['scope-a']);
  });
});

describe('sidebar section actions', () => {
  beforeEach(() => {
    useSettingsStore.setState({ collapsedSidebarSections: [] });
  });

  it('starts with everything expanded', () => {
    expect(useSettingsStore.getState().collapsedSidebarSections).toEqual([]);
  });

  it('folds an open section and unfolds a folded one', () => {
    useSettingsStore.getState().toggleSidebarSection('scope-a');
    expect(useSettingsStore.getState().collapsedSidebarSections).toEqual(['scope-a']);

    useSettingsStore.getState().toggleSidebarSection('scope-a');
    expect(useSettingsStore.getState().collapsedSidebarSections).toEqual([]);
  });

  it('holds scopes and groups in one set without confusing them', () => {
    useSettingsStore.getState().toggleSidebarSection('scope-a');
    useSettingsStore.getState().toggleSidebarSection('group-b');
    useSettingsStore.getState().toggleSidebarSection('scope-a');

    expect(useSettingsStore.getState().collapsedSidebarSections).toEqual(['group-b']);
  });

  it('expands a folded section', () => {
    useSettingsStore.getState().toggleSidebarSection('scope-a');
    useSettingsStore.getState().expandSidebarSection('scope-a');

    expect(useSettingsStore.getState().collapsedSidebarSections).toEqual([]);
  });

  // The guard is what keeps activating a session from re-serialising the
  // whole store to localStorage on every navigation.
  it('does not touch the list when the section is already expanded', () => {
    useSettingsStore.getState().toggleSidebarSection('scope-a');
    const before = useSettingsStore.getState().collapsedSidebarSections;

    useSettingsStore.getState().expandSidebarSection('group-b');

    expect(useSettingsStore.getState().collapsedSidebarSections).toBe(before);
  });
});
