import { describe, expect, it } from 'vitest';
import { createTeamsService } from './teams';

const ACME = { id: 'ws-acme' };
const general = { id: 't-1', name: 'General', first: true, memberIds: ['p-ada'] };
const ada = { id: 'p-ada', name: 'Ada', email: 'ada@acme.test', image: null, role: 'owner' };

type Answer = { status: number; body?: unknown };
type Seen = { method: string; url: string; workspace: string | null; body: string };

const json = ({ status, body }: Answer) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });

/**
 * A service against a stand-in for the API, which answers each route by `METHOD path` and
 * records every request; the workspace's members are Ada unless a test says otherwise.
 */
function harness(routes: Record<string, Answer | ((seen: Seen) => Answer)> = {}) {
  const seen: Seen[] = [];
  const service = createTeamsService({
    baseUrl: 'http://web.test',
    fetch: async (request) => {
      const entry = {
        method: request.method,
        url: request.url,
        workspace: request.headers.get('x-consola-workspace'),
        body: await request.text(),
      };
      seen.push(entry);
      const route = `${entry.method} ${new URL(entry.url).pathname}`;
      const answer =
        routes[route] ??
        (route === 'GET /api/me/workspace/members'
          ? { status: 200, body: { members: [ada] } }
          : undefined);
      if (!answer) return json({ status: 404, body: { error: 'not_found' } });
      return json(typeof answer === 'function' ? answer(entry) : answer);
    },
  });
  return { service, seen };
}

const listed = { status: 200, body: { teams: [general], canManage: true } };

describe('loadTeams', () => {
  it('reads the teams and the members, each naming the workspace the page shows', async () => {
    const { service, seen } = harness({ 'GET /api/teams': listed });
    expect(await service.loadTeams(ACME)).toEqual({
      kind: 'listed',
      teams: [general],
      canManage: true,
      members: [ada],
    });
    // The two reads go at once, so their order is the network's.
    expect(
      seen
        .map(({ method, url, workspace }) => [method, new URL(url).pathname, workspace])
        .sort(([, a], [, b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ['GET', '/api/me/workspace/members', 'ws-acme'],
      ['GET', '/api/teams', 'ws-acme'],
    ]);
  });

  it('is switched when the session has another workspace open, none, or one the person left', async () => {
    for (const answer of [
      { status: 409, body: { error: 'workspace_switched' } },
      { status: 409, body: { error: 'no_active_workspace' } },
      { status: 403, body: { error: 'not_a_member' } },
    ]) {
      const { service } = harness({ 'GET /api/teams': answer });
      expect(await service.loadTeams(ACME), JSON.stringify(answer)).toEqual({ kind: 'switched' });
    }
    const membersRefused = harness({
      'GET /api/teams': listed,
      'GET /api/me/workspace/members': { status: 403, body: { error: 'not_a_member' } },
    });
    expect(await membersRefused.service.loadTeams(ACME)).toEqual({ kind: 'switched' });
  });

  it('is signed out only on a 401, and unavailable for anything else', async () => {
    const signedOut = harness({ 'GET /api/teams': { status: 401, body: { error: 'signed_out' } } });
    expect(await signedOut.service.loadTeams(ACME)).toEqual({ kind: 'signed-out' });

    for (const answer of [
      { status: 400, body: { error: 'invalid_request' } },
      { status: 409, body: { error: 'workspace_pending' } },
      { status: 403, body: { error: 'bad_origin' } },
      { status: 502 },
      { status: 200, body: { teams: 'none' } },
    ]) {
      const { service } = harness({ 'GET /api/teams': answer });
      expect(await service.loadTeams(ACME), JSON.stringify(answer)).toEqual({
        kind: 'unavailable',
      });
    }

    const noMembers = harness({
      'GET /api/teams': listed,
      'GET /api/me/workspace/members': { status: 500 },
    });
    expect(await noMembers.service.loadTeams(ACME)).toEqual({ kind: 'unavailable' });
  });

  it('is unavailable when the API cannot be reached', async () => {
    const service = createTeamsService({
      baseUrl: 'http://web.test',
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await service.loadTeams(ACME)).toEqual({ kind: 'unavailable' });
    expect(await service.createTeam(ACME, 'Platform')).toEqual({ kind: 'unavailable' });
  });
});

describe('changing teams', () => {
  it('sends each change for the workspace the page shows, and answers changed', async () => {
    const { service, seen } = harness({
      'POST /api/teams': { status: 201, body: { ...general, id: 't-2', first: false } },
      'PATCH /api/teams/t-2': { status: 200, body: { ...general, id: 't-2' } },
      'DELETE /api/teams/t-2': { status: 204 },
      'PUT /api/teams/t-1/members/p-bo': { status: 200, body: general },
      'DELETE /api/teams/t-1/members/p-bo': { status: 200, body: general },
    });
    expect(await service.createTeam(ACME, 'Platform')).toEqual({ kind: 'changed' });
    expect(await service.renameTeam(ACME, 't-2', 'Apps')).toEqual({ kind: 'changed' });
    expect(await service.deleteTeam(ACME, 't-2')).toEqual({ kind: 'changed' });
    expect(await service.addTeamMember(ACME, 't-1', 'p-bo')).toEqual({ kind: 'changed' });
    expect(await service.removeTeamMember(ACME, 't-1', 'p-bo')).toEqual({ kind: 'changed' });

    expect(
      seen.map(({ method, url, workspace, body }) => [
        method,
        new URL(url).pathname,
        workspace,
        body,
      ]),
    ).toEqual([
      ['POST', '/api/teams', 'ws-acme', '{"name":"Platform"}'],
      ['PATCH', '/api/teams/t-2', 'ws-acme', '{"name":"Apps"}'],
      ['DELETE', '/api/teams/t-2', 'ws-acme', ''],
      ['PUT', '/api/teams/t-1/members/p-bo', 'ws-acme', ''],
      ['DELETE', '/api/teams/t-1/members/p-bo', 'ws-acme', ''],
    ]);
  });

  it("answers in the page's terms for each refusal the API gives", async () => {
    const cases: Array<[Answer, unknown]> = [
      [
        { status: 400, body: { error: 'invalid_team', problems: ['name_missing', 'what'] } },
        { kind: 'invalid', problems: ['name_missing'] },
      ],
      [{ status: 409, body: { error: 'name_taken' } }, { kind: 'name-taken' }],
      [{ status: 403, body: { error: 'not_allowed' } }, { kind: 'not-allowed' }],
      [{ status: 404, body: { error: 'team_not_found' } }, { kind: 'not-found' }],
      [{ status: 409, body: { error: 'first_team' } }, { kind: 'first-team' }],
      [{ status: 409, body: { error: 'not_a_workspace_member' } }, { kind: 'not-a-member' }],
      [{ status: 409, body: { error: 'workspace_switched' } }, { kind: 'switched' }],
      [{ status: 403, body: { error: 'not_a_member' } }, { kind: 'switched' }],
      [{ status: 401, body: { error: 'signed_out' } }, { kind: 'signed-out' }],
      [{ status: 400, body: { error: 'invalid_request' } }, { kind: 'unavailable' }],
      [{ status: 403, body: { error: 'bad_origin' } }, { kind: 'unavailable' }],
      [{ status: 500 }, { kind: 'unavailable' }],
    ];
    for (const [answer, change] of cases) {
      const { service } = harness({ 'POST /api/teams': answer });
      expect(await service.createTeam(ACME, 'Platform'), JSON.stringify(answer)).toEqual(change);
    }
  });
});
