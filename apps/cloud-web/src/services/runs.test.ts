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
type Seen = { method: string; url: string; workspace: string | null; body: string };

const json = ({ status, body }: Answer) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });

/**
 * A service against a stand-in for the API, as Teams' test builds one: it answers each route by
 * `METHOD path`, lists Ada as the workspace's member unless told otherwise, and records every
 * request.
 */
function harness(routes: Record<string, Answer | ((seen: Seen) => Answer)> = {}) {
  const seen: Seen[] = [];
  const service = createRunsService({
    baseUrl: 'http://web.test',
    fetch: async (request) => {
      const entry = {
        method: request.method,
        url: request.url,
        workspace: request.headers.get('x-consola-workspace'),
        body: await request.clone().text(),
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

const SWITCHED_ANSWER = { status: 409, body: { error: 'workspace_switched' } };

describe('queryOf', () => {
  it('asks for nothing without filters', () => {
    expect(queryOf(NO_FILTERS)).toEqual({});
  });

  it('sends every filter as the API names it, an automation with its factory', () => {
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
  it('lists a page for the workspace the page shows, every filter in the query', async () => {
    const { service, seen } = harness({ 'GET /api/runs': { status: 200, body: list } });
    const filters = togglePhase(togglePhase(NO_FILTERS, 'active'), 'needs-you');
    expect(await service.loadRuns(ACME, filters, { limit: 60 })).toEqual({
      kind: 'listed',
      list,
    });
    const call = seen.find((entry) => entry.url.includes('/api/runs'));
    expect(call?.workspace).toBe('ws-acme');
    const url = new URL(call?.url ?? '');
    expect(url.pathname).toBe('/api/runs');
    expect(url.searchParams.getAll('phase')).toEqual(['active', 'needs-you']);
    expect(url.searchParams.get('limit')).toBe('60');
  });

  it('is invalid when the API cannot read the query', async () => {
    const { service } = harness({
      'GET /api/runs': { status: 400, body: { error: 'invalid_request' } },
    });
    expect(await service.loadRuns(ACME, NO_FILTERS, { cursor: 'nonsense' })).toEqual({
      kind: 'invalid',
    });
  });

  it('is switched when the session has another workspace open, none, or one the person left', async () => {
    for (const answer of [
      SWITCHED_ANSWER,
      { status: 409, body: { error: 'no_active_workspace' } },
      { status: 403, body: { error: 'not_a_member' } },
    ]) {
      const { service } = harness({ 'GET /api/runs': answer });
      expect(await service.loadRuns(ACME, NO_FILTERS), JSON.stringify(answer)).toEqual({
        kind: 'switched',
      });
    }
  });

  it('is signed out only on a 401', async () => {
    const { service } = harness({ 'GET /api/runs': { status: 401 } });
    expect(await service.loadRuns(ACME, NO_FILTERS)).toEqual({ kind: 'signed-out' });
  });

  it('is unavailable for a body that is not a page of runs, or an API that is down', async () => {
    const odd = harness({ 'GET /api/runs': { status: 200, body: { runs: 'no' } } });
    expect(await odd.service.loadRuns(ACME, NO_FILTERS)).toEqual({ kind: 'unavailable' });
    const down = harness({ 'GET /api/runs': { status: 503 } });
    expect(await down.service.loadRuns(ACME, NO_FILTERS)).toEqual({ kind: 'unavailable' });
    const pending = harness({
      'GET /api/runs': { status: 409, body: { error: 'workspace_pending' } },
    });
    expect(await pending.service.loadRuns(ACME, NO_FILTERS)).toEqual({ kind: 'unavailable' });
  });
});

describe('loadRun', () => {
  it('reads one run by its id', async () => {
    const { service, seen } = harness({
      'GET /api/runs/run%201': { status: 200, body: detail },
    });
    expect(await service.loadRun(ACME, 'run 1')).toEqual({ kind: 'found', detail });
    expect(seen.some((entry) => entry.url.endsWith('/api/runs/run%201'))).toBe(true);
  });

  it('is not found for a run the person does not see', async () => {
    const { service } = harness({
      'GET /api/runs/run-9': { status: 404, body: { error: 'run_not_found' } },
    });
    expect(await service.loadRun(ACME, 'run-9')).toEqual({ kind: 'not-found' });
  });

  it('is unavailable for a 404 that is not the API’s (a proxy with no API behind it)', async () => {
    const { service } = harness({});
    expect(await service.loadRun(ACME, 'run-9')).toEqual({ kind: 'unavailable' });
  });

  it('is switched for a workspace the session no longer has open', async () => {
    const { service } = harness({ 'GET /api/runs/run-1': SWITCHED_ANSWER });
    expect(await service.loadRun(ACME, 'run-1')).toEqual({ kind: 'switched' });
  });
});

describe('loadMembers', () => {
  it('lists the workspace’s members', async () => {
    const { service, seen } = harness({});
    expect(await service.loadMembers(ACME)).toEqual({ kind: 'listed', members: [ada] });
    expect(seen[0]?.workspace).toBe('ws-acme');
  });

  it('is switched when the session has no workspace open', async () => {
    const { service } = harness({
      'GET /api/me/workspace/members': { status: 409, body: { error: 'no_active_workspace' } },
    });
    expect(await service.loadMembers(ACME)).toEqual({ kind: 'switched' });
  });
});

describe('approveRun', () => {
  const route = 'POST /api/runs/run-1/approval';

  it('sends the decision and the version, and answers with the approval the API recorded', async () => {
    const { service, seen } = harness({ [route]: { status: 201, body: approval } });
    expect(await service.approveRun(ACME, 'run-1', { decision: 'approve', version: 2 })).toEqual({
      kind: 'answered',
      approval,
    });
    const sent = seen.find((entry) => entry.url.endsWith('/approval'));
    expect(sent?.workspace).toBe('ws-acme');
    expect(JSON.parse(sent?.body ?? '')).toEqual({ decision: 'approve', version: 2 });
  });

  it('says every refusal the API gives', async () => {
    const cases: Array<[number, string, string]> = [
      [400, 'invalid_request', 'invalid'],
      [403, 'not_allowed', 'not-allowed'],
      [404, 'run_not_found', 'not-found'],
      [409, 'not_waiting', 'not-waiting'],
      [409, 'already_answered', 'already-answered'],
      [409, 'version_moved', 'version-moved'],
      [409, 'workspace_switched', 'switched'],
      [403, 'not_a_member', 'switched'],
      [401, 'signed_out', 'signed-out'],
    ];
    for (const [status, error, kind] of cases) {
      const { service } = harness({ [route]: { status, body: { error } } });
      expect(await service.approveRun(ACME, 'run-1', { decision: 'dismiss', version: 2 })).toEqual({
        kind,
      });
    }
  });

  it('is unavailable for an answer it does not expect', async () => {
    for (const answer of [
      { status: 201, body: { ok: true } },
      { status: 409, body: { error: 'something_new' } },
      { status: 409, body: { error: 'workspace_pending' } },
      { status: 403, body: { error: 'bad_origin' } },
    ]) {
      const { service } = harness({ [route]: answer });
      expect(
        await service.approveRun(ACME, 'run-1', { decision: 'approve', version: 2 }),
        JSON.stringify(answer),
      ).toEqual({ kind: 'unavailable' });
    }
  });
});
