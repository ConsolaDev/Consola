import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutInfo } from '../../shared/sessionCheckout';

vi.mock('../services/gitBridge', () => ({
  gitBridge: { getCheckout: vi.fn() },
}));

import { gitBridge } from '../services/gitBridge';
import { useCheckoutStore } from './checkoutStore';

const getCheckout = vi.mocked(gitBridge.getCheckout);
const tree: CheckoutInfo = {
  kind: 'worktree',
  root: '/code/trees/app-session-1',
  mainCheckout: '/code/app',
  branch: 'feature/login',
};

beforeEach(() => {
  getCheckout.mockReset();
  useCheckoutStore.setState({ byPath: {} });
});

describe('checkoutStore', () => {
  it('asks git once for a folder however many rows ask at the same time', async () => {
    getCheckout.mockResolvedValue(tree);
    const { load } = useCheckoutStore.getState();
    await Promise.all([load(tree.root), load(tree.root), load(tree.root)]);
    expect(getCheckout).toHaveBeenCalledTimes(1);
    expect(useCheckoutStore.getState().byPath[tree.root]).toEqual(tree);
  });

  it('ensure reads only what is unknown, while load always reads again', async () => {
    getCheckout.mockResolvedValue(tree);
    await useCheckoutStore.getState().load(tree.root);
    useCheckoutStore.getState().ensure(tree.root);
    expect(getCheckout).toHaveBeenCalledTimes(1);

    getCheckout.mockResolvedValue({ ...tree, branch: 'feature/renamed' });
    await useCheckoutStore.getState().load(tree.root);
    expect(useCheckoutStore.getState().byPath[tree.root]).toMatchObject({ branch: 'feature/renamed' });
  });

  it('leaves the map untouched when a re-read says nothing new, so rows do not re-render', async () => {
    getCheckout.mockResolvedValue(tree);
    await useCheckoutStore.getState().load(tree.root);
    const before = useCheckoutStore.getState().byPath;
    getCheckout.mockResolvedValue({ ...tree });
    await useCheckoutStore.getState().load(tree.root);
    expect(useCheckoutStore.getState().byPath).toBe(before);
  });

  it('keeps the last known answer when git cannot be asked', async () => {
    getCheckout.mockResolvedValue(tree);
    await useCheckoutStore.getState().load(tree.root);
    getCheckout.mockRejectedValue(new Error('ipc closed'));
    await useCheckoutStore.getState().load(tree.root);
    expect(useCheckoutStore.getState().byPath[tree.root]).toEqual(tree);
  });
});
