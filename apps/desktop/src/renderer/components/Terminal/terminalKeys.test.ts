import { describe, expect, it } from 'vitest';
import { terminalKeyOverride } from './terminalKeys';

/** A keyboard event shaped like the ones xterm hands its custom key handler. */
function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown',
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...init,
  } as KeyboardEvent;
}

describe('terminalKeyOverride', () => {
  it('sends ESC+CR for Shift+Enter, the sequence the CLI reads as a newline', () => {
    expect(terminalKeyOverride(keyEvent({ shiftKey: true }))).toBe('\x1b\r');
  });

  it('applies on keypress and keyup too, so xterm never adds its own CR behind it', () => {
    expect(terminalKeyOverride(keyEvent({ type: 'keypress', shiftKey: true }))).toBe('\x1b\r');
    expect(terminalKeyOverride(keyEvent({ type: 'keyup', shiftKey: true }))).toBe('\x1b\r');
  });

  it('leaves a bare Enter alone, so it still submits', () => {
    expect(terminalKeyOverride(keyEvent({}))).toBeNull();
  });

  it('leaves Option+Enter alone: xterm already sends ESC+CR for it', () => {
    expect(terminalKeyOverride(keyEvent({ altKey: true }))).toBeNull();
  });

  it('leaves Enter carrying an application modifier alone', () => {
    expect(terminalKeyOverride(keyEvent({ shiftKey: true, metaKey: true }))).toBeNull();
    expect(terminalKeyOverride(keyEvent({ shiftKey: true, ctrlKey: true }))).toBeNull();
    expect(terminalKeyOverride(keyEvent({ shiftKey: true, altKey: true }))).toBeNull();
  });

  it('leaves other shifted keys alone', () => {
    expect(terminalKeyOverride(keyEvent({ key: 'A', shiftKey: true }))).toBeNull();
  });
});
