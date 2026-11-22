import { beforeEach, describe, expect, it, vi } from 'vitest';

// The stores below reach main through windowBridge, which reads
// `window.windowAPI` at load: mocked, as in sidePanelActions.test.ts, and
// main's "Open in" is stood in for, so nothing opens. Node runs these with
// web storage off (vitest.config.ts), so a Map stands in for localStorage.
vi.mock('../services/windowBridge', () => ({
  windowBridge: {
    context: { workspaceId: null, activeSessionId: null, overlay: null },
    activateWorkspace: vi.fn(),
    openWindow: vi.fn(),
    setView: vi.fn(),
    onWorkspaceChanged: vi.fn(() => () => {}),
    onActivateSession: vi.fn(() => () => {}),
    onShowAutomations: vi.fn(() => () => {}),
  },
}));
const bridge = vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  return { list: vi.fn(), open: vi.fn() };
});
vi.mock('../services/openInBridge', () => ({ openInBridge: bridge }));

import { createSessionRecord, createWorkspaceRecord } from '../../shared/workspace';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';
import { useNavigationStore } from '../stores/navigationStore';
import { useOpenInStore } from '../stores/openInStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { openFolderOnScreen } from './openInActions';

const workspace = createWorkspaceRecord('catalog-portal', '/repos/catalog-portal', true);
const session = createSessionRecord({
  name: 'Paginate the catalog search',
  workspaceId: workspace.id,
  instanceId: 'i1',
  harnessId: 'default',
  scopeId: workspace.scopes[0].id,
});
const removedWorktree: RemovedWorktree = {
  path: '/tmp/wt',
  mainRepo: '/repos/catalog-portal',
  commit: 'a'.repeat(40),
  branch: 'consola/paginate-search',
  keepRef: 'refs/consola/worktrees/wt',
  trigger: 'settled',
  removedAt: 0,
};

function show(onScreen: { overlay?: 'inbox' | 'automations' | null; removed?: boolean } = {}) {
  const shown = onScreen.removed ? { ...session, cwd: '/tmp/wt', removedWorktree } : session;
  useWorkspaceStore.setState({ workspaces: [{ ...workspace, sessions: [shown] }] });
  useNavigationStore.setState({
    activeWorkspaceId: workspace.id,
    activeSessionId: session.id,
    overlay: onScreen.overlay ?? null,
  });
}

/** Lets the open the chord started reach main. */
const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  bridge.list.mockReset().mockResolvedValue([
    { id: 'vscode', label: 'VS Code', kind: 'app' },
    { id: 'finder', label: 'Finder', kind: 'file-manager' },
  ]);
  bridge.open.mockReset().mockResolvedValue({ ok: true });
  useOpenInStore.setState(useOpenInStore.getInitialState(), true);
  useSettingsStore.setState({ openInFavourite: 'vscode' });
  useWorkspaceStore.setState({ workspaces: [] });
  useNavigationStore.setState({ activeWorkspaceId: null, activeSessionId: null, overlay: null });
});

describe('openFolderOnScreen', () => {
  it('opens the session’s folder in the favourite', async () => {
    show();
    expect(openFolderOnScreen()).toBe(true);
    await settle();
    expect(bridge.open).toHaveBeenCalledWith({ targetId: 'vscode', path: '/repos/catalog-portal' });
  });

  it('opens where the agent moved itself, as the Folder row copies', async () => {
    useWorkspaceStore.setState({
      workspaces: [
        { ...workspace, sessions: [{ ...session, agentCwd: '/repos/catalog-portal-wt' }] },
      ],
    });
    useNavigationStore.setState({ activeWorkspaceId: workspace.id, activeSessionId: session.id });
    expect(openFolderOnScreen()).toBe(true);
    await settle();
    expect(bridge.open).toHaveBeenCalledWith({
      targetId: 'vscode',
      path: '/repos/catalog-portal-wt',
    });
  });

  it('does nothing with no session on screen, or under the Inbox or Automations', async () => {
    expect(openFolderOnScreen()).toBe(false);
    show({ overlay: 'inbox' });
    expect(openFolderOnScreen()).toBe(false);
    show({ overlay: 'automations' });
    expect(openFolderOnScreen()).toBe(false);
    await settle();
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it('does nothing while the session’s worktree is removed', async () => {
    show({ removed: true });
    expect(openFolderOnScreen()).toBe(false);
    await settle();
    expect(bridge.open).not.toHaveBeenCalled();
  });
});
