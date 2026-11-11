import { describe, expect, it } from 'vitest';
import { assistantRowState } from './assistantRow';

describe('assistantRowState', () => {
  it.each([
    [{ hasScopes: false, unseenFinished: 2, isActive: false }, { kind: 'disabled' }],
    [{ hasScopes: true, status: 'needs-attention', unseenFinished: 2, isActive: false }, { kind: 'needs-you' }],
    [{ hasScopes: true, status: 'working', unseenFinished: 2, isActive: false }, { kind: 'working' }],
    [{ hasScopes: true, status: 'ready', unseenFinished: 2, isActive: false }, { kind: 'done', count: 2 }],
    [{ hasScopes: true, status: 'ready', unseenFinished: 2, isActive: true }, { kind: 'idle' }],
    [{ hasScopes: true, unseenFinished: 0, isActive: false }, { kind: 'idle' }],
  ])('%o → %o', (input, expected) => expect(assistantRowState(input as never)).toEqual(expected));
});
