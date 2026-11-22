import { FIRST_SEQUENCE } from '@consola/cloud-contract';
import { describe, expect, it } from 'vitest';
import { copyChangeOf, nextSequenceAfter, placeMessage } from './workspaceCopy.js';

describe('nextSequenceAfter', () => {
  it('is the first sequence for a workspace the copy holds nothing of', () => {
    expect(nextSequenceAfter(null)).toBe(FIRST_SEQUENCE);
  });

  it('is one more than the last applied', () => {
    expect(nextSequenceAfter(1)).toBe(2);
    expect(nextSequenceAfter(41)).toBe(42);
  });
});

describe('placeMessage', () => {
  it("takes a workspace's first message when the copy holds nothing of it", () => {
    expect(placeMessage(FIRST_SEQUENCE, null)).toEqual({ kind: 'next' });
  });

  it('makes a later message for a workspace it holds nothing of wait for the first', () => {
    expect(placeMessage(2, null)).toEqual({ kind: 'ahead', nextSequence: FIRST_SEQUENCE });
    expect(placeMessage(7, null)).toEqual({ kind: 'ahead', nextSequence: FIRST_SEQUENCE });
  });

  it('takes the message after the last applied', () => {
    expect(placeMessage(4, 3)).toEqual({ kind: 'next' });
  });

  it('changes nothing for a message at or below the last applied', () => {
    expect(placeMessage(3, 3)).toEqual({ kind: 'applied-before' });
    expect(placeMessage(1, 3)).toEqual({ kind: 'applied-before' });
  });

  it('makes a message past the next wait, naming the next', () => {
    expect(placeMessage(5, 3)).toEqual({ kind: 'ahead', nextSequence: 4 });
  });
});

describe('copyChangeOf', () => {
  it('opens the workspace when it was created', () => {
    expect(copyChangeOf({ type: 'workspace.created' })).toEqual({ kind: 'open-workspace' });
  });

  it('puts the member with their role when they were added, or their role changed', () => {
    expect(copyChangeOf({ type: 'member.added', personId: 'person-dana', role: 'admin' })).toEqual(
      { kind: 'put-member', personId: 'person-dana', role: 'admin' },
    );
    expect(
      copyChangeOf({ type: 'member.role-changed', personId: 'person-dana', role: 'member' }),
    ).toEqual({ kind: 'put-member', personId: 'person-dana', role: 'member' });
  });

  it('drops the member when they were removed', () => {
    expect(copyChangeOf({ type: 'member.removed', personId: 'person-dana' })).toEqual({
      kind: 'drop-member',
      personId: 'person-dana',
    });
  });
});
