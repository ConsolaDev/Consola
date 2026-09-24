import { describe, expect, it, vi, beforeEach } from 'vitest';

// sessionActions reaches through windowBridge, which reads `window.windowAPI`
// — a global this suite's Node environment doesn't have. Mocking the module
// (hoisted by Vitest above the imports below) lets it load without a DOM, the
// same workaround navigationStore.test.ts uses.
vi.mock('../services/windowBridge', () => ({
  windowBridge: {
    context: { workspaceId: null, activeSessionId: null, isInboxOpen: false },
    activateWorkspace: vi.fn(),
    openWindow: vi.fn(),
    setView: vi.fn(),
    onWorkspaceChanged: vi.fn(() => () => {}),
    onActivateSession: vi.fn(() => () => {}),
  },
}));

import { activateSession, createQuickSession, createSessionAndOpen, openNewSessionDialog } from './sessionActions';
import { windowBridge } from '../services/windowBridge';
import { useNavigationStore } from '../stores/navigationStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useNewSessionDialogStore } from '../stores/newSessionDialogStore';
import { useHomeStore } from '../stores/homeStore';
import { createWorkspaceRecord, createScopeRecord } from '../../shared/workspace';

beforeEach(() => {
  vi.restoreAllMocks();
  useNewSessionDialogStore.getState().close();
  vi.mocked(windowBridge.setView).mockClear();
  vi.mocked(windowBridge.activateWorkspace).mockReset();
  useWorkspaceStore.setState({ workspaces: [] });
  useHomeStore.setState({ scopeIds: {}, tabs: {}, draftGroupIds: {} });
  useNavigationStore.setState({
    activeWorkspaceId: null,
    activeSessionId: null,
    isInboxOpen: false,
  });
});

describe('session creation', () => {
  function setup() {
    const workspace = createWorkspaceRecord('App', '/app', false, 'default-agent');
    const secondary = createScopeRecord({ name: 'API', path: '/api', isGitRepo: false });
    workspace.scopes.push(secondary);
    useWorkspaceStore.setState({ workspaces: [workspace] });
    useHomeStore.getState().selectScope(workspace.id, secondary.id);
    useNavigationStore.setState({ activeWorkspaceId: workspace.id, activeSessionId: 'existing', isInboxOpen: true });
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
    expect(useNavigationStore.getState()).toMatchObject({ activeSessionId: 'new-session', isInboxOpen: false });
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
    expect(useNavigationStore.getState()).toMatchObject({ activeSessionId: 'existing', isInboxOpen: true });
    expect(useHomeStore.getState().scopeIds[workspace.id]).toBe(secondary.id);
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
    useHomeStore.getState().selectScope(workspace.id, 'removed');
    await createQuickSession(workspace.id);
    expect(create.mock.calls[0][1].scopeId).toBe(workspace.scopes[0].id);
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
      isInboxOpen: false,
    });
  });

  it('closes the Inbox, since a session was chosen over it', () => {
    useNavigationStore.setState({ isInboxOpen: true });

    activateSession('workspace-1', 'session-3');

    expect(useNavigationStore.getState().isInboxOpen).toBe(false);
    expect(windowBridge.setView).toHaveBeenCalledWith('workspace-1', {
      activeSessionId: 'session-3',
      isInboxOpen: false,
    });
  });
});
