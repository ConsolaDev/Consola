import { pointerWithin } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import { dragPointer, pointerWithinNoted } from './dragPointer';

/** What dnd-kit hands collision detection, with one droppable under `pointer`. */
function argsAt(pointer: { x: number; y: number } | null) {
  const rect = { top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 };
  const container = { id: 'bar:g1', rect: { current: rect } };
  return {
    active: { id: 'tab:g1:files' },
    collisionRect: rect,
    droppableRects: new Map([['bar:g1', rect]]),
    droppableContainers: [container],
    pointerCoordinates: pointer,
  } as unknown as Parameters<typeof pointerWithin>[0];
}

describe('pointerWithinNoted', () => {
  it('finds what pointerWithin finds, and notes the pointer it was handed', () => {
    const args = argsAt({ x: 30, y: 20 });
    expect(pointerWithinNoted(args).map(({ id }) => id)).toEqual(
      pointerWithin(args).map(({ id }) => id),
    );
    expect(pointerWithinNoted(args).map(({ id }) => id)).toEqual(['bar:g1']);
    expect(dragPointer()).toEqual({ x: 30, y: 20 });
  });

  it('notes no pointer when dnd-kit has none', () => {
    pointerWithinNoted(argsAt({ x: 30, y: 20 }));
    pointerWithinNoted(argsAt(null));
    expect(dragPointer()).toBeNull();
  });
});
