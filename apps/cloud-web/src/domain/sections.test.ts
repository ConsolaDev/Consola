import { describe, expect, it } from 'vitest';
import { chooseSection, hashOfSection, sectionIdOfHash } from './sections';

describe('sectionIdOfHash', () => {
  it('reads the id a hash names', () => {
    expect(sectionIdOfHash('#/teams')).toBe('teams');
    expect(sectionIdOfHash('#/github-connections')).toBe('github-connections');
  });

  it('ignores what follows the id, after a slash or a question mark', () => {
    expect(sectionIdOfHash('#/connections?github=installed')).toBe('connections');
    expect(sectionIdOfHash('#/teams/team-1')).toBe('teams');
    expect(sectionIdOfHash('#/teams/')).toBe('teams');
  });

  it('is null for a hash that names no section', () => {
    for (const hash of [
      '',
      '#',
      '#/',
      '#teams',
      '#/Teams',
      '#/teams!',
      '#/-teams',
      '#/teams-',
      '#/a--b',
    ]) {
      expect(sectionIdOfHash(hash), hash).toBeNull();
    }
  });

  it('reads back the hash hashOfSection writes', () => {
    expect(sectionIdOfHash(hashOfSection('overview'))).toBe('overview');
  });
});

describe('chooseSection', () => {
  const sections: readonly [{ id: string }, ...{ id: string }[]] = [
    { id: 'overview' },
    { id: 'teams' },
  ];

  it('is the section wanted when it is listed', () => {
    expect(chooseSection(sections, 'teams')).toBe(sections[1]);
  });

  it('is the first when none is wanted, or one that is not listed', () => {
    expect(chooseSection(sections, null)).toBe(sections[0]);
    expect(chooseSection(sections, 'factories')).toBe(sections[0]);
  });
});
