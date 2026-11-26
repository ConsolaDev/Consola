import { describe, expect, it } from 'vitest';
import { decideGuestBinding } from './guestOwnership';
import type { GuestFacts } from './guestOwnership';

const ok: GuestFacts = {
  type: 'webview',
  destroyed: false,
  hostIsSender: true,
  inWorkspacePartition: true,
  tabInWorkspace: true,
};

describe('decideGuestBinding', () => {
  it('binds a webview of this window, in this workspace, to one of its tabs', () => {
    expect(decideGuestBinding(ok)).toEqual({ ok: true });
  });

  it.each<[string, Partial<GuestFacts>]>([
    ['is already destroyed', { destroyed: true }],
    ['is not a webview (a window or devtools contents)', { type: 'window' }],
    ['belongs to another window', { hostIsSender: false }],
    ['lives in another partition', { inWorkspacePartition: false }],
    ['is for a tab of another workspace', { tabInWorkspace: false }],
  ])('refuses a guest that %s', (_label, change) => {
    expect(decideGuestBinding({ ...ok, ...change }).ok).toBe(false);
  });
});
