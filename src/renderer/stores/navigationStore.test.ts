import { describe, it, expect, vi } from 'vitest';

// navigationStore.ts reads `windowBridge.context` at module load time (it
// seeds the store's initial identity from it), and the real windowBridge
// reaches through `window.windowAPI` -- a global this suite's Node
// environment doesn't have. Mocking the module (hoisted by Vitest above the
// import below) lets the store module load without a DOM.
vi.mock('../services/windowBridge', () => ({
  windowBridge: {
    context: { workspaceId: null, activeSessionId: null },
    activateWorkspace: vi.fn(),
    openWindow: vi.fn(),
    setActiveSession: vi.fn(),
    onWorkspaceChanged: vi.fn(() => () => {}),
    onActivateSession: vi.fn(() => () => {}),
  },
}));

import {
  mergeNavigationState,
  useNavigationStore,
  subscribeToActivateSession,
  subscribeToWindowWorkspace,
  clampSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  type NavigationState,
} from './navigationStore';
import { windowBridge } from '../services/windowBridge';

/**
 * A minimal, fully-typed NavigationState to use as `current` in merge tests.
 * mergeNavigationState only ever reads data fields off it, never calls an
 * action, so `vi.fn()` stands in for all of them.
 */
function makeCurrent(overrides: Partial<NavigationState> = {}): NavigationState {
  return {
    isSidebarHidden: false,
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    isExplorerVisible: false,
    activeWorkspaceId: 'current-workspace',
    activeSessionId: 'current-session',
    isInboxOpen: false,
    toggleSidebar: vi.fn(),
    setSidebarHidden: vi.fn(),
    setSidebarWidth: vi.fn(),
    toggleExplorer: vi.fn(),
    setExplorerVisible: vi.fn(),
    setActiveWorkspace: vi.fn(),
    setActiveSession: vi.fn(),
    openInbox: vi.fn(),
    ...overrides,
  };
}

describe('mergeNavigationState', () => {
  it('keeps current identity and takes only preferences from a v0-shaped blob', () => {
    const current = makeCurrent();
    // Shaped like a blob written by a pre-Task-10 build: identity keys that
    // no longer belong in localStorage, sitting alongside the two that do.
    const persisted = {
      activeWorkspaceId: 'stale-workspace',
      activeSessionId: 'stale-session',
      expandedWorkspaces: { 'stale-workspace': true },
      isSidebarHidden: true,
      isExplorerVisible: true,
    };

    const result = mergeNavigationState(persisted, current);

    // Identity comes from `current` (window-context-seeded), never the blob.
    expect(result.activeWorkspaceId).toBe(current.activeWorkspaceId);
    expect(result.activeSessionId).toBe(current.activeSessionId);
    // expandedWorkspaces no longer exists on NavigationState at all, so a v0
    // blob carrying it must not resurrect it on the merged result.
    expect(result).not.toHaveProperty('expandedWorkspaces');
    // The two real preferences do come from the blob.
    expect(result.isSidebarHidden).toBe(true);
    expect(result.isExplorerVisible).toBe(true);
  });

  it('falls back to current when neither preference key is present', () => {
    const current = makeCurrent({ isSidebarHidden: true, isExplorerVisible: false });

    const result = mergeNavigationState({}, current);

    expect(result.isSidebarHidden).toBe(current.isSidebarHidden);
    expect(result.isExplorerVisible).toBe(current.isExplorerVisible);
  });

  it('ignores a non-boolean preference value', () => {
    const current = makeCurrent({ isSidebarHidden: false });

    const result = mergeNavigationState({ isSidebarHidden: 'true' }, current);

    expect(result.isSidebarHidden).toBe(false);
  });

  it('returns current unchanged for null or undefined persisted state, without throwing', () => {
    const current = makeCurrent();

    expect(() => mergeNavigationState(null, current)).not.toThrow();
    expect(mergeNavigationState(null, current)).toEqual(current);

    expect(() => mergeNavigationState(undefined, current)).not.toThrow();
    expect(mergeNavigationState(undefined, current)).toEqual(current);
  });
});

describe('inbox navigation', () => {
  it('opens the inbox', () => {
    useNavigationStore.setState({ isInboxOpen: false });
    useNavigationStore.getState().openInbox();
    expect(useNavigationStore.getState().isInboxOpen).toBe(true);
  });

  it('closes the inbox when a session is activated', () => {
    useNavigationStore.setState({ isInboxOpen: true });
    useNavigationStore.getState().setActiveSession('session-1');
    expect(useNavigationStore.getState().isInboxOpen).toBe(false);
    expect(useNavigationStore.getState().activeSessionId).toBe('session-1');
  });

  it('closes the inbox when a notification click activates a session', () => {
    useNavigationStore.setState({ isInboxOpen: true, activeSessionId: null });
    subscribeToActivateSession();
    const onActivateSession = vi.mocked(windowBridge.onActivateSession);
    const activateCallback = onActivateSession.mock.calls.at(-1)?.[0];
    activateCallback?.('session-2');
    expect(useNavigationStore.getState().activeSessionId).toBe('session-2');
    expect(useNavigationStore.getState().isInboxOpen).toBe(false);
  });

  it('closes the inbox when main hands this window a different workspace', () => {
    useNavigationStore.setState({ isInboxOpen: true });
    subscribeToWindowWorkspace();
    const onWorkspaceChanged = vi.mocked(windowBridge.onWorkspaceChanged);
    const workspaceChangedCallback = onWorkspaceChanged.mock.calls.at(-1)?.[0];
    workspaceChangedCallback?.('workspace-2');
    expect(useNavigationStore.getState().isInboxOpen).toBe(false);
    expect(useNavigationStore.getState().activeWorkspaceId).toBe('workspace-2');
  });
});

describe('sidebar width', () => {
  it('clamps to the drag bounds and rounds to whole pixels', () => {
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MIN - 1)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MAX + 1)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it('falls back to the default for a value that is not a finite number', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it('takes an in-range persisted width', () => {
    const result = mergeNavigationState({ sidebarWidth: 320 }, makeCurrent());
    expect(result.sidebarWidth).toBe(320);
  });

  it('clamps an out-of-range persisted width instead of rejecting it', () => {
    // A hand-edited blob, or one written before the bounds changed, still has
    // to land on a width the layout can show.
    expect(mergeNavigationState({ sidebarWidth: 50 }, makeCurrent()).sidebarWidth).toBe(
      SIDEBAR_WIDTH_MIN
    );
    expect(mergeNavigationState({ sidebarWidth: 9999 }, makeCurrent()).sidebarWidth).toBe(
      SIDEBAR_WIDTH_MAX
    );
  });

  it('ignores a persisted width that is not a number', () => {
    const current = makeCurrent({ sidebarWidth: 300 });
    expect(mergeNavigationState({ sidebarWidth: '320' }, current).sidebarWidth).toBe(300);
  });

  it('keeps the current width when the key is absent', () => {
    const current = makeCurrent({ sidebarWidth: 300 });
    expect(mergeNavigationState({}, current).sidebarWidth).toBe(300);
  });

  it('clamps a width set through the action', () => {
    useNavigationStore.getState().setSidebarWidth(SIDEBAR_WIDTH_MAX + 100);
    expect(useNavigationStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
    useNavigationStore.getState().setSidebarWidth(300);
    expect(useNavigationStore.getState().sidebarWidth).toBe(300);
  });

  it('survives hiding and showing the sidebar', () => {
    useNavigationStore.setState({ isSidebarHidden: false });
    useNavigationStore.getState().setSidebarWidth(300);
    useNavigationStore.getState().toggleSidebar();
    useNavigationStore.getState().toggleSidebar();
    expect(useNavigationStore.getState().isSidebarHidden).toBe(false);
    expect(useNavigationStore.getState().sidebarWidth).toBe(300);
  });
});
