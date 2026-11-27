import { describe, expect, it } from 'vitest';
import type { Factory } from '../domain/factories';
import type { Team } from '../domain/teams';
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
type Seen = { method: string; url: string; workspace: string | null; body: string };

const json = ({ status, body }: Answer) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });

/** A service against a stand-in for the API, which answers each route by `METHOD path`. */
function harness(routes: Record<string, Answer | ((seen: Seen) => Answer)> = {}) {
  const seen: Seen[] = [];
  const service = createFactoriesService({
    baseUrl: 'http://web.test',
    fetch: async (request) => {
      const entry = {
        method: request.method,
        url: request.url,
        workspace: request.headers.get('x-consola-workspace'),
        body: await request.text(),
      };
      seen.push(entry);
      const answer = routes[`${entry.method} ${new URL(entry.url).pathname}`];
      if (!answer) return json({ status: 404, body: { error: 'not_found' } });
      return json(typeof answer === 'function' ? answer(entry) : answer);
    },
  });
  return { service, seen };
}

const SWITCHED_ANSWER = { status: 409, body: { error: 'workspace_switched' } };

const LISTED = {
  'GET /api/factories': { status: 200, body: { factories: [docs, releases] } },
  'GET /api/teams': { status: 200, body: { teams: [general, platform], canManage: true } },
};

describe('loadFactories', () => {
  it('shows exactly the factories the API lists, in its order, with the teams it lists', async () => {
    const { service, seen } = harness(LISTED);
    expect(await service.loadFactories(ACME)).toEqual({
      kind: 'listed',
      factories: [docs, releases],
      teams: [general, platform],
    });
    expect(seen.map(({ method, url, workspace }) => [method, url, workspace])).toEqual(
      expect.arrayContaining([
        ['GET', 'http://web.test/api/factories', 'ws-acme'],
        ['GET', 'http://web.test/api/teams', 'ws-acme'],
      ]),
    );
  });

  it("filters nothing: a member's list is the API's, whatever teams it names", async () => {
    // The API filters by access. A member in Platform alone sees Platform's factory, and the
    // page shows what it is given, not what it would work out.
    const { service } = harness({
      'GET /api/factories': { status: 200, body: { factories: [docs] } },
      'GET /api/teams': { status: 200, body: { teams: [platform], canManage: false } },
    });
    expect(await service.loadFactories(ACME)).toEqual({
      kind: 'listed',
      factories: [docs],
      teams: [platform],
    });
  });

  it('is an empty list when the API lists none', async () => {
    const { service } = harness({
      'GET /api/factories': { status: 200, body: { factories: [] } },
      'GET /api/teams': { status: 200, body: { teams: [general], canManage: true } },
    });
    expect(await service.loadFactories(ACME)).toEqual({
      kind: 'listed',
      factories: [],
      teams: [general],
    });
  });

  it('is switched when either read finds the session on another workspace', async () => {
    for (const route of ['GET /api/factories', 'GET /api/teams']) {
      const { service } = harness({ ...LISTED, [route]: SWITCHED_ANSWER });
      expect(await service.loadFactories(ACME), route).toEqual({ kind: 'switched' });
    }
  });

  it('is signed out only on a 401', async () => {
    const { service } = harness({
      ...LISTED,
      'GET /api/factories': { status: 401, body: { error: 'signed_out' } },
    });
    expect(await service.loadFactories(ACME)).toEqual({ kind: 'signed-out' });
  });

  it('is unavailable for anything it does not expect', async () => {
    for (const [route, answer] of [
      ['GET /api/factories', { status: 409, body: { error: 'workspace_pending' } }],
      ['GET /api/factories', { status: 400, body: { error: 'invalid_request' } }],
      ['GET /api/factories', { status: 502 }],
      ['GET /api/factories', { status: 200, body: { factories: 'none' } }],
      ['GET /api/factories', { status: 200, body: { factories: [{ id: 'f-1' }] } }],
      ['GET /api/teams', { status: 500 }],
    ] as const) {
      const { service } = harness({ ...LISTED, [route]: answer });
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

  it("reads one factory with its latest version's files, for the workspace the page shows", async () => {
    const { service, seen } = harness({
      'GET /api/factories/f-1': {
        status: 200,
        body: { factory: { ...releases, latestVersion: 2 }, version },
      },
    });
    expect(await service.loadFactory(ACME, 'f-1')).toEqual({
      kind: 'found',
      factory: { ...releases, latestVersion: 2 },
      version,
    });
    expect(seen.map(({ method, url, workspace }) => [method, url, workspace])).toEqual([
      ['GET', 'http://web.test/api/factories/f-1', 'ws-acme'],
    ]);
  });

  it("answers in the page's terms for each refusal", async () => {
    const cases: Array<[Answer, unknown]> = [
      [{ status: 404, body: { error: 'factory_not_found' } }, { kind: 'not-found' }],
      [SWITCHED_ANSWER, { kind: 'switched' }],
      [{ status: 409, body: { error: 'no_active_workspace' } }, { kind: 'switched' }],
      [{ status: 403, body: { error: 'not_a_member' } }, { kind: 'switched' }],
      [{ status: 409, body: { error: 'workspace_pending' } }, { kind: 'unavailable' }],
      [{ status: 404, body: { error: 'not_found' } }, { kind: 'unavailable' }],
      [{ status: 200, body: { factory: releases } }, { kind: 'unavailable' }],
      [
        { status: 200, body: { factory: releases, version: { ...version, files: [{ path: 1 }] } } },
        { kind: 'unavailable' },
      ],
      [{ status: 500 }, { kind: 'unavailable' }],
    ];
    for (const [answer, read] of cases) {
      const { service } = harness({ 'GET /api/factories/f-1': answer });
      expect(await service.loadFactory(ACME, 'f-1'), JSON.stringify(answer)).toEqual(read);
    }
  });
});

describe('changing factories', () => {
  it('makes, renames and moves a factory, for the workspace the page shows', async () => {
    const { service, seen } = harness({
      'POST /api/factories': { status: 201, body: releases },
      'PATCH /api/factories/f-1': ({ body }) => ({
        status: 200,
        body: { ...releases, ...JSON.parse(body) },
      }),
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
    expect(
      seen.map(({ method, url, workspace, body }) => [
        method,
        new URL(url).pathname,
        workspace,
        body,
      ]),
    ).toEqual([
      ['POST', '/api/factories', 'ws-acme', '{"name":"Releases","teamId":"t-1"}'],
      // Each change sends only what it changes.
      ['PATCH', '/api/factories/f-1', 'ws-acme', '{"name":"Shipping"}'],
      ['PATCH', '/api/factories/f-1', 'ws-acme', '{"teamId":"t-2"}'],
    ]);
  });

  it('encodes the factory in the path', async () => {
    const { service, seen } = harness({
      'PATCH /api/factories/a%2Fb': { status: 200, body: releases },
    });
    expect((await service.renameFactory(ACME, 'a/b', 'Releases')).kind).toBe('changed');
    expect(new URL(seen[0]?.url ?? '').pathname).toBe('/api/factories/a%2Fb');
  });

  const REFUSALS: Array<[Answer, unknown]> = [
    [
      { status: 400, body: { error: 'invalid_factory', problems: ['name_too_long', 'what'] } },
      { kind: 'invalid', problems: ['name_too_long'] },
    ],
    [{ status: 409, body: { error: 'name_taken' } }, { kind: 'name-taken' }],
    [{ status: 404, body: { error: 'team_not_found' } }, { kind: 'team-not-found' }],
    [{ status: 404, body: { error: 'factory_not_found' } }, { kind: 'factory-not-found' }],
    [SWITCHED_ANSWER, { kind: 'switched' }],
    [{ status: 403, body: { error: 'not_a_member' } }, { kind: 'switched' }],
    [{ status: 401, body: { error: 'signed_out' } }, { kind: 'signed-out' }],
    [{ status: 409, body: { error: 'workspace_pending' } }, { kind: 'unavailable' }],
    [{ status: 400, body: { error: 'invalid_request' } }, { kind: 'unavailable' }],
    [{ status: 403, body: { error: 'bad_origin' } }, { kind: 'unavailable' }],
    [{ status: 415, body: { error: 'unsupported_media_type' } }, { kind: 'unavailable' }],
    [{ status: 404, body: { error: 'not_found' } }, { kind: 'unavailable' }],
    [{ status: 200, body: { id: 'f-1' } }, { kind: 'unavailable' }],
    [{ status: 500 }, { kind: 'unavailable' }],
  ];

  it("answers in the page's terms for each refusal of a new factory", async () => {
    for (const [answer, change] of REFUSALS) {
      const { service } = harness({ 'POST /api/factories': answer });
      expect(
        await service.createFactory(ACME, { name: 'Releases', teamId: 't-1' }),
        JSON.stringify(answer),
      ).toEqual(change);
    }
  });

  it("answers in the page's terms for each refusal of a rename or a move", async () => {
    for (const [answer, change] of REFUSALS) {
      const { service } = harness({ 'PATCH /api/factories/f-1': answer });
      expect(await service.renameFactory(ACME, 'f-1', 'Shipping'), JSON.stringify(answer)).toEqual(
        change,
      );
      expect(await service.moveFactory(ACME, 'f-1', 't-2'), JSON.stringify(answer)).toEqual(change);
    }
  });

  it('is unavailable when the API does not answer at all', async () => {
    const service = createFactoriesService({
      baseUrl: 'http://web.test',
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await service.createFactory(ACME, { name: 'Releases', teamId: 't-1' })).toEqual({
      kind: 'unavailable',
    });
    expect(await service.loadFactories(ACME)).toEqual({ kind: 'unavailable' });
  });
});

describe('saveFactory', () => {
  const files = [
    { path: 'factory.yml', content: 'version: 1\n' },
    { path: 'agents/reviewer.md', content: '---\ndescription: Reviews.\n---\nBody\n' },
  ];
  const saved = {
    factoryId: 'f-1',
    version: 4,
    savedAt: '2026-11-24T10:00:00.000Z',
    savedBy: 'p-ada',
    files,
  };

  it('sends every file as the next version of the one they were read from', async () => {
    const { service, seen } = harness({
      'POST /api/factories/f-1/versions': { status: 201, body: { version: saved, notices: [] } },
    });
    expect(await service.saveFactory(ACME, 'f-1', { baseVersion: 3, files })).toEqual({
      kind: 'saved',
      version: saved,
    });
    const sent = seen.find((entry) => entry.url.endsWith('/api/factories/f-1/versions'));
    expect(sent?.workspace).toBe('ws-acme');
    expect(JSON.parse(sent?.body ?? '')).toEqual({ baseVersion: 3, files });
  });

  it('says every issue the API found, and that someone saved first', async () => {
    const issues = [
      { message: 'No skill named `relase`.', file: 'agents/reviewer.md', path: 'skills', line: 4 },
      { message: 'A factory holds at most 500 files.', path: '' },
    ];
    const refused = harness({
      'POST /api/factories/f-1/versions': { status: 400, body: { error: 'invalid_files', issues } },
    });
    expect(await refused.service.saveFactory(ACME, 'f-1', { baseVersion: 3, files })).toEqual({
      kind: 'invalid',
      issues,
    });
    const moved = harness({
      'POST /api/factories/f-1/versions': {
        status: 409,
        body: { error: 'version_moved', latestVersion: 5 },
      },
    });
    expect(await moved.service.saveFactory(ACME, 'f-1', { baseVersion: 3, files })).toEqual({
      kind: 'version-moved',
      latestVersion: 5,
    });
  });

  it.each([
    [{ status: 404, body: { error: 'factory_not_found' } }, { kind: 'not-found' }],
    [SWITCHED_ANSWER, { kind: 'switched' }],
    [{ status: 413, body: { error: 'too_large' } }, { kind: 'too-large' }],
    [{ status: 409, body: { error: 'workspace_pending' } }, { kind: 'unavailable' }],
    [{ status: 400, body: { error: 'invalid_files', issues: 'nope' } }, { kind: 'unavailable' }],
    [{ status: 409, body: { error: 'version_moved' } }, { kind: 'unavailable' }],
    [{ status: 201, body: { version: { version: 'four' }, notices: [] } }, { kind: 'unavailable' }],
    [{ status: 500, body: { error: 'boom' } }, { kind: 'unavailable' }],
  ])("answers %j in the page's terms", async (answer, expected) => {
    const { service } = harness({ 'POST /api/factories/f-1/versions': answer });
    expect(await service.saveFactory(ACME, 'f-1', { baseVersion: 3, files })).toEqual(expected);
  });
});

describe('loadTemplates', () => {
  const TEMPLATES = 'GET /api/factory-templates';
  const team = {
    id: 'code-review-team',
    name: 'Code review team',
    description: 'An orchestrator that reviews every pull request with a review agent.',
    files: [
      { path: 'agents/orchestrator/agent.md', content: '---\ndescription: Leads.\n---\nLead.\n' },
      { path: 'skills/code-review/SKILL.md', content: 'Review well.\n' },
    ],
  };

  it('answers the templates the API offers, with their files', async () => {
    const { service, seen } = harness({ [TEMPLATES]: { status: 200, body: [team] } });
    expect(await service.loadTemplates(ACME)).toEqual({ kind: 'listed', templates: [team] });
    expect(seen[0]?.workspace).toBe('ws-acme');
  });

  it.each([
    [{ status: 200, body: { templates: [team] } }],
    [{ status: 200, body: [{ ...team, files: [{ path: 'a.md' }] }] }],
    [{ status: 503, body: { error: 'unavailable' } }],
    [{ status: 404, body: { error: 'not_found' } }],
  ])('is unavailable for %j', async (answer) => {
    const { service } = harness({ [TEMPLATES]: answer });
    expect(await service.loadTemplates(ACME)).toEqual({ kind: 'unavailable' });
  });

  it('is switched for a workspace the session no longer has open', async () => {
    const { service } = harness({ [TEMPLATES]: SWITCHED_ANSWER });
    expect(await service.loadTemplates(ACME)).toEqual({ kind: 'switched' });
  });
});
