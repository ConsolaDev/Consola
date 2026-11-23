import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  emojiOf,
  iconLabel,
  iconsMatching,
  WORKSPACE_EMOJIS,
  WORKSPACE_SYMBOLS,
  type WorkspaceIcon,
  workspaceInitial,
} from './workspaceIcons';

type Listed = (typeof WORKSPACE_SYMBOLS)[number][0] | (typeof WORKSPACE_EMOJIS)[number][0];

describe('the workspace icons', () => {
  // Checked as the app typechecks: the page lists exactly the icons the API's contract names, so
  // an icon the API gains fails here until the page can draw it.
  it("hold exactly the contract's icons", () => {
    expectTypeOf<Listed>().toEqualTypeOf<WorkspaceIcon>();
  });

  it('list each icon once, symbols first, as the desktop does', () => {
    const ids = [...WORKSPACE_SYMBOLS, ...WORKSPACE_EMOJIS].map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 2)).toEqual(['layout', 'briefcase']);
    expect(ids.slice(-1)).toEqual(['emoji-unicorn']);
  });

  it('name an emoji by its glyph, and a symbol by none', () => {
    expect(emojiOf('emoji-fox')).toBe('🦊');
    expect(emojiOf('compass')).toBeNull();
    expect(iconLabel('flask')).toBe('Experiments');
    expect(iconLabel('emoji-bulb')).toBe('Ideas');
  });

  it('find icons by label, whatever the case', () => {
    expect(iconsMatching(WORKSPACE_SYMBOLS, ' MOON ').map(([id]) => id)).toEqual(['moon']);
    expect(iconsMatching(WORKSPACE_EMOJIS, 'o').length).toBeGreaterThan(5);
    expect(iconsMatching(WORKSPACE_SYMBOLS, '')).toHaveLength(WORKSPACE_SYMBOLS.length);
    expect(iconsMatching(WORKSPACE_EMOJIS, 'zebra')).toEqual([]);
  });
});

describe('workspaceInitial', () => {
  it("is the name's first letter, capitalised", () => {
    expect(workspaceInitial('sprocket')).toBe('S');
    expect(workspaceInitial('  ñandú ')).toBe('Ñ');
    expect(workspaceInitial('𝒜tlas')).toBe('𝒜');
    expect(workspaceInitial('')).toBe('?');
  });
});
