import { afterEach, describe, expect, it } from 'vitest';
import { isTrustedSender, type IpcSenderEvent } from './ipcSenderGuard';
import {
  forgetConsolaContents,
  isConsolaContents,
  registerConsolaContents,
} from './windowRegistry';

const mainFrame = { id: 'main' };

/** An event from the main frame of a plain window, as a popup's would be. */
function windowEvent(): IpcSenderEvent {
  return { sender: { getType: () => 'window', mainFrame }, senderFrame: mainFrame };
}

describe('the window registry', () => {
  afterEach(() => forgetConsolaContents(7));

  it('knows only windows that were registered, and forgets them on close', () => {
    expect(isConsolaContents(7)).toBe(false);
    registerConsolaContents(7);
    expect(isConsolaContents(7)).toBe(true);
    forgetConsolaContents(7);
    expect(isConsolaContents(7)).toBe(false);
  });

  it('keeps a popup, whose main frame is a window main frame, off the IPC guard', () => {
    // Same shape as the app's own window, but never registered.
    expect(isTrustedSender(windowEvent(), isConsolaContents(99))).toBe(false);
    registerConsolaContents(7);
    expect(isTrustedSender(windowEvent(), isConsolaContents(7))).toBe(true);
  });
});
