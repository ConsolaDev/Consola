import { beforeEach, describe, expect, it, vi } from 'vitest';

// The stores below reach main through windowBridge, which reads
// `window.windowAPI` at load: mocked, as in sessionActions.test.ts. Node runs
// these with web storage off (vitest.config.ts), so a Map stands in for the
// side panel's localStorage, as in sidePanelStore.test.ts.
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
vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
});

import { createSessionRecord, createWorkspaceRecord } from '../../shared/workspace';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';
import { isInFront } from '../sidePanel/layout';
import { useNavigationStore } from '../stores/navigationStore';
import { usePreviewTabStore } from '../stores/previewTabStore';
import { useSidePanelStore } from '../stores/sidePanelStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { currentTabFacts, openDiffInFilesTab, pressShortcutOnScreen } from './sidePanelActions';

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

const layout = () => useSidePanelStore.getState().layout;

function show(onScreen: { overlay?: 'inbox' | null; removed?: boolean } = {}) {
  const shown = onScreen.removed ? { ...session, cwd: '/tmp/wt', removedWorktree } : session;
  useWorkspaceStore.setState({ workspaces: [{ ...workspace, sessions: [shown] }] });
  useNavigationStore.setState({
    activeWorkspaceId: workspace.id,
    activeSessionId: session.id,
    overlay: onScreen.overlay ?? null,
  });
}

beforeEach(() => {
  useSidePanelStore.setState(useSidePanelStore.getInitialState(), true);
  usePreviewTabStore.getState().closeAllTabs();
  useWorkspaceStore.setState({ workspaces: [] });
  useNavigationStore.setState({ activeWorkspaceId: null, activeSessionId: null, overlay: null });
});

describe('currentTabFacts', () => {
  it('reads the session on screen and its checkout', () => {
    show();
    const facts = currentTabFacts();
    expect(facts?.session.id).toBe(session.id);
    expect(facts?.workspace.id).toBe(workspace.id);
    expect(facts?.checkoutPath).toBe('/repos/catalog-portal');
  });

  it('is null with no session, or under the Inbox or Automations', () => {
    expect(currentTabFacts()).toBeNull();
    show({ overlay: 'inbox' });
    expect(currentTabFacts()).toBeNull();
  });
});

describe('pressShortcutOnScreen', () => {
  it('presses the kind’s shortcut for the session on screen', () => {
    show();
    expect(pressShortcutOnScreen('files')).toBe(true);
    expect(isInFront(layout(), 'files')).toBe(true);
    expect(pressShortcutOnScreen('files')).toBe(true);
    expect(layout().visible).toBe(false);
  });

  it('does nothing without a session on screen or under an overlay', () => {
    expect(pressShortcutOnScreen('files')).toBe(false);
    show({ overlay: 'inbox' });
    expect(pressShortcutOnScreen('files')).toBe(false);
    expect(layout()).toEqual(useSidePanelStore.getInitialState().layout);
  });

  it('does nothing while the kind does not apply to the session', () => {
    show({ removed: true });
    expect(pressShortcutOnScreen('files')).toBe(false);
    expect(layout()).toEqual(useSidePanelStore.getInitialState().layout);
  });
});

describe('openDiffInFilesTab', () => {
  it('opens the diff as a preview and brings the Files tab to the front', () => {
    show();
    openDiffInFilesTab('/repos/catalog-portal', 'src/search.ts', false);
    const preview = usePreviewTabStore.getState();
    expect(preview.tabs.map((tab) => tab.filename)).toEqual(['search.ts']);
    expect(preview.activeTabId).toBe('diff:unstaged:/repos/catalog-portal/src/search.ts');
    expect(isInFront(layout(), 'files')).toBe(true);
  });
});
