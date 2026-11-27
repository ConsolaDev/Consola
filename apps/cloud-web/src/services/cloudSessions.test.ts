import { describe, expect, it } from 'vitest';
import type { CloudSession, CloudSessionPass } from '../domain/cloudSession';
import { createCloudSessionsService } from './cloudSessions';

const ACME = { id: 'ws-acme', name: 'Acme' };

const session: CloudSession = {
  id: 'cs-1',
  workspaceId: 'ws-acme',
  personId: 'p-ada',
  repository: 'sprocket/catalog-portal',
  harness: 'claude',
  status: 'running',
  title: null,
  hostUrl: 'https://7420-sandbox.e2b.test',
  error: null,
  errorCode: null,
  runnerId: 'runner-1',
  createdAt: 1_795_000_000,
  endedAt: null,
  origin: null,
  agentRun: null,
};

const pass: CloudSessionPass = {
  pass: 'pass-1',
  hostUrl: 'https://7420-sandbox.e2b.test',
  expiresAt: 1_795_000_300,
};

type Answer = { status: number; body?: unknown; html?: string };
type Seen = { method: string; url: string; workspace: string | null; body: string };

const answerWith = ({ status, body, html }: Answer) =>
  html !== undefined
    ? new Response(html, { status, headers: { 'content-type': 'text/html' } })
    : new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      });

/**
 * A service against a stand-in for the API, as the other services' tests build one: it answers
 * each route by `METHOD path`, and every request is recorded.
 */
function harness(routes: Record<string, Answer | ((seen: Seen) => Answer)> = {}) {
  const seen: Seen[] = [];
  const service = createCloudSessionsService({
    baseUrl: 'http://web.test',
    fetch: async (request) => {
      const entry = {
        method: request.method,
        url: request.url,
        workspace: request.headers.get('x-consola-workspace'),
        body: await request.clone().text(),
      };
      seen.push(entry);
      const answer = routes[`${entry.method} ${new URL(entry.url).pathname}`];
      // A path the stand-in does not know is a proxy's 404, with no code of the API's.
      if (!answer) return answerWith({ status: 404, html: '<h1>Not Found</h1>' });
      return answerWith(typeof answer === 'function' ? answer(entry) : answer);
    },
  });
  return { service, seen };
}

const LIST = 'GET /api/cloud-sessions';
const START = 'POST /api/cloud-sessions';
const OPTIONS = 'GET /api/cloud-sessions/options';
const ONE = 'GET /api/cloud-sessions/cs-1';
const STOP = 'POST /api/cloud-sessions/cs-1/stop';
const PASS = 'POST /api/cloud-sessions/cs-1/pass';

describe('the workspace', () => {
  it('is named on every call: the one the page shows', async () => {
    const { service, seen } = harness({
      [LIST]: { status: 200, body: [session] },
      [ONE]: { status: 200, body: session },
      [PASS]: { status: 200, body: pass },
    });
    await service.loadSessions(ACME);
    await service.loadSession(ACME, 'cs-1');
    await service.issuePass(ACME, 'cs-1');
    expect(seen.map((entry) => entry.workspace)).toEqual(['ws-acme', 'ws-acme', 'ws-acme']);
  });

  it('is switched when the session has another workspace open, none, or one the person left', async () => {
    for (const answer of [
      { status: 409, body: { error: 'workspace_switched' } },
      { status: 409, body: { error: 'no_active_workspace' } },
      { status: 403, body: { error: 'not_a_member' } },
    ]) {
      const { service } = harness({ [LIST]: answer, [STOP]: answer });
      expect(await service.loadSessions(ACME), JSON.stringify(answer)).toEqual({
        kind: 'switched',
      });
      expect(await service.stopSession(ACME, 'cs-1'), JSON.stringify(answer)).toEqual({
        kind: 'switched',
      });
    }
  });

  it('is unavailable when the API refuses a change as not from the web app (`bad_origin`)', async () => {
    const refused = { status: 403, body: { error: 'bad_origin' } };
    const { service } = harness({ [START]: refused, [STOP]: refused, [PASS]: refused });
    expect(
      await service.startSession(ACME, { repository: 'sprocket/catalog-portal', harness: 'codex' }),
    ).toEqual({ kind: 'unavailable' });
    expect(await service.stopSession(ACME, 'cs-1')).toEqual({ kind: 'unavailable' });
    expect(await service.issuePass(ACME, 'cs-1')).toEqual({ kind: 'unavailable' });
  });

  it('is signed out only on a 401, and unavailable when the API does not answer', async () => {
    const out = harness({ [LIST]: { status: 401, body: { error: 'signed_out' } } });
    expect(await out.service.loadSessions(ACME)).toEqual({ kind: 'signed-out' });
    const down = harness({ [LIST]: { status: 502, html: '<h1>Bad Gateway</h1>' } });
    expect(await down.service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
    const unreachable = createCloudSessionsService({
      baseUrl: 'http://web.test',
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await unreachable.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
  });
});

describe('loadSessions', () => {
  it('lists the person’s sessions as the API answers them', async () => {
    const stopped = { ...session, id: 'cs-2', status: 'stopped', endedAt: 1_795_000_600 };
    const { service } = harness({ [LIST]: { status: 200, body: [stopped, session] } });
    expect(await service.loadSessions(ACME)).toEqual({
      kind: 'listed',
      sessions: [stopped, session],
    });
  });

  it('is unavailable for a body that is not a list of sessions', async () => {
    for (const body of [{ sessions: [] }, [{ id: 'cs-1' }], [{ ...session, status: 'paused' }]]) {
      const { service } = harness({ [LIST]: { status: 200, body } });
      expect(await service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
    }
  });

  it('is unavailable for a proxy’s error page, and for a 200 that is not JSON', async () => {
    const proxy = harness({ [LIST]: { status: 502, html: '<h1>Bad Gateway</h1>' } });
    expect(await proxy.service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
    const page = harness({ [LIST]: { status: 200, html: '<!doctype html><p>Hi' } });
    expect(await page.service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
  });

  it('is unavailable while the API cannot reach its database', async () => {
    const { service } = harness({ [LIST]: { status: 503, body: { error: 'unavailable' } } });
    expect(await service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
  });
});

describe('an agent run, as the API lists it', () => {
  const origin = {
    kind: 'automation',
    factoryId: 'f-1',
    factoryName: 'Code review',
    automation: 'review-pull-requests',
    agent: 'orchestrator',
    item: {
      kind: 'pull_request',
      repository: 'sprocket/catalog-portal',
      number: 12,
      url: 'https://github.com/sprocket/catalog-portal/pull/12',
      title: 'Fix the flaky login test',
      headSha: '0123456789abcdef0123456789abcdef01234567',
    },
  } as const;
  const run = {
    ...session,
    id: 'cs-run',
    personId: null,
    title: 'review-pull-requests · sprocket/catalog-portal#12 Fix the flaky login test',
    origin,
    agentRun: {
      state: 'working',
      summary: 'Dispatched review.',
      agents: [{ id: 'c-2', agent: 'review', status: 'working' }],
    },
  } satisfies CloudSession;

  it('lists beside the person’s own sessions, with what started it and its report', async () => {
    const { service } = harness({ [LIST]: { status: 200, body: [run, session] } });
    expect(await service.loadSessions(ACME)).toEqual({ kind: 'listed', sessions: [run, session] });
  });

  it('reads one, with its report, by its id', async () => {
    const { service } = harness({ 'GET /api/cloud-sessions/cs-run': { status: 200, body: run } });
    expect(await service.loadSession(ACME, 'cs-run')).toEqual({ kind: 'found', session: run });
  });

  it('stops as a person’s session stops', async () => {
    const stopped = { ...run, status: 'stopped', endedAt: 1_795_000_600 };
    const { service, seen } = harness({
      'POST /api/cloud-sessions/cs-run/stop': { status: 202, body: stopped },
    });
    expect(await service.stopSession(ACME, 'cs-run')).toEqual({
      kind: 'stopped',
      session: stopped,
    });
    expect(seen[0]?.method).toBe('POST');
  });

  it('still shows when its report cannot be read: the report is none, an odd agent left out', async () => {
    const odd = {
      ...run,
      agentRun: {
        state: 'done',
        agents: [
          { id: 'c-2', agent: 'review', status: 'done', summary: 'LGTM.' },
          { id: 'c-3', agent: 'verify', status: 'paused' },
        ],
      },
    };
    const newer = { ...run, id: 'cs-newer', agentRun: { state: 'thinking' } };
    const { service } = harness({ [LIST]: { status: 200, body: [odd, newer] } });
    expect(await service.loadSessions(ACME)).toEqual({
      kind: 'listed',
      sessions: [
        {
          ...odd,
          agentRun: {
            state: 'done',
            agents: [{ id: 'c-2', agent: 'review', status: 'done', summary: 'LGTM.' }],
          },
        },
        { ...newer, agentRun: null },
      ],
    });
  });

  it('is unavailable when what started it cannot be read: the page links what it names', async () => {
    for (const broken of [
      { ...origin, item: { ...origin.item, number: '12' } },
      { ...origin, kind: 'schedule' },
      { ...origin, factoryId: undefined },
    ]) {
      const { service } = harness({ [LIST]: { status: 200, body: [{ ...run, origin: broken }] } });
      expect(await service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
    }
  });

  it('reads a request from Slack, with its factory and its message', async () => {
    const slack = {
      ...run,
      id: 'cs-slack',
      title: 'Code review · Slack: Can you look at the flaky checkout test?',
      origin: {
        kind: 'slack',
        factoryId: 'f-1',
        factoryName: 'Code review',
        agent: 'orchestrator',
        via: 'dm',
        message: {
          teamId: 'T024BE7LD',
          channelId: 'C024BE91L',
          threadTs: '1732700000.000100',
          messageTs: '1732700000.000100',
          permalink: 'https://sprocket.slack.com/archives/C024BE91L/p1732700000000100',
          title: 'Can you look at the flaky checkout test?',
        },
      },
    } satisfies CloudSession;
    const { service } = harness({ [LIST]: { status: 200, body: [slack] } });
    expect(await service.loadSessions(ACME)).toEqual({ kind: 'listed', sessions: [slack] });

    for (const broken of [
      { ...slack.origin, message: { ...slack.origin.message, permalink: undefined } },
      { ...slack.origin, message: { ...slack.origin.message, title: undefined } },
      { ...slack.origin, message: null },
      { ...slack.origin, factoryName: 7 },
      { ...slack.origin, via: undefined },
    ]) {
      const refused = harness({ [LIST]: { status: 200, body: [{ ...slack, origin: broken }] } });
      expect(await refused.service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
    }
  });

  it('reads a request from Slack of a factory that names no repository, with none', async () => {
    const noRepository = {
      ...run,
      id: 'cs-norepo',
      repository: null,
      origin: {
        kind: 'slack',
        factoryId: 'f-2',
        factoryName: 'Weekly report',
        agent: 'orchestrator',
        via: 'mention',
        message: {
          teamId: 'T024BE7LD',
          channelId: 'C024BE91L',
          threadTs: '1732700000.000200',
          messageTs: '1732700000.000200',
          permalink: 'https://sprocket.slack.com/archives/C024BE91L/p1732700000000200',
          title: 'Write up last week',
        },
      },
    } satisfies CloudSession;
    const { service } = harness({ [LIST]: { status: 200, body: [noRepository] } });
    expect(await service.loadSessions(ACME)).toEqual({ kind: 'listed', sessions: [noRepository] });

    // A repository is a name or null: anything else is not a session.
    for (const repository of [undefined, 7, {}]) {
      const refused = harness({
        [LIST]: { status: 200, body: [{ ...noRepository, repository }] },
      });
      expect(await refused.service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
    }
  });

  it('reads a session from an API that does not say what started it as a person’s', async () => {
    const { origin: _origin, agentRun: _agentRun, ...older } = session;
    const { service } = harness({ [ONE]: { status: 200, body: older } });
    expect(await service.loadSession(ACME, 'cs-1')).toEqual({ kind: 'found', session });
  });
});

describe('loadSession', () => {
  it('reads one session by its id', async () => {
    const { service, seen } = harness({
      'GET /api/cloud-sessions/cs%201': { status: 200, body: session },
    });
    expect(await service.loadSession(ACME, 'cs 1')).toEqual({ kind: 'found', session });
    expect(seen[0]?.url).toBe('http://web.test/api/cloud-sessions/cs%201');
  });

  it('is not found when the API says so, and unavailable for a 404 that is not the API’s', async () => {
    const gone = harness({ [ONE]: { status: 404, body: { error: 'not_found' } } });
    expect(await gone.service.loadSession(ACME, 'cs-1')).toEqual({ kind: 'not-found' });
    const proxy = harness({});
    expect(await proxy.service.loadSession(ACME, 'cs-1')).toEqual({ kind: 'unavailable' });
  });
});

describe('loadOptions', () => {
  it('answers the repositories and the harnesses the runner offers', async () => {
    const options = { repositories: ['sprocket/catalog-portal'], harnesses: ['claude'] };
    const { service } = harness({ [OPTIONS]: { status: 200, body: options } });
    expect(await service.loadOptions(ACME)).toEqual({ kind: 'offered', options });
  });

  it('leaves out a harness this page cannot name', async () => {
    const { service } = harness({
      [OPTIONS]: {
        status: 200,
        body: { repositories: ['sprocket/catalog-portal'], harnesses: ['claude', 'gemini'] },
      },
    });
    expect(await service.loadOptions(ACME)).toEqual({
      kind: 'offered',
      options: { repositories: ['sprocket/catalog-portal'], harnesses: ['claude'] },
    });
  });

  it('comes back as no runner when none is connected', async () => {
    const { service } = harness({ [OPTIONS]: { status: 503, body: { error: 'no_runner' } } });
    expect(await service.loadOptions(ACME)).toEqual({ kind: 'no-runner' });
  });
});

describe('startSession', () => {
  it('sends exactly the repository and the harness, and answers the session started', async () => {
    const starting = { ...session, status: 'starting', hostUrl: null };
    const { service, seen } = harness({ [START]: { status: 201, body: starting } });
    expect(
      await service.startSession(ACME, {
        repository: 'sprocket/catalog-portal',
        harness: 'claude',
      }),
    ).toEqual({ kind: 'started', session: starting });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
    });
  });

  it.each([
    [503, 'no_runner'],
    [400, 'repository_not_offered'],
    [400, 'harness_not_offered'],
    [400, 'invalid_request'],
  ])('comes back with the API’s code for a %s %s', async (status, code) => {
    const { service } = harness({ [START]: { status, body: { error: code } } });
    expect(
      await service.startSession(ACME, { repository: 'sprocket/other', harness: 'codex' }),
    ).toEqual({ kind: 'refused', code });
  });

  it('is unavailable for a code it does not expect, or a proxy’s page', async () => {
    for (const answer of [
      { status: 415, body: { error: 'unsupported_media_type' } },
      { status: 400, body: { error: 'no_runner' } },
      { status: 502, html: '<h1>Bad Gateway</h1>' },
      { status: 503, body: { error: 'unavailable' } },
    ]) {
      const { service } = harness({ [START]: answer });
      expect(
        await service.startSession(ACME, {
          repository: 'sprocket/catalog-portal',
          harness: 'claude',
        }),
      ).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('stopSession', () => {
  it('answers the session, ended', async () => {
    const stopped = { ...session, status: 'stopped', endedAt: 1_795_000_600 };
    const { service } = harness({ [STOP]: { status: 202, body: stopped } });
    expect(await service.stopSession(ACME, 'cs-1')).toEqual({
      kind: 'stopped',
      session: stopped,
    });
  });

  it('is not found for a session that is not the person’s', async () => {
    const { service } = harness({ [STOP]: { status: 404, body: { error: 'not_found' } } });
    expect(await service.stopSession(ACME, 'cs-1')).toEqual({ kind: 'not-found' });
  });
});

describe('issuePass', () => {
  it('answers the pass and the host it opens', async () => {
    const { service } = harness({ [PASS]: { status: 200, body: pass } });
    expect(await service.issuePass(ACME, 'cs-1')).toEqual({ kind: 'issued', pass });
  });

  it('is not found for a session that is not running, and no runner without a pass key', async () => {
    const gone = harness({ [PASS]: { status: 404, body: { error: 'not_found' } } });
    expect(await gone.service.issuePass(ACME, 'cs-1')).toEqual({ kind: 'not-found' });
    const none = harness({ [PASS]: { status: 503, body: { error: 'no_runner' } } });
    expect(await none.service.issuePass(ACME, 'cs-1')).toEqual({ kind: 'no-runner' });
  });

  it('is unavailable for a pass whose host is not an http(s) address', async () => {
    for (const hostUrl of ['javascript:alert(1)', 'not a url', 7420]) {
      const { service } = harness({ [PASS]: { status: 200, body: { ...pass, hostUrl } } });
      expect(await service.issuePass(ACME, 'cs-1')).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('renewPass', () => {
  it('resolves with a new pass', async () => {
    const { service } = harness({ [PASS]: { status: 200, body: { ...pass, pass: 'pass-2' } } });
    await expect(service.renewPass(ACME, 'cs-1')).resolves.toBe('pass-2');
  });

  it('rejects when the API answers 404, so the chat stops asking', async () => {
    const { service } = harness({ [PASS]: { status: 404, body: { error: 'not_found' } } });
    await expect(service.renewPass(ACME, 'cs-1')).rejects.toThrow(
      'This session isn’t running any more.',
    );
  });

  it('rejects for any other answer that is not a pass', async () => {
    const { service } = harness({ [PASS]: { status: 503, body: { error: 'no_runner' } } });
    await expect(service.renewPass(ACME, 'cs-1')).rejects.toThrow(
      'No runner is connected for this workspace.',
    );
  });
});
