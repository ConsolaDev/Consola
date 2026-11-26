import { describe, expect, it } from 'vitest';
import {
  NO_FILTERS,
  toggleBackground,
  toggleMine,
  togglePhase,
  withAutomation,
  withSearch,
} from '../domain/runFilters';
import type { RunApproval, RunDetail, RunList, RunSummary } from '../domain/runs';
import { createApi } from './api';
import { createRunsService, queryOf } from './runs';

const ACME = { id: 'ws-acme' };
const ada = { id: 'p-ada', name: 'Ada', email: 'ada@acme.test', image: null, role: 'owner' };

const run: RunSummary = {
  id: 'run-1',
  kind: 'request',
  title: 'Fix the flaky login test',
  status: 'waiting',
  phase: 'active',
  waitingOn: 'run',
  factory: { id: 'f-1', name: 'Reviews', version: 2 },
  teamId: 't-1',
  automation: null,
  parentId: null,
  trigger: 'manual',
  triggerDetail: null,
  startedBy: 'p-ada',
  item: null,
  runner: 'cloud',
  progress: null,
  children: { total: 1, active: 1, needsYou: 0, failed: 0 },
  summary: null,
  error: null,
  costUsd: 0.42,
  createdAt: '2026-11-23T10:00:00.000Z',
  startedAt: '2026-11-23T10:00:01.000Z',
  finishedAt: null,
  updatedAt: '2026-11-23T10:00:30.000Z',
};

const list: RunList = {
  runs: [run],
  nextCursor: null,
  counts: { active: 1, 'needs-you': 0, completed: 0, failed: 0, stopped: 0 },
  facets: {
    factories: [{ id: 'f-1', name: 'Reviews', teamId: 't-1', latestVersion: 2 }],
    teams: [{ id: 't-1', name: 'Core' }],
    automations: [],
  },
};

const detail: RunDetail = {
  run,
  parent: null,
  steps: [],
  request: {
    text: 'Fix the flaky login test',
    budget: null,
    spent: { usd: 0.42, runs: 1 },
    question: null,
  },
  children: [],
  conversation: null,
  source: null,
  approval: null,
};

const approval: RunApproval = {
  version: 2,
  reason: 'review asks before every run.',
  team: { id: 't-1', name: 'Core' },
  mayAnswer: true,
  will: { commands: [{ step: 'build', command: 'pnpm build' }], agents: [] },
  answer: { decision: 'approved', by: 'p-ada', at: '2026-11-23T10:05:00.000Z' },
};

type Answer = { status: number; body?: unknown };
type Seen = { method: string; url: string; authorization: string | null; body: string };

const json = ({ status, body }: Answer) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });

/**
 * A service against stand-ins, as Teams' test builds one: `cloud-global` mints `token-1`,
 * `token-2`, … and lists Ada; the cell answers by `METHOD path`, and every request is recorded.
 */
function harness(options: {
  cell?: Record<string, Answer | ((seen: Seen) => Answer)>;
  global?: Record<string, Answer>;
  workspaceId?: string;
}) {
  const seen: Seen[] = [];
  let minted = 0;
  const record = async (request: Request): Promise<Seen> => {
    const entry = {
      method: request.method,
      url: request.url,
      authorization: request.headers.get('authorization'),
      body: await request.clone().text(),
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
    if (route === 'GET /api/me/workspace/members') {
      return json({ status: 200, body: { members: [ada] } });
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
  const service = createRunsService({
    api: createApi({ baseUrl: 'http://web.test', fetch: globalFetch }),
    cellFetch,
    cellOrigin: 'http://web.test',
    nowSeconds: () => 1000,
  });
  return { service, seen };
}

describe('queryOf', () => {
  it('asks for nothing without filters', () => {
    expect(queryOf(NO_FILTERS)).toEqual({});
  });

  it('sends every filter as the cell names it, an automation with its factory', () => {
    const filters = withSearch(
      togglePhase(
        toggleMine(withAutomation(NO_FILTERS, { factoryId: 'f-1', name: 'review' })),
        'failed',
      ),
      '  login ',
    );
    expect(queryOf(filters, { cursor: 'c-1', limit: 73 })).toEqual({
      phase: ['failed'],
      factoryId: 'f-1',
      automation: 'review',
      mine: 'true',
      q: 'login',
      cursor: 'c-1',
      limit: 73,
    });
  });

  it('sends background runs as their three triggers, and a team', () => {
    expect(queryOf({ ...toggleBackground(NO_FILTERS), teamId: 't-1' })).toEqual({
      trigger: ['cron', 'event', 'poll'],
      teamId: 't-1',
    });
  });
});

describe('loadRuns', () => {
  it('lists a page from the workspace’s cell, with a token, every filter in the query', async () => {
    const { service, seen } = harness({
      cell: { 'GET /cell/eu/api/runs': { status: 200, body: list } },
    });
    const filters = togglePhase(togglePhase(NO_FILTERS, 'active'), 'needs-you');
    expect(await service.loadRuns(ACME, filters, { limit: 60 })).toEqual({
      kind: 'listed',
      list,
    });
    const call = seen.find((entry) => entry.url.includes('/cell/'));
    expect(call?.authorization).toBe('Bearer token-1');
    const url = new URL(call?.url ?? '');
    expect(url.pathname).toBe('/cell/eu/api/runs');
    expect(url.searchParams.getAll('phase')).toEqual(['active', 'needs-you']);
    expect(url.searchParams.get('limit')).toBe('60');
  });

  it('keeps the token for the next call', async () => {
    const { service, seen } = harness({
      cell: { 'GET /cell/eu/api/runs': { status: 200, body: list } },
    });
    await service.loadRuns(ACME, NO_FILTERS);
    await service.loadRuns(ACME, NO_FILTERS);
    expect(seen.filter((entry) => entry.url.endsWith('/api/cell-token'))).toHaveLength(1);
  });

  it('mints again once when the cell refuses the token', async () => {
    let calls = 0;
    const { service, seen } = harness({
      cell: {
        'GET /cell/eu/api/runs': () => {
          calls += 1;
          return calls === 1
            ? { status: 401, body: { error: 'invalid_token' } }
            : { status: 200, body: list };
        },
      },
    });
    expect((await service.loadRuns(ACME, NO_FILTERS)).kind).toBe('listed');
    expect(
      seen.filter((entry) => entry.url.includes('/cell/')).map((entry) => entry.authorization),
    ).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('is invalid when the cell cannot read the query', async () => {
    const { service } = harness({
      cell: { 'GET /cell/eu/api/runs': { status: 400, body: { error: 'invalid_request' } } },
    });
    expect(await service.loadRuns(ACME, NO_FILTERS, { cursor: 'nonsense' })).toEqual({
      kind: 'invalid',
    });
  });

  it('is pending while the cell does not hold the workspace yet', async () => {
    const { service } = harness({
      cell: { 'GET /cell/eu/api/runs': { status: 409, body: { error: 'workspace_pending' } } },
    });
    expect(await service.loadRuns(ACME, NO_FILTERS)).toEqual({ kind: 'pending' });
  });

  it('is switched when the session has another workspace open, and asks no cell', async () => {
    const { service, seen } = harness({ workspaceId: 'ws-other' });
    expect(await service.loadRuns(ACME, NO_FILTERS)).toEqual({ kind: 'switched' });
    expect(seen.some((entry) => entry.url.includes('/cell/'))).toBe(false);
  });

  it('is signed out only when cloud-global says so', async () => {
    const { service } = harness({ global: { 'POST /api/cell-token': { status: 401 } } });
    expect(await service.loadRuns(ACME, NO_FILTERS)).toEqual({ kind: 'signed-out' });
  });

  it('is unavailable for a body that is not a page of runs, or a cell that is down', async () => {
    const odd = harness({
      cell: { 'GET /cell/eu/api/runs': { status: 200, body: { runs: 'no' } } },
    });
    expect(await odd.service.loadRuns(ACME, NO_FILTERS)).toEqual({ kind: 'unavailable' });
    const down = harness({ cell: { 'GET /cell/eu/api/runs': { status: 503 } } });
    expect(await down.service.loadRuns(ACME, NO_FILTERS)).toEqual({ kind: 'unavailable' });
  });
});

describe('loadRun', () => {
  it('reads one run by its id', async () => {
    const { service, seen } = harness({
      cell: { 'GET /cell/eu/api/runs/run%201': { status: 200, body: detail } },
    });
    expect(await service.loadRun(ACME, 'run 1')).toEqual({ kind: 'found', detail });
    expect(seen.some((entry) => entry.url.endsWith('/cell/eu/api/runs/run%201'))).toBe(true);
  });

  it('is not found for a run the person does not see', async () => {
    const { service } = harness({
      cell: { 'GET /cell/eu/api/runs/run-9': { status: 404, body: { error: 'run_not_found' } } },
    });
    expect(await service.loadRun(ACME, 'run-9')).toEqual({ kind: 'not-found' });
  });

  it('is unavailable for a 404 that is not the cell’s (a proxy with no cell behind it)', async () => {
    const { service } = harness({});
    expect(await service.loadRun(ACME, 'run-9')).toEqual({ kind: 'unavailable' });
  });
});

describe('loadMembers', () => {
  it('lists the workspace’s members from cloud-global', async () => {
    const { service } = harness({});
    expect(await service.loadMembers(ACME)).toEqual({ kind: 'listed', members: [ada] });
  });

  it('is switched when the session has no workspace open', async () => {
    const { service } = harness({
      global: {
        'GET /api/me/workspace/members': { status: 409, body: { error: 'no_active_workspace' } },
      },
    });
    expect(await service.loadMembers(ACME)).toEqual({ kind: 'switched' });
  });
});

describe('approveRun', () => {
  const route = 'POST /cell/eu/api/runs/run-1/approval';

  it('sends the decision and the version, and answers with the approval the cell recorded', async () => {
    const { service, seen } = harness({ cell: { [route]: { status: 201, body: approval } } });
    expect(await service.approveRun(ACME, 'run-1', { decision: 'approve', version: 2 })).toEqual({
      kind: 'answered',
      approval,
    });
    const sent = seen.find((entry) => entry.url.endsWith('/approval'));
    expect(sent?.authorization).toBe('Bearer token-1');
    expect(JSON.parse(sent?.body ?? '')).toEqual({ decision: 'approve', version: 2 });
  });

  it('says every refusal the cell gives', async () => {
    const cases: Array<[number, string, string]> = [
      [400, 'invalid_request', 'invalid'],
      [403, 'not_allowed', 'not-allowed'],
      [404, 'run_not_found', 'not-found'],
      [409, 'not_waiting', 'not-waiting'],
      [409, 'already_answered', 'already-answered'],
      [409, 'version_moved', 'version-moved'],
      [409, 'workspace_pending', 'pending'],
    ];
    for (const [status, error, kind] of cases) {
      const { service } = harness({ cell: { [route]: { status, body: { error } } } });
      expect(await service.approveRun(ACME, 'run-1', { decision: 'dismiss', version: 2 })).toEqual({
        kind,
      });
    }
  });

  it('is unavailable for an answer it does not expect', async () => {
    const odd = harness({ cell: { [route]: { status: 201, body: { ok: true } } } });
    expect(
      await odd.service.approveRun(ACME, 'run-1', { decision: 'approve', version: 2 }),
    ).toEqual({
      kind: 'unavailable',
    });
    const other = harness({ cell: { [route]: { status: 409, body: { error: 'something_new' } } } });
    expect(
      await other.service.approveRun(ACME, 'run-1', { decision: 'approve', version: 2 }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('is switched when the session has another workspace open, and sends nothing to a cell', async () => {
    const { service, seen } = harness({ workspaceId: 'ws-other' });
    expect(await service.approveRun(ACME, 'run-1', { decision: 'approve', version: 2 })).toEqual({
      kind: 'switched',
    });
    expect(seen.some((entry) => entry.url.includes('/cell/'))).toBe(false);
  });
});
