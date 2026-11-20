/**
 * A key an agent asks to press, as the page's key events carry it.
 *
 * The agent names keys the way Playwright does (`Enter`, `Shift+Tab`,
 * `Control+A`), but the key is never sent through the browser: Chromium hands
 * a guest's CDP keys to whatever the window has focused (`cdpRelayProtocol`).
 * The page gets these fields as synthetic key events instead (`pageInput`).
 */
export interface KeyPress {
  /** `KeyboardEvent.key`. */
  key: string;
  /** `KeyboardEvent.code`; empty for a character with no key of its own. */
  code: string;
  /** The legacy `keyCode`, which older handlers still read; 0 when it has none. */
  keyCode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** The character it types, when it types one (no Control, Alt or Meta held). */
  text?: string;
}

const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
for (let n = 1; n <= 12; n++)
  NAMED_KEYS[`f${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };

type Modifier = 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey';

function modifierOf(name: string, platform: string): Modifier | null {
  switch (name.toLowerCase()) {
    case 'control':
    case 'ctrl':
      return 'ctrlKey';
    case 'shift':
      return 'shiftKey';
    case 'alt':
    case 'option':
      return 'altKey';
    case 'meta':
    case 'command':
    case 'cmd':
      return 'metaKey';
    case 'controlormeta':
      return platform === 'darwin' ? 'metaKey' : 'ctrlKey';
    default:
      return null;
  }
}

function characterKey(character: string): { key: string; code: string; keyCode: number } {
  if (/^[a-z]$/i.test(character)) {
    const upper = character.toUpperCase();
    return { key: character, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(character)) {
    return { key: character, code: `Digit${character}`, keyCode: character.charCodeAt(0) };
  }
  return { key: character, code: '', keyCode: 0 };
}

/**
 * Reads a key or chord (`Enter`, `a`, `Shift+Tab`, `Control+A`). Throws, with
 * what it takes, for anything else.
 */
export function parseKeyPress(spec: string, platform: string = process.platform): KeyPress {
  const refuse = (): never => {
    throw new Error(
      `Unknown key "${spec}". Use a key name such as Enter, Tab, Escape, Backspace, ArrowDown ` +
        'or Home, a single character, or a chord like Shift+Tab or Control+A.',
    );
  };
  // A chord's last part is its key; "+" alone, or ending a chord, is the plus key.
  const parts =
    spec === '+'
      ? ['+']
      : spec.endsWith('++')
        ? [...spec.slice(0, -2).split('+'), '+']
        : spec.split('+');
  const name = parts.pop() ?? '';
  const held: Record<Modifier, boolean> = {
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  };
  for (const part of parts) {
    const modifier = modifierOf(part, platform);
    if (!modifier) refuse();
    else held[modifier] = true;
  }
  const named = NAMED_KEYS[name.toLowerCase()];
  let base: { key: string; code: string; keyCode: number; text?: string };
  if (named && name.length > 1) base = named;
  else if ([...name].length === 1) {
    const character = held.shiftKey && /^[a-z]$/.test(name) ? name.toUpperCase() : name;
    base = { ...characterKey(character), text: character };
  } else return refuse();

  const typesText = base.text !== undefined && !held.ctrlKey && !held.altKey && !held.metaKey;
  const { text, ...rest } = base;
  return { ...rest, ...held, ...(typesText ? { text } : {}) };
}
