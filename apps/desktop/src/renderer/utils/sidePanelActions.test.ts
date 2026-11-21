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
  // A chord that hides the side panel asks where the keyboard is, to hand it
  // on (keyboardAfterClose.ts): nowhere here, so it is left alone.
  (globalThis as { document?: unknown }).document = { activeElement: null };
});

import { createSessionRecord, createWorkspaceRecord } from '../../shared/workspace';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';
import { isInFront } from '../sidePanel/layout';
import { useNavigationStore } from '../stores/navigationStore';
import { usePreviewTabStore } from '../stores/previewTabStore';
import { useSidePanelStore } from '../stores/sidePanelStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  currentTabFacts,
  kindOnScreen,
  openDiffInFilesTab,
  pressShortcutOnScreen,
  toggleInfoPanelOnScreen,
  toggleSidePanelOnScreen,
} from './sidePanelActions';

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

  it('refuses a kind that does not apply to the session while it is not in front', () => {
    show({ removed: true });
    expect(pressShortcutOnScreen('files')).toBe(false);
    expect(layout()).toEqual(useSidePanelStore.getInitialState().layout);

    // Behind another tab is not in front either.
    useSidePanelStore.getState().openKind('files');
    useSidePanelStore.getState().openKind('changes');
    const before = layout();
    expect(pressShortcutOnScreen('files')).toBe(false);
    expect(layout()).toBe(before);
  });

  it('presses a kind in front even when it does not apply, which hides the side panel', () => {
    // Files was opened on another session; this one's worktree is removed,
    // so the tab shows only why. The chord still hides the panel, as the
    // header button does.
    useSidePanelStore.getState().openKind('files');
    show({ removed: true });
    expect(pressShortcutOnScreen('files')).toBe(true);
    expect(layout().visible).toBe(false);
  });
});

describe('toggleSidePanelOnScreen', () => {
  it('shows and hides the side panel beside the session on screen', () => {
    show();
    expect(toggleSidePanelOnScreen()).toBe(true);
    expect(layout().visible).toBe(true);
    expect(toggleSidePanelOnScreen()).toBe(true);
    expect(layout().visible).toBe(false);
  });

  it('does nothing without a session on screen or under an overlay', () => {
    expect(toggleSidePanelOnScreen()).toBe(false);
    show({ overlay: 'inbox' });
    expect(toggleSidePanelOnScreen()).toBe(false);
    expect(layout()).toEqual(useSidePanelStore.getInitialState().layout);
  });
});

describe('toggleInfoPanelOnScreen', () => {
  const infoVisible = () => useSidePanelStore.getState().infoVisible;

  it('shows and hides the info panel beside the session on screen, and leaves the side panel be', () => {
    show();
    expect(toggleInfoPanelOnScreen()).toBe(true);
    expect(infoVisible()).toBe(false);
    expect(toggleInfoPanelOnScreen()).toBe(true);
    expect(infoVisible()).toBe(true);
    expect(layout()).toEqual(useSidePanelStore.getInitialState().layout);
    expect(useSidePanelStore.getState().focusRequest).toBeNull();
  });

  it('does nothing without a session on screen or under an overlay', () => {
    expect(toggleInfoPanelOnScreen()).toBe(false);
    show({ overlay: 'inbox' });
    expect(toggleInfoPanelOnScreen()).toBe(false);
    expect(infoVisible()).toBe(true);
  });
});

describe('kindOnScreen', () => {
  it('is true while the kind is in front on screen for a session it applies to', () => {
    useSidePanelStore.getState().openKind('files');
    show();
    expect(kindOnScreen('files')).toBe(true);
  });

  it('is false while the kind is in front but does not apply, so its view is not mounted', () => {
    useSidePanelStore.getState().openKind('files');
    show({ removed: true });
    expect(kindOnScreen('files')).toBe(false);
  });

  it('is false behind another tab', () => {
    useSidePanelStore.getState().openKind('files');
    useSidePanelStore.getState().openKind('changes');
    show();
    expect(kindOnScreen('files')).toBe(false);
  });

  it('is false while the side panel is hidden', () => {
    useSidePanelStore.getState().openKind('files');
    useSidePanelStore.getState().setVisible(false);
    show();
    expect(kindOnScreen('files')).toBe(false);
  });

  it('is false under the Inbox or Automations, and with no session', () => {
    useSidePanelStore.getState().openKind('files');
    expect(kindOnScreen('files')).toBe(false);
    show({ overlay: 'inbox' });
    expect(kindOnScreen('files')).toBe(false);
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
