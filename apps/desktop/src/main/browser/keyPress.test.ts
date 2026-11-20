import { describe, expect, it } from 'vitest';
import { parseKeyPress } from './keyPress';

const none = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };

describe('parseKeyPress', () => {
  it('reads a named key', () => {
    expect(parseKeyPress('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, ...none });
    expect(parseKeyPress('Tab')).toMatchObject({ key: 'Tab', keyCode: 9 });
    expect(parseKeyPress('Escape')).toMatchObject({ key: 'Escape', keyCode: 27 });
    expect(parseKeyPress('Esc')).toMatchObject({ key: 'Escape' });
    expect(parseKeyPress('ArrowDown')).toMatchObject({ key: 'ArrowDown', code: 'ArrowDown' });
    expect(parseKeyPress('Backspace')).toMatchObject({ key: 'Backspace', keyCode: 8 });
    expect(parseKeyPress('PageDown')).toMatchObject({ key: 'PageDown', keyCode: 34 });
    expect(parseKeyPress('F5')).toMatchObject({ key: 'F5', code: 'F5', keyCode: 116 });
  });

  it('reads a character as the text it types', () => {
    expect(parseKeyPress('a')).toEqual({
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      text: 'a',
      ...none,
    });
    expect(parseKeyPress('7')).toMatchObject({ key: '7', code: 'Digit7', keyCode: 55, text: '7' });
    expect(parseKeyPress('.')).toMatchObject({ key: '.', text: '.' });
    expect(parseKeyPress('Space')).toMatchObject({
      key: ' ',
      code: 'Space',
      keyCode: 32,
      text: ' ',
    });
  });

  it('reads a chord, its modifiers in any case and spelling', () => {
    expect(parseKeyPress('Shift+Tab')).toMatchObject({ key: 'Tab', shiftKey: true });
    expect(parseKeyPress('Control+a')).toEqual({
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      ...none,
      ctrlKey: true,
    });
    expect(parseKeyPress('ctrl+Alt+Delete')).toMatchObject({
      key: 'Delete',
      ctrlKey: true,
      altKey: true,
    });
    expect(parseKeyPress('Meta+K')).toMatchObject({ key: 'K', metaKey: true });
    expect(parseKeyPress('Cmd+a')).toMatchObject({ metaKey: true });
    // Shift on a letter types the capital.
    expect(parseKeyPress('Shift+a')).toMatchObject({ key: 'A', text: 'A', shiftKey: true });
  });

  it('reads ControlOrMeta as the platform’s own', () => {
    expect(parseKeyPress('ControlOrMeta+a', 'darwin')).toMatchObject({
      metaKey: true,
      ctrlKey: false,
    });
    expect(parseKeyPress('ControlOrMeta+a', 'linux')).toMatchObject({
      ctrlKey: true,
      metaKey: false,
    });
  });

  it('never types text under Control, Alt or Meta', () => {
    expect(parseKeyPress('Control+a').text).toBeUndefined();
    expect(parseKeyPress('Alt+x').text).toBeUndefined();
  });

  it.each([[''], ['Foo'], ['Control+'], ['Super+a'], ['ab'], ['Shift']])(
    'refuses %j, saying what it takes',
    (spec) => {
      expect(() => parseKeyPress(spec)).toThrow(/Use a key name such as Enter/);
    },
  );
});
