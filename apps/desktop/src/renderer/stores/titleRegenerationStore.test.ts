import { beforeEach, expect, it, vi } from 'vitest';

const { regenerateSessionTitle, showToast } = vi.hoisted(() => ({
  regenerateSessionTitle: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('../services/workspaceBridge', () => ({ workspaceBridge: { regenerateSessionTitle } }));
vi.mock('./toastStore', () => ({ showToast }));
import { regenerateTitle, useTitleRegenerationStore } from './titleRegenerationStore';

beforeEach(() => {
  useTitleRegenerationStore.setState({ running: {} });
  regenerateSessionTitle.mockReset();
  showToast.mockReset();
});

it('marks the session running until the call settles, and ignores a second click', async () => {
  let resolve!: () => void;
  regenerateSessionTitle.mockReturnValue(
    new Promise<void>((r) => {
      resolve = r;
    }),
  );

  const first = regenerateTitle('ws', 's1');
  expect(useTitleRegenerationStore.getState().running.s1).toBe(true);

  await regenerateTitle('ws', 's1');
  expect(regenerateSessionTitle).toHaveBeenCalledTimes(1);
  expect(regenerateSessionTitle).toHaveBeenCalledWith('ws', 's1');

  resolve();
  await first;
  expect(useTitleRegenerationStore.getState().running).toEqual({});
  expect(showToast).not.toHaveBeenCalled();
});

it('shows the failure and clears running', async () => {
  regenerateSessionTitle.mockRejectedValue(
    new Error("Error invoking remote method 'x': Error: Titles are off for this workspace."),
  );
  await regenerateTitle('ws', 's1');
  expect(showToast).toHaveBeenCalledWith(
    'Couldn’t regenerate the title: Titles are off for this workspace.',
  );
  expect(useTitleRegenerationStore.getState().running).toEqual({});
});
