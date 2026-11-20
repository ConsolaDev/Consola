import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.fn();
const setBrowserVisible = vi.fn();
let rule: 'local' | 'all' | 'never' = 'local';

vi.mock('../../services/browserBridge', () => ({
  browserBridge: { open: (...args: unknown[]) => open(...args) },
}));
vi.mock('../../stores/preferencesStore', () => ({
  usePreferencesStore: { getState: () => ({ terminalLinks: rule }) },
}));
vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ setBrowserVisible }) },
}));

import { openTerminalLink } from './terminalLinks';

const click = (shiftKey = false) => ({ shiftKey }) as MouseEvent;

describe('openTerminalLink', () => {
  const windowOpen = vi.fn();

  beforeEach(() => {
    rule = 'local';
    open.mockReset().mockResolvedValue({ id: 'tab' });
    setBrowserVisible.mockReset();
    windowOpen.mockReset();
    vi.stubGlobal('window', { open: windowOpen });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a local address in the session browser and shows the panel', () => {
    openTerminalLink('session-1', click(), 'http://localhost:5173/');
    expect(open).toHaveBeenCalledWith('session-1', 'http://localhost:5173/');
    expect(setBrowserVisible).toHaveBeenCalledWith(true);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('hands the URL itself to window.open for the system browser, so the window-open handler in main can forward it', () => {
    // xterm's own activation opens a blank window first and assigns the URL
    // afterwards; the handler only ever sees "about:blank" and denies it.
    openTerminalLink('session-1', click(), 'https://github.com/example/repo/pull/1');
    expect(windowOpen).toHaveBeenCalledTimes(1);
    expect(windowOpen).toHaveBeenCalledWith('https://github.com/example/repo/pull/1', '_blank');
    expect(open).not.toHaveBeenCalled();
    expect(setBrowserVisible).not.toHaveBeenCalled();
  });

  it('Shift sends a local address to the system browser and an outside one to Consola', () => {
    openTerminalLink('session-1', click(true), 'http://localhost:5173/');
    expect(windowOpen).toHaveBeenCalledWith('http://localhost:5173/', '_blank');
    openTerminalLink('session-1', click(true), 'https://example.com/');
    expect(open).toHaveBeenCalledWith('session-1', 'https://example.com/');
  });

  it('follows the rule in the preferences at the moment of the click', () => {
    rule = 'never';
    openTerminalLink('session-1', click(), 'http://localhost:5173/');
    expect(windowOpen).toHaveBeenCalledTimes(1);
    rule = 'all';
    openTerminalLink('session-1', click(), 'https://example.com/');
    expect(open).toHaveBeenCalledWith('session-1', 'https://example.com/');
  });

  it('never puts a link that is not a web page into the browser', () => {
    rule = 'all';
    openTerminalLink('session-1', click(), 'mailto:someone@example.com');
    expect(open).not.toHaveBeenCalled();
    expect(windowOpen).toHaveBeenCalledWith('mailto:someone@example.com', '_blank');
  });
});
