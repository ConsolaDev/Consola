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

import { activateSession, openNewSessionComposer } from './sessionActions';
import { windowBridge } from '../services/windowBridge';
import { useNavigationStore } from '../stores/navigationStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useHomeStore } from '../stores/homeStore';
import { createWorkspaceRecord, createScopeRecord } from '../../shared/workspace';

beforeEach(() => {
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

describe('openNewSessionComposer', () => {
  it('uses the selected scope and clears a previous group for a generic new session', async () => {
    const workspace = createWorkspaceRecord('App', '/app', false);
    const secondary = createScopeRecord({ name: 'API', path: '/api', isGitRepo: false });
    workspace.scopes.push(secondary);
    useWorkspaceStore.setState({ workspaces: [workspace] });
    useHomeStore.getState().selectScope(workspace.id, secondary.id);
    useHomeStore.getState().setDraftGroup(workspace.id, 'previous-group');
    vi.mocked(windowBridge.activateWorkspace).mockResolvedValue({ verdict: 'took', view: { activeSessionId: null, isInboxOpen: false } });

    await openNewSessionComposer(workspace.id);

    expect(useHomeStore.getState().scopeIds[workspace.id]).toBe(secondary.id);
    expect(useHomeStore.getState().draftGroupIds[workspace.id]).toBeUndefined();
    expect(useWorkspaceStore.getState().getWorkspace(workspace.id)?.sessions).toHaveLength(0);
  });

  it('passes a group destination through and falls back when its scope was removed', async () => {
    const workspace = createWorkspaceRecord('App', '/app', false);
    useWorkspaceStore.setState({ workspaces: [workspace] });
    useHomeStore.getState().selectScope(workspace.id, 'removed-scope');
    vi.mocked(windowBridge.activateWorkspace).mockResolvedValue({ verdict: 'took', view: { activeSessionId: null, isInboxOpen: false } });

    await openNewSessionComposer(workspace.id, { groupId: 'chosen-group' });

    expect(useHomeStore.getState().scopeIds[workspace.id]).toBe(workspace.scopes[0].id);
    expect(useHomeStore.getState().draftGroupIds[workspace.id]).toBe('chosen-group');
  });

  it('leaves a different window’s scope and draft untouched when it cannot take the workspace', async () => {
    const workspace = createWorkspaceRecord('App', '/app', false);
    useWorkspaceStore.setState({ workspaces: [workspace] });
    useHomeStore.getState().selectScope(workspace.id, workspace.scopes[0].id);
    useHomeStore.getState().setDraftGroup(workspace.id, 'original-group');
    vi.mocked(windowBridge.activateWorkspace).mockResolvedValue({ verdict: 'focused-elsewhere' });

    await openNewSessionComposer(workspace.id, { scopeId: 'another-scope', groupId: 'another-group' });

    expect(useHomeStore.getState().scopeIds[workspace.id]).toBe(workspace.scopes[0].id);
    expect(useHomeStore.getState().draftGroupIds[workspace.id]).toBe('original-group');
  });

  it('lands on the composer even when the workspace remembers a session', async () => {
    // The regression this guards: routing through setActiveWorkspace would
    // adopt the remembered view, so asking for a new session would hand back
    // an existing one instead.
    vi.mocked(windowBridge.activateWorkspace).mockResolvedValue({
      verdict: 'took',
      view: { activeSessionId: 'session-remembered', isInboxOpen: false },
    });

    await openNewSessionComposer('workspace-1');

    expect(useNavigationStore.getState().activeWorkspaceId).toBe('workspace-1');
    expect(useNavigationStore.getState().activeSessionId).toBe(null);
    expect(useNavigationStore.getState().isInboxOpen).toBe(false);
  });

  it('records the composer as the workspace view, so returning lands there too', async () => {
    vi.mocked(windowBridge.activateWorkspace).mockResolvedValue({
      verdict: 'took',
      view: { activeSessionId: 'session-remembered', isInboxOpen: false },
    });

    await openNewSessionComposer('workspace-1');

    expect(windowBridge.setView).toHaveBeenCalledWith('workspace-1', {
      activeSessionId: null,
      isInboxOpen: false,
    });
  });

  it('changes nothing when another window already holds the workspace', async () => {
    useNavigationStore.setState({
      activeWorkspaceId: 'workspace-1',
      activeSessionId: 'session-1',
    });
    vi.mocked(windowBridge.activateWorkspace).mockResolvedValue({
      verdict: 'focused-elsewhere',
    });

    await openNewSessionComposer('workspace-2');

    expect(useNavigationStore.getState().activeWorkspaceId).toBe('workspace-1');
    expect(useNavigationStore.getState().activeSessionId).toBe('session-1');
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
