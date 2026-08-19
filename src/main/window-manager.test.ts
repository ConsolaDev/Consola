import { describe, expect, it } from 'vitest';
import { boundsAreVisible, dedupeByWorkspace } from './window-manager';

describe('dedupeByWorkspace', () => {
  it('keeps only the first entry for a repeated workspace id', () => {
    const entries = [
      { workspaceId: 'a', bounds: 1 },
      { workspaceId: 'a', bounds: 2 },
    ];

    expect(dedupeByWorkspace(entries)).toEqual([{ workspaceId: 'a', bounds: 1 }]);
  });

  it('leaves distinct workspace ids alone', () => {
    const entries = [
      { workspaceId: 'a', bounds: 1 },
      { workspaceId: 'b', bounds: 2 },
    ];

    expect(dedupeByWorkspace(entries)).toEqual(entries);
  });

  it('never collapses windows with no workspace — several Home windows is normal', () => {
    const entries = [
      { workspaceId: null, bounds: 1 },
      { workspaceId: null, bounds: 2 },
    ];

    expect(dedupeByWorkspace(entries)).toEqual(entries);
  });

  it('passes an empty layout through unchanged', () => {
    expect(dedupeByWorkspace([])).toEqual([]);
  });
});

describe('boundsAreVisible', () => {
  const primary = { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const secondary = { workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };

  it('is visible when fully inside a single display', () => {
    const bounds = { x: 100, y: 100, width: 800, height: 600 };

    expect(boundsAreVisible(bounds, [primary])).toBe(true);
  });

  it('is visible when only partially overlapping a display edge — a containment check would wrongly reject this', () => {
    // Spans x:1400-1600, straddling the primary display's right edge at 1440.
    const bounds = { x: 1400, y: 100, width: 200, height: 200 };

    expect(boundsAreVisible(bounds, [primary])).toBe(true);
  });

  it('is visible when it lands on a second display that is still attached', () => {
    const bounds = { x: 1500, y: 100, width: 800, height: 600 };

    expect(boundsAreVisible(bounds, [primary, secondary])).toBe(true);
  });

  it('is not visible when its coordinates match a display that is no longer in the list — the detached-monitor case', () => {
    // Same rectangle that was visible on [primary, secondary] above, but the
    // secondary display (an external monitor) is no longer attached.
    const bounds = { x: 1500, y: 100, width: 800, height: 600 };

    expect(boundsAreVisible(bounds, [primary])).toBe(false);
  });

  it('is not visible against an empty display list', () => {
    const bounds = { x: 100, y: 100, width: 800, height: 600 };

    expect(boundsAreVisible(bounds, [])).toBe(false);
  });

  it('is not visible when it exactly abuts a display edge with zero overlap', () => {
    // bounds.x sits exactly at the primary display's right edge (0 + 1440):
    // pins the strict `<`/`>` comparisons rather than `<=`/`>=`.
    const bounds = { x: 1440, y: 0, width: 200, height: 200 };

    expect(boundsAreVisible(bounds, [primary])).toBe(false);
  });
});
