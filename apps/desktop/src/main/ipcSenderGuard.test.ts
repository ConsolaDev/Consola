import { describe, expect, it } from 'vitest';
import { isTrustedSender, type IpcSenderEvent } from './ipcSenderGuard';

const mainFrame = { id: 'main' };

function event(type: string, frame: unknown = mainFrame): IpcSenderEvent {
  return { sender: { getType: () => type, mainFrame }, senderFrame: frame };
}

describe('isTrustedSender', () => {
  it('accepts the main frame of a known window', () => {
    expect(isTrustedSender(event('window'), true)).toBe(true);
  });

  it('refuses a webview guest', () => {
    expect(isTrustedSender(event('webview'), true)).toBe(false);
  });

  it('refuses a subframe of a window', () => {
    expect(isTrustedSender(event('window', { id: 'iframe' }), true)).toBe(false);
  });

  it('refuses a frame that is already gone', () => {
    expect(isTrustedSender(event('window', null), true)).toBe(false);
  });

  it('refuses contents that belong to no known window', () => {
    expect(isTrustedSender(event('window'), false)).toBe(false);
  });
});
