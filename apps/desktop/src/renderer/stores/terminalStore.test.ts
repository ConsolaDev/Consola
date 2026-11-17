import { beforeEach, describe, expect, it, vi } from 'vitest';

// terminalStore.ts reaches the main process through terminalBridge, which
// dereferences `window.terminalAPI` — a global this suite's Node environment
// doesn't have. Mocking the module (hoisted by Vitest above the import below)
// lets the store module load without a DOM. `noteActivity` itself never
// touches the bridge; only subscribeToEvents/hydrate do.
vi.mock('../services/terminalBridge', () => ({
  terminalBridge: {
    onActivity: vi.fn(() => () => {}),
    onAwaitingConfirmation: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    getStatusSnapshot: vi.fn(async () => ({})),
  },
}));

import { terminalBridge } from '../services/terminalBridge';
import { useTerminalStore } from './terminalStore';

const store = () => useTerminalStore.getState();

beforeEach(() => {
  useTerminalStore.setState({ terminals: {}, pendingPrompts: {} });
});

describe('noteActivity', () => {
  it('records the busy flag as it changes', () => {
    store().noteActivity('t1', true);
    expect(store().getState('t1').isBusy).toBe(true);

    store().noteActivity('t1', false);
    expect(store().getState('t1').isBusy).toBe(false);
  });

  it("keeps no derived done bookkeeping: that is main's attention now", () => {
    store().noteActivity('t1', true);
    store().noteActivity('t1', false);

    expect(store().getState('t1')).not.toHaveProperty('completedWhileAway');
  });
});

describe('subscribeToEvents', () => {
  it('a status other than exited clears hasExited, so a pane woken from main loses its restart overlay', () => {
    let onStatus: (message: { instanceId: string; status: string }) => void = () => {};
    vi.mocked(terminalBridge.onStatus).mockImplementationOnce(((callback: typeof onStatus) => {
      onStatus = callback;
      return () => {};
    }) as never);
    const unsubscribe = store().subscribeToEvents();

    store().setState('i', { hasExited: true });
    onStatus({ instanceId: 'i', status: 'working' });
    expect(store().getState('i')).toMatchObject({ hasExited: false, status: 'working' });

    // The exit event owns setting it; a status of exited must not undo that.
    store().setState('i', { hasExited: true });
    onStatus({ instanceId: 'i', status: 'exited' });
    expect(store().getState('i')).toMatchObject({ hasExited: true, status: 'exited' });
    unsubscribe();
  });
});
