import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attentionBridge } from '../services/attentionBridge';
import { dismissToast, TOAST_LIFE_MS, useToastStore } from '../stores/toastStore';
import { settleWithUndo, unsettleWithUndo } from './settleActions';

vi.mock('../services/attentionBridge', () => ({
  attentionBridge: { settle: vi.fn(), unsettle: vi.fn(), restore: vi.fn() },
}));

const memento = { a: { sessionId: 'a', workspaceId: 'w', lastActiveAt: 5 } };

beforeEach(() => {
  vi.useFakeTimers();
  for (const toast of useToastStore.getState().toasts) dismissToast(toast.id);
  vi.mocked(attentionBridge.settle).mockResolvedValue({ settled: true, memento });
  vi.mocked(attentionBridge.unsettle).mockResolvedValue(memento);
  vi.mocked(attentionBridge.restore).mockReset();
});

describe('settling with undo', () => {
  it('toasts where the session went, and Undo restores exactly what main handed back', async () => {
    await settleWithUndo('w', 'a', 'Fix login');
    const [toast] = useToastStore.getState().toasts;
    expect(toast.message).toContain('Settled shelf');
    toast.action!.run();
    expect(attentionBridge.restore).toHaveBeenCalledWith(memento);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('a settle that did not move the row says so, claims no destination, and offers no Undo', async () => {
    vi.mocked(attentionBridge.settle).mockResolvedValue({ settled: false, memento: {} });
    await settleWithUndo('w', 'a', 'Fix login');
    const [toast] = useToastStore.getState().toasts;
    expect(toast.message).not.toContain('Settled shelf');
    expect(toast.message).toMatch(/could not settle/i);
    expect(toast.action).toBeUndefined();
  });

  it('un-settling can be undone too', async () => {
    await unsettleWithUndo('w', 'a', 'Fix login');
    useToastStore.getState().toasts[0].action!.run();
    expect(attentionBridge.restore).toHaveBeenCalledWith(memento);
  });

  it('the toast goes away on its own after five seconds, and Undo is gone with it', async () => {
    await settleWithUndo('w', 'a', 'Fix login');
    vi.advanceTimersByTime(TOAST_LIFE_MS - 1);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
