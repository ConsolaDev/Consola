import { describe, expect, it } from 'vitest';
import {
  checkNewWorkspace,
  defaultActiveWorkspace,
  mayManageWorkspace,
  WORKSPACE_NAME_MAX,
  WORKSPACE_SLUG_MAX,
} from './workspace.js';

const acme = { name: 'Acme', slug: 'acme' };

describe('checkNewWorkspace', () => {
  it('takes a name and a slug', () => {
    expect(checkNewWorkspace(acme)).toEqual({
      ok: true,
      workspace: { name: 'Acme', slug: 'acme' },
    });
  });

  it('never names a region: the deployment gives one, whatever is sent', () => {
    const sent: Record<string, unknown> = { ...acme, region: 'us' };
    expect(checkNewWorkspace(sent)).toEqual({
      ok: true,
      workspace: { name: 'Acme', slug: 'acme' },
    });
  });

  it('trims the name', () => {
    expect(checkNewWorkspace({ ...acme, name: '  Acme Labs  ' })).toMatchObject({
      ok: true,
      workspace: { name: 'Acme Labs' },
    });
  });

  it('needs a name', () => {
    for (const name of ['', '   ', undefined, 7]) {
      expect(checkNewWorkspace({ ...acme, name })).toEqual({
        ok: false,
        problems: ['name_missing'],
      });
    }
  });

  it('refuses a name that is too long', () => {
    expect(checkNewWorkspace({ ...acme, name: 'a'.repeat(WORKSPACE_NAME_MAX) }).ok).toBe(true);
    expect(checkNewWorkspace({ ...acme, name: 'a'.repeat(WORKSPACE_NAME_MAX + 1) })).toEqual({
      ok: false,
      problems: ['name_too_long'],
    });
  });

  it('takes a slug of lowercase letters and digits, with single dashes between', () => {
    for (const slug of ['a', 'acme', 'acme-2', 'a-b-c', '42', 'x'.repeat(WORKSPACE_SLUG_MAX)]) {
      expect(checkNewWorkspace({ ...acme, slug }).ok).toBe(true);
    }
  });

  it('refuses any other slug', () => {
    for (const slug of [
      '',
      'Acme',
      'acme labs',
      'acme_labs',
      '-acme',
      'acme-',
      'acme--labs',
      'açme',
      'x'.repeat(WORKSPACE_SLUG_MAX + 1),
      undefined,
      ['acme'],
    ]) {
      expect(checkNewWorkspace({ ...acme, slug })).toEqual({
        ok: false,
        problems: ['slug_invalid'],
      });
    }
  });

  it('names every problem at once', () => {
    expect(checkNewWorkspace({})).toEqual({
      ok: false,
      problems: ['name_missing', 'slug_invalid'],
    });
  });
});

describe('defaultActiveWorkspace', () => {
  it('is the workspace last active, while the person is still in it', () => {
    expect(defaultActiveWorkspace({ lastActive: 'w2', memberOf: ['w1', 'w2'] })).toBe('w2');
  });

  it('is the first workspace joined when none was active', () => {
    expect(defaultActiveWorkspace({ lastActive: null, memberOf: ['w1', 'w2'] })).toBe('w1');
  });

  it('is the first workspace joined when the person left the last active one', () => {
    expect(defaultActiveWorkspace({ lastActive: 'gone', memberOf: ['w1', 'w2'] })).toBe('w1');
  });

  it('is none for someone in no workspace', () => {
    expect(defaultActiveWorkspace({ lastActive: 'gone', memberOf: [] })).toBeNull();
    expect(defaultActiveWorkspace({ lastActive: null, memberOf: [] })).toBeNull();
  });
});

describe('mayManageWorkspace', () => {
  it('is its owners and admins, not its members', () => {
    expect(mayManageWorkspace('owner')).toBe(true);
    expect(mayManageWorkspace('admin')).toBe(true);
    expect(mayManageWorkspace('member')).toBe(false);
  });
});
