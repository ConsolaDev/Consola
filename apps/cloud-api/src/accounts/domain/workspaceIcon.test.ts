import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWorkspaceIcon, isWorkspaceIcon, WORKSPACE_ICONS } from './workspaceIcon.js';

describe('the workspace icons', () => {
  it("are the desktop app's own ids, in its order", () => {
    // Read as text, never imported: no app imports another. A workspace known to both shows the
    // same icon in each only while the two lists agree.
    const desktop = readFileSync(
      new URL('../../../../desktop/src/shared/workspaceIcons.ts', import.meta.url),
      'utf8',
    );
    const ids = [...desktop.matchAll(/^\s*\['([a-z-]+)', '/gm)].map((match) => match[1]);
    expect(ids).toEqual([...WORKSPACE_ICONS]);
  });

  it('isWorkspaceIcon accepts only a listed id', () => {
    expect(isWorkspaceIcon('rocket')).toBe(true);
    expect(isWorkspaceIcon('emoji-fox')).toBe(true);
    for (const value of ['', 'Rocket', 'emoji-', 'https://example.test/logo.png', null, 7]) {
      expect(isWorkspaceIcon(value)).toBe(false);
    }
  });

  it('checkWorkspaceIcon takes a listed id, or null for none', () => {
    expect(checkWorkspaceIcon('leaf')).toEqual({ ok: true, icon: 'leaf' });
    expect(checkWorkspaceIcon(null)).toEqual({ ok: true, icon: null });
    for (const value of [undefined, '', 'unicorn', 3, {}]) {
      expect(checkWorkspaceIcon(value)).toEqual({ ok: false, problem: 'icon_unknown' });
    }
  });
});
