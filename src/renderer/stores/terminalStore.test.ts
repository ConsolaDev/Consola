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
    getStatusSnapshot: vi.fn(async () => ({})),
  },
}));

import { useTerminalStore } from './terminalStore';

const store = () => useTerminalStore.getState();

beforeEach(() => {
  useTerminalStore.setState({ terminals: {}, pendingPrompts: {} });
});

describe('noteActivity', () => {
  it('marks a completion when work stops', () => {
    store().noteActivity('t1', true);
    store().noteActivity('t1', false);

    expect(store().getState('t1')).toMatchObject({ isBusy: false, completedWhileAway: true });
  });

  it('does not mark a completion for a terminal never seen working', () => {
    store().noteActivity('t1', false);

    expect(store().getState('t1').completedWhileAway).toBe(false);
  });

  it('keeps a standing completion through a repeated idle report', () => {
    store().noteActivity('t1', true);
    store().noteActivity('t1', false);
    store().noteActivity('t1', false);

    expect(store().getState('t1').completedWhileAway).toBe(true);
  });

  it('clears a completion when new work starts', () => {
    store().noteActivity('t1', true);
    store().noteActivity('t1', false);
    store().noteActivity('t1', true);

    expect(store().getState('t1')).toMatchObject({ isBusy: true, completedWhileAway: false });
  });
});

describe('acknowledgeCompletion', () => {
  it('clears the completion once the session has been seen', () => {
    store().noteActivity('t1', true);
    store().noteActivity('t1', false);
    store().acknowledgeCompletion('t1');

    expect(store().getState('t1').completedWhileAway).toBe(false);
  });

  it('is a no-op for a terminal with no state, not a state creator', () => {
    store().acknowledgeCompletion('t1');

    expect(useTerminalStore.getState().terminals['t1']).toBeUndefined();
  });
});
