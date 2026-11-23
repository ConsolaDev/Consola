import { describe, expect, it } from 'vitest';
import type { Factory } from '../domain/factories';
import type { Team } from '../domain/teams';
import { createApi } from './api';
import { createFactoriesService } from './factories';

const ACME = { id: 'ws-acme' };
const general: Team = { id: 't-1', name: 'General', first: true, memberIds: ['p-ada'] };
const platform: Team = { id: 't-2', name: 'Platform', first: false, memberIds: ['p-bo'] };
const releases: Factory = {
  id: 'f-1',
  name: 'Releases',
  teamId: 't-1',
  source: { kind: 'stored' },
  latestVersion: 1,
  updatedAt: '2026-11-22T10:00:00.000Z',
};
const docs: Factory = { ...releases, id: 'f-2', name: 'Docs', teamId: 't-2', latestVersion: 3 };

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
  global?: Record<string, Answer>;
  cell?: Record<string, Answer | ((seen: Seen) => Answer)>;
  workspaceId?: string;
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
    const answer = options.global?.[route];
    if (answer) return json(answer);
    if (route === 'POST /api/cell-token') {
      minted += 1;
      return json({
        status: 200,
        body: {
          token: `token-${minted}`,
          expiresAt: 1300,
          workspaceId: options.workspaceId ?? ACME.id,
          region: 'eu',
        },
      });
    }
    return json({ status: 404, body: { error: 'not_found' } });
  };
  const cellFetch = async (request: Request) => {
    const entry = await record(request);
    const route = `${entry.method} ${new URL(entry.url).pathname}`;
    const answer = options.cell?.[route];
    if (!answer) return json({ status: 404, body: { error: 'not_found' } });
    return json(typeof answer === 'function' ? answer(entry) : answer);
  };
  const service = createFactoriesService({
    api: createApi({ baseUrl: 'http://web.test', fetch: globalFetch }),
    cellFetch,
    cellOrigin: 'http://web.test',
    nowSeconds: () => 1000,
  });
  const toCell = () => seen.filter((entry) => entry.url.includes('/cell/'));
  const mints = () => seen.filter((entry) => entry.url.endsWith('/api/cell-token'));
  return { service, seen, toCell, mints };
}

const LISTED = {
  'GET /cell/eu/api/factories': { status: 200, body: { factories: [docs, releases] } },
  'GET /cell/eu/api/teams': { status: 200, body: { teams: [general, platform], canManage: true } },
};

describe('loadFactories', () => {
  it('shows exactly the factories the cell lists, in its order, with the teams it lists', async () => {
    const { service, toCell, mints } = harness({ cell: LISTED });
    expect(await service.loadFactories(ACME)).toEqual({
      kind: 'listed',
      factories: [docs, releases],
      teams: [general, platform],
    });
    expect(toCell().map(({ method, url, authorization }) => [method, url, authorization])).toEqual(
      expect.arrayContaining([
        ['GET', 'http://web.test/cell/eu/api/factories', 'Bearer token-1'],
        ['GET', 'http://web.test/cell/eu/api/teams', 'Bearer token-1'],
      ]),
    );
    // The two reads share one token.
    expect(mints()).toHaveLength(1);
  });

  it("filters nothing: a member's list is the cell's, whatever teams it names", async () => {
    // The cell filters by access. A member in Platform alone sees Platform's factory, and the
    // page shows what it is given, not what it would work out.
    const { service } = harness({
      cell: {
        'GET /cell/eu/api/factories': { status: 200, body: { factories: [docs] } },
        'GET /cell/eu/api/teams': { status: 200, body: { teams: [platform], canManage: false } },
      },
    });
    expect(await service.loadFactories(ACME)).toEqual({
      kind: 'listed',
      factories: [docs],
      teams: [platform],
    });
  });

  it('is an empty list when the cell lists none', async () => {
    const { service } = harness({
      cell: {
        'GET /cell/eu/api/factories': { status: 200, body: { factories: [] } },
        'GET /cell/eu/api/teams': { status: 200, body: { teams: [general], canManage: true } },
      },
    });
    expect(await service.loadFactories(ACME)).toEqual({
      kind: 'listed',
      factories: [],
      teams: [general],
    });
  });

  it('mints a token again once when the cell refuses one', async () => {
    let refused = 0;
    const { service, mints } = harness({
      cell: {
        ...LISTED,
        'GET /cell/eu/api/factories': () =>
          ++refused === 1
            ? { status: 401, body: { error: 'invalid_token' } }
            : LISTED['GET /cell/eu/api/factories'],
      },
    });
    expect((await service.loadFactories(ACME)).kind).toBe('listed');
    expect(mints()).toHaveLength(2);
  });

  it('asks no cell when the token is for another workspace than the page shows', async () => {
    const { service, toCell } = harness({ workspaceId: 'ws-sprocket', cell: LISTED });
    expect(await service.loadFactories(ACME)).toEqual({ kind: 'switched' });
    expect(toCell()).toEqual([]);
  });

  it('is pending while the cell does not hold the workspace yet', async () => {
    const pending = { status: 409, body: { error: 'workspace_pending' } };
    for (const route of ['GET /cell/eu/api/factories', 'GET /cell/eu/api/teams']) {
      const { service } = harness({ cell: { ...LISTED, [route]: pending } });
      expect(await service.loadFactories(ACME), route).toEqual({ kind: 'pending' });
    }
  });

  it('is signed out only when cloud-global says so', async () => {
    const { service } = harness({
      global: { 'POST /api/cell-token': { status: 401, body: { error: 'signed_out' } } },
      cell: LISTED,
    });
    expect(await service.loadFactories(ACME)).toEqual({ kind: 'signed-out' });
  });

  it('is unavailable for anything it does not expect', async () => {
    for (const [route, answer] of [
      ['GET /cell/eu/api/factories', { status: 503, body: { error: 'token_check_unavailable' } }],
      [
        'GET /cell/eu/api/factories',
        { status: 421, body: { error: 'wrong_region', region: 'us' } },
      ],
      ['GET /cell/eu/api/factories', { status: 502 }],
      ['GET /cell/eu/api/factories', { status: 200, body: { factories: 'none' } }],
      ['GET /cell/eu/api/factories', { status: 200, body: { factories: [{ id: 'f-1' }] } }],
      ['GET /cell/eu/api/teams', { status: 500 }],
    ] as const) {
      const { service } = harness({ cell: { ...LISTED, [route]: answer } });
      expect(await service.loadFactories(ACME), JSON.stringify(answer)).toEqual({
        kind: 'unavailable',
      });
    }
  });
});

describe('loadFactory', () => {
  const version = {
    factoryId: 'f-1',
    version: 2,
    savedAt: '2026-11-22T11:00:00.000Z',
    savedBy: 'p-ada',
    files: [{ path: 'factory.yml', content: 'automations: []\n' }],
  };

  it("reads one factory with its latest version's files, from the cell, with its token", async () => {
    const { service, toCell } = harness({
      cell: {
        'GET /cell/eu/api/factories/f-1': {
          status: 200,
          body: { factory: { ...releases, latestVersion: 2 }, version },
        },
      },
    });
    expect(await service.loadFactory(ACME, 'f-1')).toEqual({
      kind: 'found',
      factory: { ...releases, latestVersion: 2 },
      version,
    });
    expect(toCell().map(({ method, url, authorization }) => [method, url, authorization])).toEqual([
      ['GET', 'http://web.test/cell/eu/api/factories/f-1', 'Bearer token-1'],
    ]);
  });

  it("answers in the page's terms for each refusal", async () => {
    const cases: [Answer, unknown][] = [
      [{ status: 404, body: { error: 'factory_not_found' } }, { kind: 'not-found' }],
      [{ status: 409, body: { error: 'workspace_pending' } }, { kind: 'pending' }],
      [{ status: 503, body: { error: 'token_check_unavailable' } }, { kind: 'unavailable' }],
      [{ status: 404, body: { error: 'not_found' } }, { kind: 'unavailable' }],
      [{ status: 200, body: { factory: releases } }, { kind: 'unavailable' }],
      [
        { status: 200, body: { factory: releases, version: { ...version, files: [{ path: 1 }] } } },
        { kind: 'unavailable' },
      ],
      [{ status: 500 }, { kind: 'unavailable' }],
    ];
    for (const [answer, read] of cases) {
      const { service } = harness({ cell: { 'GET /cell/eu/api/factories/f-1': answer } });
      expect(await service.loadFactory(ACME, 'f-1'), JSON.stringify(answer)).toEqual(read);
    }
  });

  it('asks no cell for a workspace the session no longer has open', async () => {
    const { service, toCell } = harness({ workspaceId: 'ws-sprocket' });
    expect(await service.loadFactory(ACME, 'f-1')).toEqual({ kind: 'switched' });
    expect(toCell()).toEqual([]);
  });
});

describe('changing factories', () => {
  it('makes, renames and moves a factory on the cell, with its token', async () => {
    const { service, toCell } = harness({
      cell: {
        'POST /cell/eu/api/factories': { status: 201, body: releases },
        'PATCH /cell/eu/api/factories/f-1': ({ body }) => ({
          status: 200,
          body: { ...releases, ...JSON.parse(body) },
        }),
      },
    });
    expect(await service.createFactory(ACME, { name: 'Releases', teamId: 't-1' })).toEqual({
      kind: 'changed',
      factory: releases,
    });
    expect(await service.renameFactory(ACME, 'f-1', 'Shipping')).toEqual({
      kind: 'changed',
      factory: { ...releases, name: 'Shipping' },
    });
    expect(await service.moveFactory(ACME, 'f-1', 't-2')).toEqual({
      kind: 'changed',
      factory: { ...releases, teamId: 't-2' },
    });
    expect(toCell().map(({ method, url, body }) => [method, new URL(url).pathname, body])).toEqual([
      ['POST', '/cell/eu/api/factories', '{"name":"Releases","teamId":"t-1"}'],
      // Each change sends only what it changes.
      ['PATCH', '/cell/eu/api/factories/f-1', '{"name":"Shipping"}'],
      ['PATCH', '/cell/eu/api/factories/f-1', '{"teamId":"t-2"}'],
    ]);
    expect(new Set(toCell().map((entry) => entry.authorization))).toEqual(
      new Set(['Bearer token-1']),
    );
  });

  it('encodes the factory in the path', async () => {
    const { service, toCell } = harness({
      cell: { 'PATCH /cell/eu/api/factories/a%2Fb': { status: 200, body: releases } },
    });
    expect((await service.renameFactory(ACME, 'a/b', 'Releases')).kind).toBe('changed');
    expect(new URL(toCell()[0]?.url ?? '').pathname).toBe('/cell/eu/api/factories/a%2Fb');
  });

  const REFUSALS: [Answer, unknown][] = [
    [
      { status: 400, body: { error: 'invalid_factory', problems: ['name_too_long', 'what'] } },
      { kind: 'invalid', problems: ['name_too_long'] },
    ],
    [{ status: 409, body: { error: 'name_taken' } }, { kind: 'name-taken' }],
    [{ status: 404, body: { error: 'team_not_found' } }, { kind: 'team-not-found' }],
    [{ status: 404, body: { error: 'factory_not_found' } }, { kind: 'factory-not-found' }],
    [{ status: 409, body: { error: 'workspace_pending' } }, { kind: 'pending' }],
    [{ status: 400, body: { error: 'invalid_request' } }, { kind: 'unavailable' }],
    [{ status: 415, body: { error: 'unsupported_media_type' } }, { kind: 'unavailable' }],
    [{ status: 503, body: { error: 'token_check_unavailable' } }, { kind: 'unavailable' }],
    [{ status: 404, body: { error: 'not_found' } }, { kind: 'unavailable' }],
    [{ status: 200, body: { id: 'f-1' } }, { kind: 'unavailable' }],
    [{ status: 500 }, { kind: 'unavailable' }],
  ];

  it("answers in the page's terms for each refusal of a new factory", async () => {
    for (const [answer, change] of REFUSALS) {
      const { service } = harness({ cell: { 'POST /cell/eu/api/factories': answer } });
      expect(
        await service.createFactory(ACME, { name: 'Releases', teamId: 't-1' }),
        JSON.stringify(answer),
      ).toEqual(change);
    }
  });

  it("answers in the page's terms for each refusal of a rename or a move", async () => {
    for (const [answer, change] of REFUSALS) {
      const { service } = harness({ cell: { 'PATCH /cell/eu/api/factories/f-1': answer } });
      expect(await service.renameFactory(ACME, 'f-1', 'Shipping'), JSON.stringify(answer)).toEqual(
        change,
      );
      expect(await service.moveFactory(ACME, 'f-1', 't-2'), JSON.stringify(answer)).toEqual(change);
    }
  });

  it('sends no change for a workspace the session no longer has open', async () => {
    const { service, toCell } = harness({ workspaceId: 'ws-sprocket' });
    expect(await service.moveFactory(ACME, 'f-1', 't-2')).toEqual({ kind: 'switched' });
    expect(toCell()).toEqual([]);
  });

  it('is unavailable when the cell does not answer at all', async () => {
    const service = createFactoriesService({
      api: createApi({
        baseUrl: 'http://web.test',
        fetch: async () =>
          json({
            status: 200,
            body: { token: 't', expiresAt: 1300, workspaceId: ACME.id, region: 'eu' },
          }),
      }),
      cellFetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      cellOrigin: 'http://web.test',
      nowSeconds: () => 1000,
    });
    expect(await service.createFactory(ACME, { name: 'Releases', teamId: 't-1' })).toEqual({
      kind: 'unavailable',
    });
    expect(await service.loadFactories(ACME)).toEqual({ kind: 'unavailable' });
  });
});
