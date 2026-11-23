import { describe, expect, it } from 'vitest';
import type { Factory } from './factories';
import { FACTORY_PAGE_LABELS, foldLabel } from './factoryMessages';
import {
  FACTORY_HUES,
  FACTORY_PAGES,
  factoryHue,
  factoryLanding,
  factoryRouteOfHash,
  hashOfFactoryPage,
  isUnfolded,
  readUnfoldedText,
  unfoldedText,
  withFold,
} from './factoryNav';
import { sectionIdOfHash } from './sections';

const factory = (id: string): Factory => ({
  id,
  name: `Factory ${id}`,
  teamId: 't-1',
  source: { kind: 'stored' },
  latestVersion: 1,
  updatedAt: '2026-11-22T10:00:00.000Z',
});

describe("a factory's pages", () => {
  it('are its definition, then its settings, each with a label', () => {
    expect(FACTORY_PAGES).toEqual(['definition', 'settings']);
    expect(FACTORY_PAGES.map((page) => FACTORY_PAGE_LABELS[page])).toEqual([
      'Factory definition',
      'Settings',
    ]);
  });
});

describe('the address of a factory page', () => {
  it('is #/factories/<id>/<page>, its first page when none is named', () => {
    expect(hashOfFactoryPage('f-1', 'settings')).toBe('#/factories/f-1/settings');
    expect(hashOfFactoryPage('f-1')).toBe('#/factories/f-1/definition');
  });

  it('reads back what it writes, any id included', () => {
    for (const id of ['f-1', 'a b/c?d', '9b7c…']) {
      for (const page of FACTORY_PAGES) {
        expect(factoryRouteOfHash(hashOfFactoryPage(id, page))).toEqual({
          kind: 'page',
          factoryId: id,
          page,
        });
      }
    }
  });

  it("opens a factory's first page for no page, or one this build does not have", () => {
    for (const hash of ['#/factories/f-1', '#/factories/f-1/', '#/factories/f-1/runs']) {
      expect(factoryRouteOfHash(hash), hash).toEqual({
        kind: 'page',
        factoryId: 'f-1',
        page: 'definition',
      });
    }
  });

  it('ignores what follows the page', () => {
    expect(factoryRouteOfHash('#/factories/f-1/settings/x')).toEqual({
      kind: 'page',
      factoryId: 'f-1',
      page: 'settings',
    });
    expect(factoryRouteOfHash('#/factories/f-1/settings?tab=team')).toMatchObject({
      page: 'settings',
    });
  });

  it('lands for #/factories alone, or an id it cannot read', () => {
    for (const hash of ['#/factories', '#/factories/', '#/factories?x', '#/factories/%E0']) {
      expect(factoryRouteOfHash(hash), hash).toEqual({ kind: 'landing' });
    }
  });

  it('is none outside the factories', () => {
    for (const hash of ['', '#/overview', '#/settings/teams', '#/factoriesx', '#/teams/f-1']) {
      expect(factoryRouteOfHash(hash), hash).toBeNull();
    }
  });

  it('names the factories where a section would be, which the dashboard lists as none', () => {
    expect(sectionIdOfHash(hashOfFactoryPage('f-1'))).toBe('factories');
  });
});

describe('where #/factories lands', () => {
  it("is the first factory's definition, as the cell lists them", () => {
    expect(factoryLanding([factory('f-2'), factory('f-1')])).toBe('#/factories/f-2/definition');
  });

  it('is none without a factory, which the page sends to Overview', () => {
    expect(factoryLanding([])).toBeNull();
  });
});

describe('folding', () => {
  it('shows every factory as the person left it, the open one included', () => {
    expect(isUnfolded('f-1', ['f-1'])).toBe(true);
    expect(isUnfolded('f-2', ['f-1', 'f-2'])).toBe(true);
    expect(isUnfolded('f-3', ['f-2'])).toBe(false);
    expect(isUnfolded('f-1', [])).toBe(false);
  });

  it('unfolds and folds one factory, keeping the rest', () => {
    expect(withFold(['f-1'], 'f-2', true)).toEqual(['f-1', 'f-2']);
    expect(withFold(['f-1', 'f-2'], 'f-2', true)).toEqual(['f-1', 'f-2']);
    expect(withFold(['f-1', 'f-2'], 'f-1', false)).toEqual(['f-2']);
    expect(withFold([], 'f-1', false)).toEqual([]);
  });

  it('reads back what it stores', () => {
    expect(readUnfoldedText(unfoldedText(['f-1', 'f-2']))).toEqual(['f-1', 'f-2']);
  });

  it('reads anything else stored as nothing unfolded', () => {
    for (const text of [null, '', 'nope', '{"f-1":true}', '42']) {
      expect(readUnfoldedText(text), String(text)).toEqual([]);
    }
    expect(readUnfoldedText('["f-1", 7, null, "f-2"]')).toEqual(['f-1', 'f-2']);
  });

  it('keeps only the most recent, so storage never grows without end', () => {
    const many = Array.from({ length: 250 }, (_, index) => `f-${index}`);
    const kept = readUnfoldedText(unfoldedText(many));
    expect(kept).toHaveLength(200);
    expect(kept.at(-1)).toBe('f-249');
  });

  it("labels the chevron with the factory's name and what it does", () => {
    expect(foldLabel('Releases', false)).toBe('Show Releases’s sections');
    expect(foldLabel('Releases', true)).toBe('Hide Releases’s sections');
  });
});

describe("a factory's tile", () => {
  it('wears one of the colours, the same for its id every time', () => {
    const hue = factoryHue('f-1');
    expect(FACTORY_HUES).toContain(hue);
    expect(factoryHue('f-1')).toBe(hue);
  });

  it('spreads factories across the colours', () => {
    const ids = Array.from({ length: 60 }, (_, index) => `factory-${index}`);
    expect(new Set(ids.map(factoryHue)).size).toBeGreaterThan(5);
  });
});
