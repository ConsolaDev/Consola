import { describe, expect, it } from 'vitest';
import type { CloudSession, CloudSessionPass } from '../domain/cloudSession';
import { createApi } from './api';
import { createCloudSessionsService } from './cloudSessions';

const ACME = { id: 'ws-acme', name: 'Acme', region: 'eu' };

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
};

const pass: CloudSessionPass = {
  pass: 'pass-1',
  hostUrl: 'https://7420-sandbox.e2b.test',
  expiresAt: 1_795_000_300,
};

type Answer = { status: number; body?: unknown; html?: string };
type Seen = { method: string; url: string; authorization: string | null; body: string };

const answerWith = ({ status, body, html }: Answer) =>
  html !== undefined
    ? new Response(html, { status, headers: { 'content-type': 'text/html' } })
    : new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      });

/**
 * A service against stand-ins, as the other services' tests build one: `cloud-global` mints
 * `token-1`, `token-2`, … for `workspaceId` in `region`, valid until 1300; the cell answers by
 * `METHOD path`, and every request is recorded.
 */
function harness(options: {
  cell?: Record<string, Answer | ((seen: Seen) => Answer)>;
  mint?: Answer;
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
      body: await request.clone().text(),
    };
    seen.push(entry);
    return entry;
  };
  const globalFetch = async (request: Request) => {
    const entry = await record(request);
    if (`${entry.method} ${new URL(entry.url).pathname}` !== 'POST /api/cell-token') {
      return answerWith({ status: 404, body: { error: 'not_found' } });
    }
    if (options.mint) return answerWith(options.mint);
    minted += 1;
    return answerWith({
      status: 200,
      body: {
        token: `token-${minted}`,
        expiresAt: 1300,
        workspaceId: options.workspaceId ?? ACME.id,
        region: options.region ?? 'eu',
      },
    });
  };
  const cellFetch = async (request: Request) => {
    const entry = await record(request);
    const route = `${entry.method} ${new URL(entry.url).pathname}`;
    const answer = options.cell?.[route];
    // A path the stand-in does not know is a proxy's 404, with no code of the cell's.
    if (!answer) return answerWith({ status: 404, html: '<h1>Not Found</h1>' });
    return answerWith(typeof answer === 'function' ? answer(entry) : answer);
  };
  const service = createCloudSessionsService({
    api: createApi({ baseUrl: 'http://web.test', fetch: globalFetch }),
    cellFetch,
    cellOrigin: 'http://web.test',
    nowSeconds: options.now ?? (() => 1000),
  });
  const mints = () => seen.filter((entry) => entry.url.endsWith('/api/cell-token')).length;
  const toCell = () => seen.filter((entry) => entry.url.includes('/cell/'));
  return { service, seen, mints, toCell };
}

const LIST = 'GET /cell/eu/api/cloud-sessions';
const START = 'POST /cell/eu/api/cloud-sessions';
const OPTIONS = 'GET /cell/eu/api/cloud-sessions/options';
const ONE = 'GET /cell/eu/api/cloud-sessions/cs-1';
const STOP = 'POST /cell/eu/api/cloud-sessions/cs-1/stop';
const PASS = 'POST /cell/eu/api/cloud-sessions/cs-1/pass';

describe('the cell token', () => {
  it('is minted once for two calls, and sent as a bearer token to the region’s cell', async () => {
    const { service, mints, toCell } = harness({
      cell: { [LIST]: { status: 200, body: [session] }, [ONE]: { status: 200, body: session } },
    });
    await service.loadSessions(ACME);
    await service.loadSession(ACME, 'cs-1');
    expect(mints()).toBe(1);
    expect(toCell().map((entry) => entry.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-1',
    ]);
  });

  it('is minted again when it is close to expiring', async () => {
    let now = 1000;
    const { service, mints } = harness({
      cell: { [LIST]: { status: 200, body: [] } },
      now: () => now,
    });
    await service.loadSessions(ACME);
    now = 1280; // Twenty seconds before it expires.
    await service.loadSessions(ACME);
    expect(mints()).toBe(2);
  });

  it('is minted again once when the cell refuses it, and the call made once more', async () => {
    let calls = 0;
    const { service, toCell } = harness({
      cell: {
        [LIST]: () => {
          calls += 1;
          return calls === 1
            ? { status: 401, body: { error: 'invalid_token' } }
            : { status: 200, body: [session] };
        },
      },
    });
    expect(await service.loadSessions(ACME)).toEqual({ kind: 'listed', sessions: [session] });
    expect(toCell().map((entry) => entry.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });

  it('is not minted a third time: a cell that refuses two tokens is unavailable', async () => {
    const { service, toCell } = harness({
      cell: { [LIST]: { status: 401, body: { error: 'invalid_token' } } },
    });
    expect(await service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
    expect(toCell()).toHaveLength(2);
  });

  it('reaches the cell of the region the token names', async () => {
    const { service, toCell } = harness({
      region: 'us',
      cell: { 'GET /cell/us/api/cloud-sessions': { status: 200, body: [] } },
    });
    expect(await service.loadSessions(ACME)).toEqual({ kind: 'listed', sessions: [] });
    expect(new URL(toCell()[0]?.url ?? '').pathname).toBe('/cell/us/api/cloud-sessions');
  });

  it('is signed out only when cloud-global says so, and switched for another workspace', async () => {
    const out = harness({ mint: { status: 401 } });
    expect(await out.service.loadSessions(ACME)).toEqual({ kind: 'signed-out' });
    const switched = harness({ workspaceId: 'ws-other' });
    expect(await switched.service.loadSessions(ACME)).toEqual({ kind: 'switched' });
    expect(switched.toCell()).toHaveLength(0);
    const down = harness({ mint: { status: 502, html: '<h1>Bad Gateway</h1>' } });
    expect(await down.service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
  });
});

describe('loadSessions', () => {
  it('lists the person’s sessions as the cell answers them', async () => {
    const stopped = { ...session, id: 'cs-2', status: 'stopped', endedAt: 1_795_000_600 };
    const { service } = harness({ cell: { [LIST]: { status: 200, body: [stopped, session] } } });
    expect(await service.loadSessions(ACME)).toEqual({
      kind: 'listed',
      sessions: [stopped, session],
    });
  });

  it('is unavailable for a body that is not a list of sessions', async () => {
    for (const body of [{ sessions: [] }, [{ id: 'cs-1' }], [{ ...session, status: 'paused' }]]) {
      const { service } = harness({ cell: { [LIST]: { status: 200, body } } });
      expect(await service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
    }
  });

  it('is unavailable for a proxy’s error page, and for a 200 that is not JSON', async () => {
    const proxy = harness({ cell: { [LIST]: { status: 502, html: '<h1>Bad Gateway</h1>' } } });
    expect(await proxy.service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
    const page = harness({ cell: { [LIST]: { status: 200, html: '<!doctype html><p>Hi' } } });
    expect(await page.service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
  });

  it('is unavailable while the cell cannot check tokens', async () => {
    const { service } = harness({
      cell: { [LIST]: { status: 503, body: { error: 'token_check_unavailable' } } },
    });
    expect(await service.loadSessions(ACME)).toEqual({ kind: 'unavailable' });
  });
});

describe('loadSession', () => {
  it('reads one session by its id', async () => {
    const { service, toCell } = harness({
      cell: { 'GET /cell/eu/api/cloud-sessions/cs%201': { status: 200, body: session } },
    });
    expect(await service.loadSession(ACME, 'cs 1')).toEqual({ kind: 'found', session });
    expect(toCell()[0]?.url).toBe('http://web.test/cell/eu/api/cloud-sessions/cs%201');
  });

  it('is not found when the cell says so, and unavailable for a 404 that is not the cell’s', async () => {
    const gone = harness({ cell: { [ONE]: { status: 404, body: { error: 'not_found' } } } });
    expect(await gone.service.loadSession(ACME, 'cs-1')).toEqual({ kind: 'not-found' });
    const proxy = harness({});
    expect(await proxy.service.loadSession(ACME, 'cs-1')).toEqual({ kind: 'unavailable' });
  });
});

describe('loadOptions', () => {
  it('answers the repositories and the harnesses the runner offers', async () => {
    const options = { repositories: ['sprocket/catalog-portal'], harnesses: ['claude'] };
    const { service } = harness({ cell: { [OPTIONS]: { status: 200, body: options } } });
    expect(await service.loadOptions(ACME)).toEqual({ kind: 'offered', options });
  });

  it('leaves out a harness this page cannot name', async () => {
    const { service } = harness({
      cell: {
        [OPTIONS]: {
          status: 200,
          body: { repositories: ['sprocket/catalog-portal'], harnesses: ['claude', 'gemini'] },
        },
      },
    });
    expect(await service.loadOptions(ACME)).toEqual({
      kind: 'offered',
      options: { repositories: ['sprocket/catalog-portal'], harnesses: ['claude'] },
    });
  });

  it('comes back as no runner when none is connected', async () => {
    const { service } = harness({
      cell: { [OPTIONS]: { status: 503, body: { error: 'no_runner' } } },
    });
    expect(await service.loadOptions(ACME)).toEqual({ kind: 'no-runner' });
  });
});

describe('startSession', () => {
  it('sends exactly the repository and the harness, and answers the session started', async () => {
    const starting = { ...session, status: 'starting', hostUrl: null };
    const { service, toCell } = harness({ cell: { [START]: { status: 201, body: starting } } });
    expect(
      await service.startSession(ACME, {
        repository: 'sprocket/catalog-portal',
        harness: 'claude',
      }),
    ).toEqual({ kind: 'started', session: starting });
    expect(JSON.parse(toCell()[0]?.body ?? '')).toEqual({
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
    });
  });

  it.each([
    [503, 'no_runner'],
    [400, 'repository_not_offered'],
    [400, 'harness_not_offered'],
    [400, 'invalid_request'],
  ])('comes back with the cell’s code for a %s %s', async (status, code) => {
    const { service } = harness({ cell: { [START]: { status, body: { error: code } } } });
    expect(
      await service.startSession(ACME, { repository: 'sprocket/other', harness: 'codex' }),
    ).toEqual({ kind: 'refused', code });
  });

  it('is unavailable for a code it does not expect, or a proxy’s page', async () => {
    for (const answer of [
      { status: 415, body: { error: 'unsupported_media_type' } },
      { status: 400, body: { error: 'no_runner' } },
      { status: 502, html: '<h1>Bad Gateway</h1>' },
      { status: 503, body: { error: 'token_check_unavailable' } },
    ]) {
      const { service } = harness({ cell: { [START]: answer } });
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
    const { service } = harness({ cell: { [STOP]: { status: 202, body: stopped } } });
    expect(await service.stopSession(ACME, 'cs-1')).toEqual({
      kind: 'stopped',
      session: stopped,
    });
  });

  it('is not found for a session that is not the person’s', async () => {
    const { service } = harness({
      cell: { [STOP]: { status: 404, body: { error: 'not_found' } } },
    });
    expect(await service.stopSession(ACME, 'cs-1')).toEqual({ kind: 'not-found' });
  });
});

describe('issuePass', () => {
  it('answers the pass and the host it opens', async () => {
    const { service } = harness({ cell: { [PASS]: { status: 200, body: pass } } });
    expect(await service.issuePass(ACME, 'cs-1')).toEqual({ kind: 'issued', pass });
  });

  it('is not found for a session that is not running, and no runner without a pass key', async () => {
    const gone = harness({ cell: { [PASS]: { status: 404, body: { error: 'not_found' } } } });
    expect(await gone.service.issuePass(ACME, 'cs-1')).toEqual({ kind: 'not-found' });
    const none = harness({ cell: { [PASS]: { status: 503, body: { error: 'no_runner' } } } });
    expect(await none.service.issuePass(ACME, 'cs-1')).toEqual({ kind: 'no-runner' });
  });

  it('is unavailable for a pass whose host is not an http(s) address', async () => {
    for (const hostUrl of ['javascript:alert(1)', 'not a url', 7420]) {
      const { service } = harness({
        cell: { [PASS]: { status: 200, body: { ...pass, hostUrl } } },
      });
      expect(await service.issuePass(ACME, 'cs-1')).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('renewPass', () => {
  it('resolves with a new pass', async () => {
    const { service } = harness({
      cell: { [PASS]: { status: 200, body: { ...pass, pass: 'pass-2' } } },
    });
    await expect(service.renewPass(ACME, 'cs-1')).resolves.toBe('pass-2');
  });

  it('rejects when the cell answers 404, so the chat stops asking', async () => {
    const { service } = harness({
      cell: { [PASS]: { status: 404, body: { error: 'not_found' } } },
    });
    await expect(service.renewPass(ACME, 'cs-1')).rejects.toThrow(
      'This session isn’t running any more.',
    );
  });

  it('rejects for any other answer that is not a pass', async () => {
    const { service } = harness({
      cell: { [PASS]: { status: 503, body: { error: 'no_runner' } } },
    });
    await expect(service.renewPass(ACME, 'cs-1')).rejects.toThrow(
      'No runner is connected for this workspace.',
    );
  });
});
