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
  },
}));

import { mergeNavigationState, useNavigationStore, type NavigationState } from './navigationStore';

/**
 * A minimal, fully-typed NavigationState to use as `current` in merge tests.
 * mergeNavigationState only ever reads data fields off it, never calls an
 * action, so `vi.fn()` stands in for all of them.
 */
function makeCurrent(overrides: Partial<NavigationState> = {}): NavigationState {
  return {
    isSidebarHidden: false,
    isExplorerVisible: false,
    activeWorkspaceId: 'current-workspace',
    activeSessionId: 'current-session',
    isInboxOpen: false,
    toggleSidebar: vi.fn(),
    setSidebarHidden: vi.fn(),
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
});
