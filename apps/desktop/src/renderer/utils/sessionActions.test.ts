import { describe, expect, it, vi, beforeEach } from 'vitest';

// sessionActions reaches through windowBridge, which reads `window.windowAPI`
// — a global this suite's Node environment doesn't have. Mocking the module
// (hoisted by Vitest above the imports below) lets it load without a DOM, the
// same workaround navigationStore.test.ts uses.
vi.mock('../services/windowBridge', () => ({
  windowBridge: {
    context: { workspaceId: null, activeSessionId: null, overlay: null },
    activateWorkspace: vi.fn(),
    openWindow: vi.fn(),
    setView: vi.fn(),
    onWorkspaceChanged: vi.fn(() => () => {}),
    onActivateSession: vi.fn(() => () => {}),
  },
}));

import {
  activateSession,
  activateSessionAnywhere,
  chooseScope,
  createQuickSession,
  createSessionAndOpen,
  defaultSessionScopeId,
  openNewSessionDialog,
  revealCreatedScope,
  revealSessionScope,
} from './sessionActions';
import { windowBridge } from '../services/windowBridge';
import { useAutomationsStore } from '../stores/automationsStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useNewSessionDialogStore } from '../stores/newSessionDialogStore';
import { useHomeStore } from '../stores/homeStore';
import { createWorkspaceRecord, createScopeRecord, createSessionRecord } from '../../shared/workspace';

beforeEach(() => {
  vi.restoreAllMocks();
  useNewSessionDialogStore.getState().close();
  vi.mocked(windowBridge.setView).mockClear();
  vi.mocked(windowBridge.activateWorkspace).mockReset();
  useWorkspaceStore.setState({ workspaces: [] });
  useHomeStore.setState({ scopeFilters: {}, draftGroupIds: {} });
  useNavigationStore.setState({
    activeWorkspaceId: null,
    activeSessionId: null,
    overlay: null,
  });
});

describe('session creation', () => {
  function setup() {
    const workspace = createWorkspaceRecord('App', '/app', false, 'default-agent');
    const secondary = createScopeRecord({ name: 'API', path: '/api', isGitRepo: false });
    workspace.scopes.push(secondary);
    useWorkspaceStore.setState({ workspaces: [workspace] });
    useHomeStore.getState().setScopeFilter(workspace.id, secondary.id);
    useNavigationStore.setState({ activeWorkspaceId: workspace.id, activeSessionId: 'existing', overlay: 'inbox' });
    const create = vi.spyOn(useWorkspaceStore.getState(), 'createSession').mockImplementation(async (_id, fields) => ({
      ...fields, id: 'new-session', claudeSessionId: 'cli-id', hasStarted: false,
      kind: 'interactive', createdAt: 0, lastActiveAt: 0,
    }));
    return { workspace, secondary, create };
  }

  it('starts immediately with the default agent, selected scope, no model override and no stale group', async () => {
    const { workspace, secondary, create } = setup();
    useHomeStore.getState().setDraftGroup(workspace.id, 'old-draft');
    await createQuickSession(workspace.id);
    expect(create).toHaveBeenCalledWith(workspace.id, expect.objectContaining({
      harnessId: 'default-agent', scopeId: secondary.id, model: undefined, groupId: undefined,
    }), undefined);
    expect(useNavigationStore.getState()).toMatchObject({ activeSessionId: 'new-session', overlay: null });
    expect(useNewSessionDialogStore.getState().destination).toBeNull();
  });

  it('honors explicit scope and group destinations for section buttons', async () => {
    const { workspace, create } = setup();
    await createQuickSession(workspace.id, { scopeId: workspace.scopes[0].id, groupId: 'chosen-group' });
    expect(create).toHaveBeenCalledWith(workspace.id, expect.objectContaining({
      scopeId: workspace.scopes[0].id, groupId: 'chosen-group',
    }), undefined);
  });

  it('opens and cancels options without creating a session or changing the current view and filters', () => {
    const { workspace, secondary, create } = setup();
    openNewSessionDialog(workspace.id, { groupId: 'chosen-group' });
    expect(useNewSessionDialogStore.getState().destination).toEqual({
      workspaceId: workspace.id, scopeId: secondary.id, groupId: 'chosen-group', error: undefined,
    });
    useNewSessionDialogStore.getState().close();
    expect(create).not.toHaveBeenCalled();
    expect(useNavigationStore.getState()).toMatchObject({ activeSessionId: 'existing', overlay: 'inbox' });
    expect(useHomeStore.getState().scopeFilters[workspace.id]).toBe(secondary.id);
    expect(windowBridge.setView).not.toHaveBeenCalled();
  });

  it('forwards configured launch options and checkout', async () => {
    const { workspace, create } = setup();
    const checkout = { mode: 'new' as const, baseRef: 'main', branchName: 'feature' };
    await createSessionAndOpen(workspace.id, { harnessId: 'other-agent', model: 'chosen-model', checkout });
    expect(create).toHaveBeenCalledWith(workspace.id, expect.objectContaining({ harnessId: 'other-agent', model: 'chosen-model' }), checkout);
  });

  it('falls back to the primary scope when a selected scope was removed', async () => {
    const { workspace, create } = setup();
    useHomeStore.getState().setScopeFilter(workspace.id, 'removed');
    await createQuickSession(workspace.id);
    expect(create.mock.calls[0][1].scopeId).toBe(workspace.scopes[0].id);
  });

  it('under All, + starts in the open session\'s scope', async () => {
    const { workspace, secondary, create } = setup();
    const open = createSessionRecord({
      name: 'Open', workspaceId: workspace.id, instanceId: 'open', harnessId: 'default-agent',
      model: undefined, scopeId: secondary.id,
    });
    workspace.sessions.push(open);
    useHomeStore.getState().setScopeFilter(workspace.id, null);
    useNavigationStore.setState({ activeSessionId: open.id, overlay: null });
    await createQuickSession(workspace.id);
    expect(create).toHaveBeenCalledWith(workspace.id, expect.objectContaining({ scopeId: secondary.id }), undefined);
  });

  it('under All with the Assistant open, + starts in the primary scope', async () => {
    const { workspace, secondary, create } = setup();
    const assistant = createSessionRecord({
      name: 'Assistant', workspaceId: workspace.id, instanceId: 'assistant', harnessId: 'default-agent',
      model: undefined, scopeId: secondary.id, kind: 'assistant',
    });
    workspace.sessions.push(assistant);
    useHomeStore.getState().setScopeFilter(workspace.id, null);
    useNavigationStore.setState({ activeSessionId: assistant.id, overlay: null });
    await createQuickSession(workspace.id);
    expect(create).toHaveBeenCalledWith(workspace.id, expect.objectContaining({ scopeId: workspace.scopes[0].id }), undefined);
  });

  it('does not create or steal a workspace held by another window', async () => {
    const { workspace, create } = setup();
    useNavigationStore.setState({ activeWorkspaceId: 'other-workspace' });
    vi.mocked(windowBridge.activateWorkspace).mockResolvedValue({ verdict: 'focused-elsewhere' });
    await createQuickSession(workspace.id);
    expect(create).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().activeWorkspaceId).toBe('other-workspace');
  });

  it('shows a recoverable error without replacing the current session', async () => {
    const { workspace, create } = setup();
    create.mockRejectedValue(new Error('Agent unavailable'));
    await createQuickSession(workspace.id);
    expect(useNewSessionDialogStore.getState().destination?.error).toBe('Agent unavailable');
    expect(useNavigationStore.getState().activeSessionId).toBe('existing');
  });

  it('coalesces rapid quick-create requests and does not navigate back after a workspace switch', async () => {
    const { workspace, create } = setup();
    const session = (await create.getMockImplementation()!(workspace.id, {
      name: 'New Session', workspaceId: workspace.id, instanceId: 'instance', harnessId: 'default-agent', scopeId: workspace.scopes[0].id,
    }))!;
    let resolve!: (value: typeof session) => void;
    create.mockImplementation(() => new Promise(done => { resolve = done; }));
    const first = createQuickSession(workspace.id);
    await createQuickSession(workspace.id);
    expect(create).toHaveBeenCalledTimes(1);
    useNavigationStore.setState({ activeWorkspaceId: 'other-workspace' });
    resolve(session);
    await first;
    expect(useNavigationStore.getState().activeWorkspaceId).toBe('other-workspace');
    expect(windowBridge.setView).not.toHaveBeenCalled();
  });
});

describe('activateSession', () => {
  it('selects the session and reports it in one step', () => {
    activateSession('workspace-1', 'session-3');

    expect(useNavigationStore.getState().activeWorkspaceId).toBe('workspace-1');
    expect(useNavigationStore.getState().activeSessionId).toBe('session-3');
    expect(windowBridge.setView).toHaveBeenCalledWith('workspace-1', {
      activeSessionId: 'session-3',
      overlay: null,
    });
  });

  it('closes the Inbox, since a session was chosen over it', () => {
    useNavigationStore.setState({ overlay: 'inbox' });

    activateSession('workspace-1', 'session-3');

    expect(useNavigationStore.getState().overlay).toBe(null);
    expect(windowBridge.setView).toHaveBeenCalledWith('workspace-1', {
      activeSessionId: 'session-3',
      overlay: null,
    });
  });
});

describe('activateSessionAnywhere', () => {
  it('closes the Automations side panel when it moves the window to another workspace', async () => {
    useNavigationStore.setState({ activeWorkspaceId: 'workspace-1' });
    useAutomationsStore.setState({ panel: { kind: 'run', runId: 'run-1' } });
    vi.mocked(windowBridge.activateWorkspace).mockResolvedValue({
      verdict: 'took',
      view: { activeSessionId: null, overlay: null },
    });

    await activateSessionAnywhere('workspace-2', 'session-3');

    expect(useNavigationStore.getState().activeWorkspaceId).toBe('workspace-2');
    expect(useAutomationsStore.getState().panel).toBeNull();
  });

  it('keeps it for a session in the workspace already shown', async () => {
    useNavigationStore.setState({ activeWorkspaceId: 'workspace-1' });
    useAutomationsStore.setState({ panel: { kind: 'run', runId: 'run-1' } });

    await activateSessionAnywhere('workspace-1', 'session-3');

    expect(useAutomationsStore.getState().panel).toEqual({ kind: 'run', runId: 'run-1' });
  });
});

// A workspace with two scopes and one open session, filtered to that session's scope.
function openSessionSetup(open: { scope: 'root' | 'api'; kind?: 'interactive' | 'assistant' }) {
  const workspace = createWorkspaceRecord('App', '/app', false, 'default-agent');
  const root = workspace.scopes[0];
  const api = createScopeRecord({ name: 'API', path: '/api', isGitRepo: false });
  workspace.scopes.push(api);
  const session = createSessionRecord({
    name: 'Open session', workspaceId: workspace.id, instanceId: 'instance', harnessId: 'default-agent',
    model: undefined, scopeId: open.scope === 'root' ? root.id : api.id, kind: open.kind,
  });
  workspace.sessions.push(session);
  useWorkspaceStore.setState({ workspaces: [workspace] });
  useHomeStore.getState().setScopeFilter(workspace.id, session.scopeId);
  useNavigationStore.setState({ activeWorkspaceId: workspace.id, activeSessionId: session.id, overlay: null });
  return { workspace, root, api, session };
}

describe('chooseScope', () => {
  const setup = openSessionSetup;

  it('leaves a session from another scope for the new scope\'s composer, launching nothing', () => {
    const { workspace, api } = setup({ scope: 'root' });
    chooseScope(workspace.id, api.id);
    expect(useHomeStore.getState().scopeFilters[workspace.id]).toBe(api.id);
    expect(useNavigationStore.getState().activeSessionId).toBeNull();
    // Written through, so returning to the workspace lands on the composer too.
    expect(windowBridge.setView).toHaveBeenCalledWith(workspace.id, { activeSessionId: null, overlay: null });
  });

  it('keeps a session open when it already belongs to the chosen scope', () => {
    const { workspace, root, session } = setup({ scope: 'root' });
    chooseScope(workspace.id, root.id);
    expect(useNavigationStore.getState().activeSessionId).toBe(session.id);
    expect(windowBridge.setView).not.toHaveBeenCalled();
  });

  it('keeps the Assistant open: it belongs to no scope, so no scope contradicts it', () => {
    const { workspace, api, session } = setup({ scope: 'root', kind: 'assistant' });
    chooseScope(workspace.id, api.id);
    expect(useHomeStore.getState().scopeFilters[workspace.id]).toBe(api.id);
    expect(useNavigationStore.getState().activeSessionId).toBe(session.id);
  });

  it('only filters while the Inbox covers the pane', () => {
    const { workspace, api, session } = setup({ scope: 'root' });
    useNavigationStore.setState({ overlay: 'inbox' });
    chooseScope(workspace.id, api.id);
    expect(useHomeStore.getState().scopeFilters[workspace.id]).toBe(api.id);
    expect(useNavigationStore.getState().activeSessionId).toBe(session.id);
    expect(useNavigationStore.getState().overlay).toBe('inbox');
  });

  it('returns to All without navigating', () => {
    const { workspace, session } = setup({ scope: 'root' });
    chooseScope(workspace.id, null);
    expect(workspace.id in useHomeStore.getState().scopeFilters).toBe(false);
    expect(useNavigationStore.getState().activeSessionId).toBe(session.id);
    expect(windowBridge.setView).not.toHaveBeenCalled();
  });
});

describe('revealSessionScope', () => {
  it('moves the filter to an opened session from another scope', () => {
    const { workspace, root, api, session } = openSessionSetup({ scope: 'api' });
    useHomeStore.getState().setScopeFilter(workspace.id, root.id);
    revealSessionScope(workspace.id, session.id);
    expect(useHomeStore.getState().scopeFilters[workspace.id]).toBe(api.id);
  });

  it('leaves All alone', () => {
    const { workspace, session } = openSessionSetup({ scope: 'api' });
    useHomeStore.getState().setScopeFilter(workspace.id, null);
    revealSessionScope(workspace.id, session.id);
    expect(workspace.id in useHomeStore.getState().scopeFilters).toBe(false);
  });

  it('never filters to the Assistant\'s scope', () => {
    const { workspace, root, session } = openSessionSetup({ scope: 'api', kind: 'assistant' });
    useHomeStore.getState().setScopeFilter(workspace.id, root.id);
    revealSessionScope(workspace.id, session.id);
    expect(useHomeStore.getState().scopeFilters[workspace.id]).toBe(root.id);
  });

  it('treats a filter whose scope was removed as All, so a click never narrows the list', () => {
    const { workspace, session } = openSessionSetup({ scope: 'api' });
    useHomeStore.getState().setScopeFilter(workspace.id, 'removed-scope');
    revealSessionScope(workspace.id, session.id);
    expect(useHomeStore.getState().scopeFilters[workspace.id]).not.toBe(session.scopeId);
  });

  it('keeps a filter that already shows the session', () => {
    const { workspace, root, session } = openSessionSetup({ scope: 'root' });
    revealSessionScope(workspace.id, session.id);
    expect(useHomeStore.getState().scopeFilters[workspace.id]).toBe(root.id);
  });
});

describe('defaultSessionScopeId', () => {
  it('under All, follows the open session like +', () => {
    const { workspace, api } = openSessionSetup({ scope: 'api' });
    useHomeStore.getState().setScopeFilter(workspace.id, null);
    expect(defaultSessionScopeId(workspace.id)).toBe(api.id);
  });

  it('prefers the filter', () => {
    const { workspace, root } = openSessionSetup({ scope: 'api' });
    useHomeStore.getState().setScopeFilter(workspace.id, root.id);
    expect(defaultSessionScopeId(workspace.id)).toBe(root.id);
  });
});

describe('revealCreatedScope', () => {
  it('widens a filter on another scope to All without navigating', () => {
    const { workspace, root, api, session } = openSessionSetup({ scope: 'api' });
    revealCreatedScope(workspace.id, root.id);
    expect(workspace.id in useHomeStore.getState().scopeFilters).toBe(false);
    expect(useNavigationStore.getState().activeSessionId).toBe(session.id);
    expect(api.id).not.toBe(root.id);
  });

  it('keeps a filter that already shows the new work', () => {
    const { workspace, api } = openSessionSetup({ scope: 'api' });
    revealCreatedScope(workspace.id, api.id);
    expect(useHomeStore.getState().scopeFilters[workspace.id]).toBe(api.id);
  });
});
