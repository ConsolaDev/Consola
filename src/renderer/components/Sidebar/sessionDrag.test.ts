import { describe, expect, it } from 'vitest';
import type { DragEvent } from 'react';
import {
  droppedSessionId,
  homeScopeType,
  isSessionDrag,
  isSessionFromScope,
  startSessionDrag,
  SESSION_DRAG_TYPE,
} from './sessionDrag';

/** A dataTransfer that records what a dragstart put on it. */
function fakeDragStart() {
  const data = new Map<string, string>();
  const event = {
    dataTransfer: {
      effectAllowed: 'none',
      setData: (type: string, value: string) => {
        // Chromium lower-cases custom type names; the fake does too, so a
        // helper that forgot to normalise fails here rather than in a drag.
        data.set(type.toLowerCase(), value);
      },
    },
  } as unknown as DragEvent;
  return { event, data };
}

/** A dragover, where only the type names are readable. */
function fakeDragOver(types: string[]): DragEvent {
  return {
    dataTransfer: { types: types.map((type) => type.toLowerCase()) },
  } as unknown as DragEvent;
}

describe('homeScopeType', () => {
  it('names the scope inside the type, which is the part a dragover can read', () => {
    expect(homeScopeType('abc123')).toContain('abc123');
    expect(homeScopeType('abc123')).not.toBe(homeScopeType('def456'));
  });

  it('is lower case, because Chromium stores custom type names that way', () => {
    expect(homeScopeType('AbC123')).toBe(homeScopeType('AbC123').toLowerCase());
    // Both ends normalise, so a mixed-case id still matches itself.
    expect(homeScopeType('AbC123')).toBe(homeScopeType('abc123'));
  });
});

describe('startSessionDrag', () => {
  it('carries the session id as the payload', () => {
    const { event, data } = fakeDragStart();

    startSessionDrag(event, { id: 's1', scopeId: 'scope-a', groupId: 'g1' });

    expect(data.get(SESSION_DRAG_TYPE)).toBe('s1');
    expect(event.dataTransfer.effectAllowed).toBe('move');
  });

  it('names the home scope of a grouped session, so that scope row can accept it', () => {
    const { event, data } = fakeDragStart();

    startSessionDrag(event, { id: 's1', scopeId: 'scope-a', groupId: 'g1' });

    expect(data.has(homeScopeType('scope-a'))).toBe(true);
  });

  it('names no home scope for an ungrouped session — it has nowhere to go back to', () => {
    const { event, data } = fakeDragStart();

    startSessionDrag(event, { id: 's1', scopeId: 'scope-a' });

    expect(data.has(homeScopeType('scope-a'))).toBe(false);
    expect(data.get(SESSION_DRAG_TYPE)).toBe('s1');
  });
});

describe('isSessionFromScope', () => {
  it('accepts the drag at the scope it came from', () => {
    const event = fakeDragOver([SESSION_DRAG_TYPE, homeScopeType('scope-a')]);

    expect(isSessionFromScope(event, 'scope-a')).toBe(true);
  });

  it('refuses every other scope — a session\'s scope is fixed for its lifetime', () => {
    const event = fakeDragOver([SESSION_DRAG_TYPE, homeScopeType('scope-a')]);

    expect(isSessionFromScope(event, 'scope-b')).toBe(false);
  });

  it('refuses an ungrouped session, which is already home', () => {
    const event = fakeDragOver([SESSION_DRAG_TYPE]);

    expect(isSessionFromScope(event, 'scope-a')).toBe(false);
  });

  it('refuses a drag that is not one of our rows at all', () => {
    const event = fakeDragOver(['Files']);

    expect(isSessionDrag(event)).toBe(false);
    expect(isSessionFromScope(event, 'scope-a')).toBe(false);
  });
});

describe('droppedSessionId', () => {
  it('reads the payload the drop carried', () => {
    const event = {
      dataTransfer: { getData: (type: string) => (type === SESSION_DRAG_TYPE ? 's1' : '') },
    } as unknown as DragEvent;

    expect(droppedSessionId(event)).toBe('s1');
  });

  it('is null when the drop carried nothing usable', () => {
    const event = { dataTransfer: { getData: () => '' } } as unknown as DragEvent;

    expect(droppedSessionId(event)).toBeNull();
  });
});
