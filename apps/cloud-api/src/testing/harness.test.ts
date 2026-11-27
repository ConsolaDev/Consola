import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApi } from './harness.js';
import type { Harness } from './harness.js';

let harness: Harness;

beforeEach(async () => {
  harness = await startApi();
});

afterEach(async () => {
  await harness.close();
});

/** The teams the page's request reads, as status and body. */
async function teamsOf(headers: Headers) {
  const response = await harness.app.request('/api/teams', { headers });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe('the harness', () => {
  it("makes an admin who lists the workspace's teams, its first one among them", async () => {
    const admin = await harness.member('admin');
    expect(await teamsOf(admin.headers)).toEqual({
      status: 200,
      body: {
        canManage: true,
        teams: [
          { id: expect.any(String), name: 'General', first: true, memberIds: [admin.personId] },
        ],
      },
    });
  });

  it('puts another person in an existing workspace, with it active', async () => {
    const owner = await harness.member('owner');
    const member = await harness.member('member', { workspace: owner.workspaceId });
    expect(member.workspaceId).toBe(owner.workspaceId);
    // A member sees only the teams they are in, and no route has put them in one yet.
    expect(await teamsOf(member.headers)).toEqual({
      status: 200,
      body: { canManage: false, teams: [] },
    });
  });

  it('changes a role, and removes a member, for the very next request', async () => {
    const person = await harness.member('owner');
    await harness.setRole(person.personId, person.workspaceId, 'member');
    expect((await teamsOf(person.headers)).body).toMatchObject({ canManage: false });
    await harness.removeMember(person.personId, person.workspaceId);
    expect(await teamsOf(person.headers)).toEqual({
      status: 403,
      body: { error: 'not_a_member' },
    });
  });

  it('signs a person in, with a cookie and no workspace', async () => {
    const dana = await harness.signIn('dana@acme.test', 'Dana Ortiz');
    const me = await harness.app.request('/api/me', { headers: { cookie: dana.cookie } });
    expect(await me.json()).toMatchObject({ user: { id: dana.personId }, workspace: null });
  });
});
