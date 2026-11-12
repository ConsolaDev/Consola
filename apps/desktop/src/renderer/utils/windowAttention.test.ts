import { describe, expect, it } from 'vitest';
import { isLookedAt } from './windowAttention';

const view = (visibilityState: DocumentVisibilityState, focused: boolean) => ({
  visibilityState,
  hasFocus: () => focused,
});

describe('isLookedAt', () => {
  it('is true only for a shown window with focus', () => {
    expect(isLookedAt(view('visible', true))).toBe(true);
  });

  it('is false for a window behind another app or beside the one being worked in', () => {
    expect(isLookedAt(view('visible', false))).toBe(false);
  });

  it('is false for a minimized or hidden window, focused or not', () => {
    expect(isLookedAt(view('hidden', true))).toBe(false);
    expect(isLookedAt(view('hidden', false))).toBe(false);
  });
});
