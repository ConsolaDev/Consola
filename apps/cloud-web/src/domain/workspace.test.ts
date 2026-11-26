import { describe, expect, expectTypeOf, it } from 'vitest';
import type { components } from './apiContract';
import {
  checkNewWorkspace,
  isRegion,
  isWorkspaceProblem,
  NEW_DRAFT,
  REGIONS,
  regionName,
  regionPlace,
  roleName,
  suggestSlug,
  WORKSPACE_NAME_MAX,
  WORKSPACE_SLUG_MAX,
  withName,
  withSlug,
} from './workspace';
import type { NewWorkspace, Region, WorkspaceProblem } from './workspace';

const acme = { name: 'Acme', slug: 'acme', region: 'eu' };

type Schemas = components['schemas'];

// Checked as the app typechecks: the page's own copies hold exactly what the API's contract
// does, so a region or a problem the API gains fails here until the page names it.
describe("the API's contract", () => {
  it('has the regions the page lists', () => {
    expectTypeOf<Region>().toEqualTypeOf<Schemas['MyWorkspace']['region']>();
    expectTypeOf<Region>().toEqualTypeOf<Schemas['NewWorkspace']['region']>();
  });

  it('has the problems the page knows', () => {
    expectTypeOf<WorkspaceProblem>().toEqualTypeOf<
      Schemas['InvalidWorkspace']['problems'][number]
    >();
  });

  it('takes the new workspace the page sends', () => {
    expectTypeOf<NewWorkspace>().toEqualTypeOf<Schemas['NewWorkspace']>();
  });
});

describe('the regions', () => {
  it('are the EU and the US, in that order', () => {
    expect(REGIONS.map((region) => region.id)).toEqual(['eu', 'us']);
  });

  it('isRegion accepts only a listed region', () => {
    expect(isRegion('eu')).toBe(true);
    expect(isRegion('us')).toBe(true);
    for (const value of ['EU', 'ap', '', null, undefined, 7]) expect(isRegion(value)).toBe(false);
  });

  it('regionName names a listed region, and shows any other as the server sent it', () => {
    expect(regionName('eu')).toBe('EU');
    expect(regionName('us')).toBe('US');
    expect(regionName('ap')).toBe('ap');
  });

  it('regionPlace says where a listed region is, and nothing for any other', () => {
    expect(regionPlace('eu')).toBe('Europe');
    expect(regionPlace('us')).toBe('United States');
    expect(regionPlace('ap')).toBeNull();
  });
});

describe('roleName', () => {
  it('names each role, and shows any other as the server sent it', () => {
    expect(roleName('owner')).toBe('Owner');
    expect(roleName('admin')).toBe('Admin');
    expect(roleName('member')).toBe('Member');
    expect(roleName('auditor')).toBe('auditor');
  });
});

describe('isWorkspaceProblem', () => {
  it('accepts only a problem the server names', () => {
    for (const problem of ['name_missing', 'name_too_long', 'slug_invalid', 'region_unknown']) {
      expect(isWorkspaceProblem(problem)).toBe(true);
    }
    for (const value of ['slug_taken', '', null, 3]) expect(isWorkspaceProblem(value)).toBe(false);
  });
});

// The same cases as cloud-global's own checkNewWorkspace, which stays the authority.
describe('checkNewWorkspace', () => {
  it('takes a name, a slug and a listed region', () => {
    expect(checkNewWorkspace(acme)).toEqual({
      ok: true,
      workspace: { name: 'Acme', slug: 'acme', region: 'eu' },
    });
    expect(checkNewWorkspace({ name: 'Sprocket', slug: 'sprocket', region: 'us' })).toEqual({
      ok: true,
      workspace: { name: 'Sprocket', slug: 'sprocket', region: 'us' },
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

  it('refuses a region that is not listed, or none', () => {
    for (const region of ['ap', 'EU', '', undefined, null]) {
      expect(checkNewWorkspace({ ...acme, region })).toEqual({
        ok: false,
        problems: ['region_unknown'],
      });
    }
  });

  it('names every problem at once', () => {
    expect(checkNewWorkspace({})).toEqual({
      ok: false,
      problems: ['name_missing', 'slug_invalid', 'region_unknown'],
    });
  });
});

describe('suggestSlug', () => {
  it('lowercases the name and joins its words with single dashes', () => {
    expect(suggestSlug('Acme')).toBe('acme');
    expect(suggestSlug('Sprocket Labs')).toBe('sprocket-labs');
    expect(suggestSlug('  Acme   Robotics, EU team ')).toBe('acme-robotics-eu-team');
    expect(suggestSlug('Acme_2 -- R&D')).toBe('acme-2-r-d');
  });

  it('drops accents and spells out letters that have none', () => {
    expect(suggestSlug('Café Ñandú')).toBe('cafe-nandu');
    expect(suggestSlug('Straße Œuvre Ærø Łódź')).toBe('strasse-oeuvre-aero-lodz');
    expect(suggestSlug('İstanbul')).toBe('istanbul');
  });

  it('is empty when the name has no letter or digit it can use', () => {
    expect(suggestSlug('')).toBe('');
    expect(suggestSlug('  ')).toBe('');
    expect(suggestSlug('日本')).toBe('');
    expect(suggestSlug('🚀 Acme')).toBe('acme');
  });

  it('stops at a whole word within the longest slug allowed', () => {
    const name = 'Acme '.repeat(20);
    const slug = suggestSlug(name);
    expect(slug.length).toBeLessThanOrEqual(WORKSPACE_SLUG_MAX);
    expect(slug).toBe(Array.from({ length: 9 }, () => 'acme').join('-'));
  });

  it('cuts a single word that is longer than the longest slug allowed', () => {
    expect(suggestSlug('a'.repeat(60))).toBe('a'.repeat(WORKSPACE_SLUG_MAX));
  });

  it('always suggests a slug the check accepts, or none', () => {
    for (const name of ['Acme', 'Sprocket Labs', 'Café Ñandú', 'x'.repeat(60), '-a-', 'Acme 2']) {
      expect(checkNewWorkspace({ name, slug: suggestSlug(name), region: 'eu' }).ok).toBe(true);
    }
  });
});

describe('a draft workspace', () => {
  it('starts empty, with no region picked', () => {
    expect(NEW_DRAFT).toEqual({ name: '', slug: '', region: null, slugEdited: false });
  });

  it('suggests the slug from the name while the person has not typed one', () => {
    const draft = withName(withName(NEW_DRAFT, 'Acme'), 'Acme Labs');
    expect(draft).toMatchObject({ name: 'Acme Labs', slug: 'acme-labs', slugEdited: false });
  });

  it('keeps a slug the person typed when the name changes', () => {
    const draft = withName(withSlug(withName(NEW_DRAFT, 'Acme'), 'acme-eu'), 'Acme Europe');
    expect(draft).toMatchObject({ name: 'Acme Europe', slug: 'acme-eu', slugEdited: true });
  });

  it('lowercases a typed slug', () => {
    expect(withSlug(NEW_DRAFT, 'Acme-EU').slug).toBe('acme-eu');
  });

  it('hands the slug back to the name once the person empties it', () => {
    const emptied = withSlug(withSlug(withName(NEW_DRAFT, 'Acme'), 'mine'), '');
    expect(emptied).toMatchObject({ slug: '', slugEdited: false });
    expect(withName(emptied, 'Acme Labs').slug).toBe('acme-labs');
  });
});
