import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_TIMEOUT_MS, findListeners, PageTools } from './PageTools';

function guest() {
  return {
    reloadIgnoringCache: vi.fn(),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    openDevTools: vi.fn(),
    setZoomLevel: vi.fn(),
    getZoomLevel: vi.fn(() => 0),
    isDestroyed: () => false,
    capturePage: vi.fn(
      async (): Promise<{ isEmpty(): boolean; toPNG(): Buffer }> => ({
        isEmpty: () => false,
        toPNG: () => Buffer.from([9]),
      }),
    ),
  };
}

describe('PageTools', () => {
  it('does nothing for a tab with no page', () => {
    const tools = new PageTools(() => undefined);
    expect(() => {
      tools.hardReload('t');
      tools.findText('t', 'x', { forward: true, next: false });
      tools.stopFind('t');
      tools.openDevTools('t');
    }).not.toThrow();
    expect(tools.zoom('t', 'in')).toBe(0);
  });

  it('starts a search with no options and continues it with them', () => {
    const g = guest();
    const tools = new PageTools(() => g as unknown as WebContents);
    tools.findText('t', 'needle', { forward: true, next: false });
    expect(g.findInPage).toHaveBeenLastCalledWith('needle');
    tools.findText('t', 'needle', { forward: false, next: true });
    expect(g.findInPage).toHaveBeenLastCalledWith('needle', { forward: false, findNext: true });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('capturePage', () => {
  it('answers the PNG of a live page and null for a tab with no page', async () => {
    const g = guest();
    expect([
      ...((await new PageTools(() => g as unknown as WebContents).capturePage('t')) ?? []),
    ]).toEqual([9]);
    expect(await new PageTools(() => undefined).capturePage('t')).toBeNull();
  });

  it('gives up on a page that never answers, and says so in the log', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = guest();
    g.capturePage.mockReturnValueOnce(new Promise(() => {}));
    const pending = new PageTools(() => g as unknown as WebContents).capturePage('t');
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    expect(await pending).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('logs why a capture failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = guest();
    g.capturePage.mockRejectedValueOnce(new Error('gone'));
    await new PageTools(() => g as unknown as WebContents).capturePage('t');
    expect(warn.mock.calls[0].join(' ')).toContain('gone');
  });

  it('answers null for an empty image or a page that fails mid-capture', async () => {
    const g = guest();
    g.capturePage.mockResolvedValueOnce({ isEmpty: () => true, toPNG: () => Buffer.from([]) });
    const tools = new PageTools(() => g as unknown as WebContents);
    expect(await tools.capturePage('t')).toBeNull();
    g.capturePage.mockRejectedValueOnce(new Error('gone'));
    expect(await tools.capturePage('t')).toBeNull();
  });
});

describe('findListeners', () => {
  it('reports only a final result, and ends a search with null', () => {
    const g = guest();
    const report = vi.fn();
    const { onFound, endFind } = findListeners(g as unknown as WebContents, report);
    onFound({}, { activeMatchOrdinal: 1, matches: 2, finalUpdate: false });
    expect(report).not.toHaveBeenCalled();
    onFound({}, { activeMatchOrdinal: 1, matches: 3, finalUpdate: true });
    expect(report).toHaveBeenLastCalledWith({ active: 1, total: 3 });
    endFind();
    expect(report).toHaveBeenLastCalledWith(null);
    expect(g.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });
});
