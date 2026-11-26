import { WORKSPACE_ROLES } from '../../shared/workspaceRole.js';
import { describe, expect, it } from 'vitest';
import { checkTeamName, mayManageTeams, TEAM_NAME_MAX, teamsSeenBy } from './team.js';
import type { Team } from './team.js';

describe('checkTeamName', () => {
  it('takes a name, trimmed', () => {
    expect(checkTeamName('  Platform  ')).toEqual({ ok: true, name: 'Platform' });
    expect(checkTeamName('Équipe données')).toEqual({ ok: true, name: 'Équipe données' });
  });

  it('refuses a name with nothing in it', () => {
    for (const name of ['', '   ', '\t\n']) {
      expect(checkTeamName(name)).toEqual({ ok: false, problems: ['name_missing'] });
    }
  });

  it('counts characters, not code units, up to the limit', () => {
    expect(checkTeamName('a'.repeat(TEAM_NAME_MAX)).ok).toBe(true);
    expect(checkTeamName('🚀'.repeat(TEAM_NAME_MAX)).ok).toBe(true);
    expect(checkTeamName('a'.repeat(TEAM_NAME_MAX + 1))).toEqual({
      ok: false,
      problems: ['name_too_long'],
    });
  });

  it('refuses a control character inside the name, and names every problem at once', () => {
    expect(checkTeamName('Plat\nform')).toEqual({ ok: false, problems: ['name_invalid'] });
    expect(checkTeamName(`${'a'.repeat(TEAM_NAME_MAX)}\u0007`)).toEqual({
      ok: false,
      problems: ['name_too_long', 'name_invalid'],
    });
  });
});

describe('mayManageTeams', () => {
  it('is for owners and admins only', () => {
    expect(WORKSPACE_ROLES.filter(mayManageTeams)).toEqual(['owner', 'admin']);
  });
});

describe('teamsSeenBy', () => {
  const general: Team = { id: 't1', name: 'General', first: true, memberIds: ['ada', 'bo'] };
  const platform: Team = { id: 't2', name: 'Platform', first: false, memberIds: ['bo'] };
  const teams = [general, platform];

  it('is every team for those who manage teams', () => {
    expect(teamsSeenBy({ personId: 'cy', role: 'owner' }, teams)).toEqual(teams);
    expect(teamsSeenBy({ personId: 'cy', role: 'admin' }, teams)).toEqual(teams);
  });

  it('is the teams a member is in, for a member', () => {
    expect(teamsSeenBy({ personId: 'ada', role: 'member' }, teams)).toEqual([general]);
    expect(teamsSeenBy({ personId: 'cy', role: 'member' }, teams)).toEqual([]);
  });
});
