import { afterEach, describe, expect, it, vi } from 'vitest';
import { openTerminalLink } from './terminalLinks';

describe('openTerminalLink', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hands the URL itself to window.open, so the window-open handler in main can forward it to the OS browser', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });

    openTerminalLink({} as MouseEvent, 'https://github.com/example/repo/pull/1');

    // xterm's own activation opens a blank window first and assigns the URL
    // afterwards; the handler only ever sees "about:blank" and denies it.
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://github.com/example/repo/pull/1', '_blank');
  });
});
