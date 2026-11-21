import { describe, expect, it } from 'vitest';
import { edgeAt, insertionIndex, pointerAt, splitEdge } from './dropTarget';
import { defaultLayout, NEW_TAB, openKind, splitWithTab } from './layout';

const area = { left: 0, top: 0, width: 400, height: 300 };

describe('edgeAt', () => {
  it('answers the edge whose band holds the point', () => {
    expect(edgeAt(area, { x: 200, y: 20 })).toBe('top');
    expect(edgeAt(area, { x: 200, y: 290 })).toBe('bottom');
    expect(edgeAt(area, { x: 10, y: 150 })).toBe('left');
    expect(edgeAt(area, { x: 390, y: 150 })).toBe('right');
  });

  it('answers nothing in the middle or outside', () => {
    expect(edgeAt(area, { x: 200, y: 150 })).toBeNull();
    expect(edgeAt(area, { x: 500, y: 150 })).toBeNull();
  });

  it('picks the nearer edge in a corner', () => {
    expect(edgeAt(area, { x: 10, y: 20 })).toBe('left');
  });

  it('measures from where the area sits', () => {
    const placed = { left: 1000, top: 500, width: 400, height: 300 };
    expect(edgeAt(placed, { x: 1200, y: 790 })).toBe('bottom');
    expect(edgeAt(placed, { x: 200, y: 290 })).toBeNull();
  });
});

describe('insertionIndex', () => {
  const tabs = [
    { left: 0, width: 80 },
    { left: 80, width: 80 },
  ];

  it('goes before the first tab whose middle is right of the pointer', () => {
    expect(insertionIndex(tabs, 30)).toBe(0);
    expect(insertionIndex(tabs, 50)).toBe(1);
  });

  it('goes at the end past every middle', () => {
    expect(insertionIndex(tabs, 200)).toBe(2);
    expect(insertionIndex([], 200)).toBe(0);
  });
});

describe('splitEdge', () => {
  const bottom = { x: 200, y: 290 };
  const opened = (...kinds: string[]) => kinds.reduce(openKind, defaultLayout());

  it('splits a group at an edge with one of its own tabs', () => {
    expect(splitEdge(opened('changes', 'files'), 'g1', 'files', area, bottom)).toBe('bottom');
    expect(splitEdge(opened('changes', 'files'), 'g1', 'files', area, { x: 200, y: 150 })).toBe(
      null,
    );
  });

  it('never splits where canSplit does not allow it', () => {
    // A group's only tab, a second split, a tab of another group, the placeholder.
    expect(splitEdge(opened('files'), 'g1', 'files', area, bottom)).toBeNull();
    const split = splitWithTab(opened('changes', 'files'), 'g1', 'files', 'bottom');
    expect(splitEdge(split, 'g1', 'changes', area, bottom)).toBeNull();
    expect(splitEdge(split, 'g1', 'files', area, bottom)).toBeNull();
    expect(splitEdge(opened('changes', 'files'), 'g1', NEW_TAB, area, bottom)).toBeNull();
  });
});

describe('pointerAt', () => {
  it('is where the press was, moved by the delta', () => {
    expect(pointerAt({ clientX: 10, clientY: 20 } as unknown as Event, { x: 5, y: -3 })).toEqual({
      x: 15,
      y: 17,
    });
  });

  it('knows nothing of an event without a position', () => {
    expect(pointerAt({} as Event, { x: 5, y: -3 })).toBeNull();
  });
});
