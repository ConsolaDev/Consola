import { describe, expect, it } from 'vitest';
import { createApi } from './api';
import { cellBaseUrl, createTeamsService } from './teams';

const ACME = { id: 'ws-acme' };
const general = { id: 't-1', name: 'General', first: true, memberIds: ['p-ada'] };
const ada = { id: 'p-ada', name: 'Ada', email: 'ada@acme.test', image: null, role: 'owner' };

type Answer = { status: number; body?: unknown };
type Seen = { method: string; url: string; authorization: string | null; body: string };

const json = ({ status, body }: Answer) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });

/**
 * A service against stand-ins: `global` answers cloud-global's routes and `cell` the cell's, each
 * by `METHOD path`, and every request is recorded. Tokens are minted `token-1`, `token-2`, …
 */
function harness(options: {
  global?: Record<string, Answer | (() => Answer)>;
  cell?: Record<string, Answer | ((seen: Seen) => Answer)>;
  workspaceId?: string;
  region?: string;
  now?: () => number;
}) {
  const seen: Seen[] = [];
  let minted = 0;
  const record = async (request: Request): Promise<Seen> => {
    const entry = {
      method: request.method,
      url: request.url,
      authorization: request.headers.get('authorization'),
      body: await request.text(),
    };
    seen.push(entry);
    return entry;
  };
  const globalFetch = async (request: Request) => {
    const entry = await record(request);
    const route = `${entry.method} ${new URL(entry.url).pathname}`;
    if (route === 'POST /api/cell-token' && !options.global?.[route]) {
      minted += 1;
      return json({
        status: 200,
        body: {
          token: `token-${minted}`,
          expiresAt: (options.now?.() ?? 1000) + 300,
          workspaceId: options.workspaceId ?? ACME.id,
          region: options.region ?? 'eu',
        },
      });
    }
    if (route === 'GET /api/me/workspace/members' && !options.global?.[route]) {
      return json({ status: 200, body: { members: [ada] } });
    }
    const answer = options.global?.[route];
    if (!answer) return json({ status: 404, body: { error: 'not_found' } });
    return json(typeof answer === 'function' ? answer() : answer);
  };
  const cellFetch = async (request: Request) => {
    const entry = await record(request);
    const route = `${entry.method} ${new URL(entry.url).pathname}`;
    const answer = options.cell?.[route];
    if (!answer) return json({ status: 404, body: { error: 'not_found' } });
    return json(typeof answer === 'function' ? answer(entry) : answer);
  };
  const service = createTeamsService({
    api: createApi({ baseUrl: 'http://web.test', fetch: globalFetch }),
    cellFetch,
    cellOrigin: 'http://web.test',
    nowSeconds: options.now ?? (() => 1000),
  });
  return { service, seen };
}

const listed = { status: 200, body: { teams: [general], canManage: true } };

describe('cellBaseUrl', () => {
  it("is the region's path on the page's origin", () => {
    expect(cellBaseUrl('eu')).toBe('/cell/eu');
    expect(cellBaseUrl('us', 'http://web.test')).toBe('http://web.test/cell/us');
  });
});

describe('loadTeams', () => {
  it("reads the teams from the workspace's own cell, with a token, and the members from cloud-global", async () => {
    const { service, seen } = harness({
      region: 'us',
      cell: { 'GET /cell/us/api/teams': listed },
    });
    expect(await service.loadTeams(ACME)).toEqual({
      kind: 'listed',
      teams: [general],
      canManage: true,
      members: [ada],
    });
    const toCell = seen.find((entry) => entry.url.includes('/cell/'));
    expect(toCell).toMatchObject({
      method: 'GET',
      url: 'http://web.test/cell/us/api/teams',
      authorization: 'Bearer token-1',
    });
    // cloud-global's calls carry no token: its own session is the cookie.
    expect(
      seen.filter((entry) => !entry.url.includes('/cell/')).map((e) => e.authorization),
    ).toEqual([null, null]);
  });

  it('keeps a token until shortly before it expires, then mints another', async () => {
    let now = 1000;
    const { service, seen } = harness({
      now: () => now,
      cell: { 'GET /cell/eu/api/teams': listed },
    });
    await service.loadTeams(ACME);
    await service.loadTeams(ACME);
    now += 280; // 20 seconds before it expires.
    await service.loadTeams(ACME);
    const tokens = seen
      .filter((entry) => entry.url.includes('/cell/'))
      .map((entry) => entry.authorization);
    expect(tokens).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-2']);
  });

  it('mints a token again once when the cell refuses one, and only once', async () => {
    const refused = { status: 401, body: { error: 'invalid_token' } };
    let calls = 0;
    const { service } = harness({
      cell: { 'GET /cell/eu/api/teams': () => (++calls === 1 ? refused : listed) },
    });
    expect((await service.loadTeams(ACME)).kind).toBe('listed');

    const stubborn = harness({ cell: { 'GET /cell/eu/api/teams': refused } });
    expect(await stubborn.service.loadTeams(ACME)).toEqual({ kind: 'unavailable' });
    expect(stubborn.seen.filter((entry) => entry.url.includes('/cell/'))).toHaveLength(2);
  });

  it('asks no cell when the token is for another workspace than the page shows', async () => {
    const { service, seen } = harness({
      workspaceId: 'ws-sprocket',
      cell: { 'GET /cell/eu/api/teams': listed },
    });
    expect(await service.loadTeams(ACME)).toEqual({ kind: 'switched' });
    expect(seen.some((entry) => entry.url.includes('/cell/'))).toBe(false);
  });

  it('is switched when the session has no workspace open, or one the person left', async () => {
    for (const error of ['no_active_workspace', 'not_a_member']) {
      const status = error === 'not_a_member' ? 403 : 409;
      const { service } = harness({
        global: { 'POST /api/cell-token': { status, body: { error } } },
      });
      expect(await service.loadTeams(ACME), error).toEqual({ kind: 'switched' });
    }
  });

  it('is pending while the cell does not hold the workspace yet', async () => {
    const { service } = harness({
      cell: { 'GET /cell/eu/api/teams': { status: 409, body: { error: 'workspace_pending' } } },
    });
    expect(await service.loadTeams(ACME)).toEqual({ kind: 'pending' });
  });

  it('is signed out only when cloud-global says so, and unavailable for anything else', async () => {
    const signedOut = harness({
      global: { 'POST /api/cell-token': { status: 401, body: { error: 'signed_out' } } },
    });
    expect(await signedOut.service.loadTeams(ACME)).toEqual({ kind: 'signed-out' });

    for (const answer of [
      { status: 503, body: { error: 'token_check_unavailable' } },
      { status: 421, body: { error: 'wrong_region', region: 'us' } },
      { status: 502 },
      { status: 200, body: { teams: 'none' } },
    ]) {
      const { service } = harness({ cell: { 'GET /cell/eu/api/teams': answer } });
      expect(await service.loadTeams(ACME), JSON.stringify(answer)).toEqual({
        kind: 'unavailable',
      });
    }
  });
});

describe('changing teams', () => {
  it('sends each change to the cell with its token, and answers changed', async () => {
    const { service, seen } = harness({
      cell: {
        'POST /cell/eu/api/teams': { status: 201, body: { ...general, id: 't-2', first: false } },
        'PATCH /cell/eu/api/teams/t-2': { status: 200, body: { ...general, id: 't-2' } },
        'DELETE /cell/eu/api/teams/t-2': { status: 204 },
        'PUT /cell/eu/api/teams/t-1/members/p-bo': { status: 200, body: general },
        'DELETE /cell/eu/api/teams/t-1/members/p-bo': { status: 200, body: general },
      },
    });
    expect(await service.createTeam(ACME, 'Platform')).toEqual({ kind: 'changed' });
    expect(await service.renameTeam(ACME, 't-2', 'Apps')).toEqual({ kind: 'changed' });
    expect(await service.deleteTeam(ACME, 't-2')).toEqual({ kind: 'changed' });
    expect(await service.addTeamMember(ACME, 't-1', 'p-bo')).toEqual({ kind: 'changed' });
    expect(await service.removeTeamMember(ACME, 't-1', 'p-bo')).toEqual({ kind: 'changed' });

    const toCell = seen.filter((entry) => entry.url.includes('/cell/'));
    expect(toCell.map(({ method, url, body }) => [method, new URL(url).pathname, body])).toEqual([
      ['POST', '/cell/eu/api/teams', '{"name":"Platform"}'],
      ['PATCH', '/cell/eu/api/teams/t-2', '{"name":"Apps"}'],
      ['DELETE', '/cell/eu/api/teams/t-2', ''],
      ['PUT', '/cell/eu/api/teams/t-1/members/p-bo', ''],
      ['DELETE', '/cell/eu/api/teams/t-1/members/p-bo', ''],
    ]);
    expect(new Set(toCell.map((entry) => entry.authorization))).toEqual(
      new Set(['Bearer token-1']),
    );
  });

  it("answers in the page's terms for each refusal the cell gives", async () => {
    const cases: [Answer, unknown][] = [
      [
        { status: 400, body: { error: 'invalid_team', problems: ['name_missing', 'what'] } },
        { kind: 'invalid', problems: ['name_missing'] },
      ],
      [{ status: 409, body: { error: 'name_taken' } }, { kind: 'name-taken' }],
      [{ status: 403, body: { error: 'not_allowed' } }, { kind: 'not-allowed' }],
      [{ status: 404, body: { error: 'team_not_found' } }, { kind: 'not-found' }],
      [{ status: 409, body: { error: 'first_team' } }, { kind: 'first-team' }],
      [{ status: 409, body: { error: 'not_a_workspace_member' } }, { kind: 'not-a-member' }],
      [{ status: 409, body: { error: 'workspace_pending' } }, { kind: 'pending' }],
      [{ status: 400, body: { error: 'invalid_request' } }, { kind: 'unavailable' }],
      [{ status: 500 }, { kind: 'unavailable' }],
    ];
    for (const [answer, change] of cases) {
      const { service } = harness({ cell: { 'POST /cell/eu/api/teams': answer } });
      expect(await service.createTeam(ACME, 'Platform'), JSON.stringify(answer)).toEqual(change);
    }
  });

  it('sends no change for a workspace the session no longer has open', async () => {
    const { service, seen } = harness({ workspaceId: 'ws-sprocket' });
    expect(await service.deleteTeam(ACME, 't-1')).toEqual({ kind: 'switched' });
    expect(seen.some((entry) => entry.url.includes('/cell/'))).toBe(false);
  });
});
