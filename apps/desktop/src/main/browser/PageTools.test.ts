import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { findListeners, PageTools } from './PageTools';

function guest() {
  return {
    reloadIgnoringCache: vi.fn(),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    openDevTools: vi.fn(),
    setZoomLevel: vi.fn(),
    getZoomLevel: vi.fn(() => 0),
    isDestroyed: () => false,
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
