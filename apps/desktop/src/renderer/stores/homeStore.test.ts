import { beforeEach, describe, expect, it } from 'vitest';
import { filteredScope, hasScopeChoice, newSessionScope, useHomeStore } from './homeStore';
import { createScopeRecord, createSessionRecord, createWorkspaceRecord } from '../../shared/workspace';

function setup() {
  const workspace = createWorkspaceRecord('App', '/app', false, 'default-agent');
  const root = workspace.scopes[0];
  const api = createScopeRecord({ name: 'API', path: '/app/api', isGitRepo: false });
  workspace.scopes.push(api);
  const inApi = createSessionRecord({
    name: 'In API', workspaceId: workspace.id, instanceId: 'in-api', harnessId: 'default-agent',
    model: undefined, scopeId: api.id,
  });
  // The Assistant's record still carries a scope, but it runs none of them.
  const assistant = createSessionRecord({
    name: 'Assistant', workspaceId: workspace.id, instanceId: 'assistant', harnessId: 'default-agent',
    model: undefined, scopeId: api.id, kind: 'assistant',
  });
  workspace.sessions.push(inApi, assistant);
  return { workspace, root, api, inApi, assistant };
}

beforeEach(() => {
  useHomeStore.setState({ scopeFilters: {}, draftGroupIds: {} });
});

describe('setScopeFilter', () => {
  it('stores a filter and null returns to All', () => {
    const { api } = setup();
    useHomeStore.getState().setScopeFilter('ws', api.id);
    expect(useHomeStore.getState().scopeFilters.ws).toBe(api.id);
    useHomeStore.getState().setScopeFilter('ws', null);
    expect('ws' in useHomeStore.getState().scopeFilters).toBe(false);
  });
});

describe('filteredScope', () => {
  it('is All (undefined) with no filter', () => {
    const { workspace } = setup();
    expect(filteredScope(workspace, undefined)).toBeUndefined();
  });

  it('is the filtered scope while it exists', () => {
    const { workspace, api } = setup();
    expect(filteredScope(workspace, api.id)).toBe(api);
  });

  it('falls back to All when the filtered scope was removed', () => {
    const { workspace } = setup();
    expect(filteredScope(workspace, 'removed')).toBeUndefined();
  });
});

describe('newSessionScope', () => {
  it('prefers the given scope', () => {
    const { workspace, api } = setup();
    expect(newSessionScope(workspace, api.id, null)).toBe(api);
  });

  it('follows the open session when the preferred scope was removed', () => {
    const { workspace, api, inApi } = setup();
    expect(newSessionScope(workspace, 'removed', inApi.id)).toBe(api);
  });

  it('never inherits the Assistant\'s scope', () => {
    const { workspace, root, assistant } = setup();
    expect(newSessionScope(workspace, undefined, assistant.id)).toBe(root);
  });

  it('falls back to the primary scope with nothing open', () => {
    const { workspace, root } = setup();
    expect(newSessionScope(workspace, undefined, null)).toBe(root);
  });

  it('has nowhere to start in a workspace without scopes', () => {
    const { workspace } = setup();
    expect(newSessionScope({ ...workspace, scopes: [] }, undefined, null)).toBeUndefined();
  });
});

describe('hasScopeChoice', () => {
  it('needs two or more scopes', () => {
    const { workspace, root } = setup();
    expect(hasScopeChoice({ ...workspace, scopes: [root] })).toBe(false);
    expect(hasScopeChoice(workspace)).toBe(true);
  });
});
