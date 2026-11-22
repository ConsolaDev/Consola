import { describe, expect, it } from 'vitest';
import { messageForTeamChange, messageForTeamProblem, messageForTeamsState } from './teamMessages';
import {
  addableTo,
  checkTeamName,
  isTeamProblem,
  memberOf,
  TEAM_NAME_MAX,
  type Team,
  type WorkspaceMember,
} from './teams';

const ada: WorkspaceMember = {
  id: 'p-ada',
  name: 'Ada',
  email: 'ada@acme.test',
  image: null,
  role: 'owner',
};
const bo: WorkspaceMember = {
  ...ada,
  id: 'p-bo',
  name: 'Bo',
  email: 'bo@acme.test',
  role: 'member',
};
const general: Team = { id: 't-1', name: 'General', first: true, memberIds: ['p-ada', 'p-gone'] };

describe('checkTeamName', () => {
  it('takes a name, trimmed', () => {
    expect(checkTeamName('  Platform ')).toEqual({ ok: true, name: 'Platform' });
  });

  it("names every problem the cell would, as the cell's rule does", () => {
    expect(checkTeamName(' ')).toEqual({ ok: false, problems: ['name_missing'] });
    expect(checkTeamName('🚀'.repeat(TEAM_NAME_MAX)).ok).toBe(true);
    // A tab at the end is trimmed away; one inside the name is not.
    expect(checkTeamName(`${'a'.repeat(TEAM_NAME_MAX)}\tb`)).toEqual({
      ok: false,
      problems: ['name_too_long', 'name_invalid'],
    });
  });
});

describe('isTeamProblem', () => {
  it('is true only for the problems the cell names', () => {
    expect(isTeamProblem('name_missing')).toBe(true);
    expect(isTeamProblem('toString')).toBe(false);
    expect(isTeamProblem(7)).toBe(false);
  });
});

describe('memberOf', () => {
  it("names a team's member by the workspace's members, or by id when they are not listed", () => {
    expect(memberOf('p-ada', [ada, bo])).toEqual({ kind: 'member', member: ada });
    expect(memberOf('p-gone', [ada, bo])).toEqual({ kind: 'unknown', personId: 'p-gone' });
  });
});

describe('addableTo', () => {
  it('is the members not in the team, in the order they joined', () => {
    expect(addableTo(general, [ada, bo])).toEqual([bo]);
    expect(addableTo({ ...general, memberIds: ['p-ada', 'p-bo'] }, [ada, bo])).toEqual([]);
  });
});

describe('the sentences', () => {
  const acme = { name: 'Acme', region: 'eu' };

  it('say every problem at once', () => {
    expect(
      messageForTeamChange({ kind: 'invalid', problems: ['name_too_long', 'name_invalid'] }, acme),
    ).toBe(`${messageForTeamProblem('name_too_long')} ${messageForTeamProblem('name_invalid')}`);
  });

  it('say nothing for a change that went through', () => {
    expect(messageForTeamChange({ kind: 'changed' }, acme)).toBeNull();
  });

  it("name the workspace and its region when they can't be reached", () => {
    expect(messageForTeamsState({ kind: 'pending' }, acme)).toContain('Acme');
    expect(messageForTeamsState({ kind: 'unavailable' }, acme)).toContain('EU region');
  });
});
