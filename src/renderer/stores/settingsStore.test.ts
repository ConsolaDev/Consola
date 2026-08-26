// src/renderer/stores/settingsStore.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INBOX_FILTER } from '../components/Inbox/inboxFilters';
import { sanitizeInboxFilters, useSettingsStore } from './settingsStore';

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
