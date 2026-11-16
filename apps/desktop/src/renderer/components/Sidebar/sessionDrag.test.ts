import { describe, expect, it } from 'vitest';
import type { DragEvent } from 'react';
import { droppedSessionId, isSessionDrag, startSessionDrag, SESSION_DRAG_TYPE } from './sessionDrag';

/** A dataTransfer that records what a dragstart put on it. */
function fakeDragStart() {
  const data = new Map<string, string>();
  const event = {
    dataTransfer: {
      effectAllowed: 'none',
      setData: (type: string, value: string) => {
        // Chromium lower-cases custom type names; the fake does too.
        data.set(type.toLowerCase(), value);
      },
    },
  } as unknown as DragEvent;
  return { event, data };
}

/** A dragover, where only the type names are readable. */
function fakeDragOver(types: string[]): DragEvent {
  return { dataTransfer: { types: types.map((type) => type.toLowerCase()) } } as unknown as DragEvent;
}

describe('startSessionDrag', () => {
  it('carries the session id as the payload and allows a move', () => {
    const { event, data } = fakeDragStart();

    startSessionDrag(event, { id: 's1' });

    expect(data.get(SESSION_DRAG_TYPE)).toBe('s1');
    expect(event.dataTransfer.effectAllowed).toBe('move');
  });

  it('puts nothing else on the transfer: buckets are derived, so there is no place to name', () => {
    const { event, data } = fakeDragStart();

    startSessionDrag(event, { id: 's1' });

    expect([...data.keys()]).toEqual([SESSION_DRAG_TYPE]);
  });
});

describe('isSessionDrag', () => {
  it('accepts our rows and refuses anything else, files included', () => {
    expect(isSessionDrag(fakeDragOver([SESSION_DRAG_TYPE]))).toBe(true);
    expect(isSessionDrag(fakeDragOver(['Files']))).toBe(false);
  });
});

describe('droppedSessionId', () => {
  it('reads the payload the drop carried', () => {
    const event = { dataTransfer: { getData: (type: string) => (type === SESSION_DRAG_TYPE ? 's1' : '') } } as unknown as DragEvent;
    expect(droppedSessionId(event)).toBe('s1');
  });

  it('is null when the drop carried nothing usable', () => {
    const event = { dataTransfer: { getData: () => '' } } as unknown as DragEvent;
    expect(droppedSessionId(event)).toBeNull();
  });
});
