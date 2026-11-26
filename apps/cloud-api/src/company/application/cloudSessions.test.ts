import { PASS_AUDIENCE, PASS_MAX_LIFETIME_SECONDS } from '@consola/runner-protocol';
import type { PassClaims, SessionUpdate } from '@consola/runner-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestDatabase } from '../adapters/persistence/testDatabase.js';
import type { Database } from '../adapters/persistence/database.js';
import { createCloudSessionStore } from '../adapters/persistence/cloudSessions.js';
import type { Caller } from '../domain/caller.js';
import { callerAs } from './testMembership.js';
import {
  applyRunnerUpdate,
  getSession,
  issuePass,
  listSessions,
  sessionOptions,
  startSession,
  stopSession,
} from './cloudSessions.js';
import type {
  CloudSessionPorts,
  CloudSessionStore,
  Offer,
  PassSigner,
  RunnerChannel,
  RunnerIdentity,
} from './ports.js';

let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
});
afterEach(async () => {
  await close();
});

const caller = (personId = 'person-1', workspaceId = 'acme'): Caller =>
  callerAs(personId, 'member', workspaceId);

const offer: Offer = {
  runnerId: 'runner-1',
  repositories: ['sprocket/catalog-portal', 'sprocket/billing'],
  harnesses: ['claude'],
};

/** The runner `offer` names, serving `acme`. */
const RUNNER: RunnerIdentity = { workspaceId: 'acme', runnerId: 'runner-1' };

/** Signs nothing: a pass here is its claims, as JSON, so a test can read what was signed. */
const passSigner: PassSigner = { sign: async (claims) => `pass:${JSON.stringify(claims)}` };

type Fake = { ports: CloudSessionPorts; channel: RunnerChannel; now: { value: number } };

function setup(connected: Offer | null = offer, passes: PassSigner | null = passSigner): Fake {
  const now = { value: 1000 };
  let next = 0;
  const channel: RunnerChannel = {
    connected: vi.fn(() => connected),
    startSession: vi.fn(async () => {}),
    stopSession: vi.fn(async () => {}),
  };
  const ports: CloudSessionPorts = {
    sessions: createCloudSessionStore(db),
    runners: channel,
    ids: { newId: () => `session-${++next}` },
    clock: { nowSeconds: () => now.value },
    passes,
  };
  return { ports, channel, now };
}

const request = { repository: 'sprocket/catalog-portal', harness: 'claude' } as const;

describe('sessionOptions', () => {
  it('is what the connected runner offers', () => {
    const { ports } = setup();
    expect(sessionOptions(ports, caller())).toEqual({
      kind: 'ok',
      repositories: offer.repositories,
      harnesses: offer.harnesses,
    });
  });

  it('is no_runner when none is connected', () => {
    const { ports } = setup(null);
    expect(sessionOptions(ports, caller())).toEqual({ kind: 'no_runner' });
  });

  it("asks for the caller's own workspace", () => {
    const { ports, channel } = setup();
    sessionOptions(ports, caller('person-1', 'globex'));
    expect(channel.connected).toHaveBeenCalledWith('globex');
  });
});

describe('startSession', () => {
  it('records a starting row and hands the start to the runner exactly once', async () => {
    const { ports, channel } = setup();
    const answer = await startSession(ports, caller(), request);
    expect(answer).toMatchObject({
      kind: 'ok',
      session: {
        id: 'session-1',
        workspaceId: 'acme',
        personId: 'person-1',
        repository: 'sprocket/catalog-portal',
        harness: 'claude',
        status: 'starting',
        title: null,
        hostUrl: null,
        error: null,
        errorCode: null,
        runnerId: 'runner-1',
        createdAt: 1000,
        endedAt: null,
      },
    });
    expect(channel.startSession).toHaveBeenCalledTimes(1);
    expect(channel.startSession).toHaveBeenCalledWith('runner-1', {
      sessionId: 'session-1',
      workspaceId: 'acme',
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
    });
    expect(await ports.sessions.listOwn('acme', 'person-1')).toHaveLength(1);
  });

  it('with no runner connected answers no_runner and records nothing', async () => {
    const { ports, channel } = setup(null);
    expect(await startSession(ports, caller(), request)).toEqual({ kind: 'no_runner' });
    expect(await ports.sessions.listOwn('acme', 'person-1')).toEqual([]);
    expect(channel.startSession).not.toHaveBeenCalled();
  });

  it('refuses a repository the offer lacks, sending and recording nothing', async () => {
    const { ports, channel } = setup();
    const answer = await startSession(ports, caller(), {
      repository: 'sprocket/secret',
      harness: 'claude',
    });
    expect(answer).toEqual({ kind: 'repository_not_offered' });
    expect(await ports.sessions.listOwn('acme', 'person-1')).toEqual([]);
    expect(channel.startSession).not.toHaveBeenCalled();
  });

  it('refuses a harness the offer lacks, sending and recording nothing', async () => {
    const { ports, channel } = setup();
    const answer = await startSession(ports, caller(), { ...request, harness: 'codex' });
    expect(answer).toEqual({ kind: 'harness_not_offered' });
    expect(await ports.sessions.listOwn('acme', 'person-1')).toEqual([]);
    expect(channel.startSession).not.toHaveBeenCalled();
  });

  it('marks the row failed with the cell code when the runner cannot be told', async () => {
    const { ports, channel, now } = setup();
    vi.mocked(channel.startSession).mockImplementation(async () => {
      now.value = 1005;
      throw new Error('socket closed: secret-detail');
    });
    const answer = await startSession(ports, caller(), request);
    expect(answer).toMatchObject({
      kind: 'ok',
      session: {
        status: 'failed',
        errorCode: 'runner_unreachable',
        error: null,
        endedAt: 1005,
      },
    });
    // What the transport said is never kept: it is not the runner's report.
    expect(JSON.stringify(await ports.sessions.listOwn('acme', 'person-1'))).not.toContain(
      'secret-detail',
    );
  });
});

describe('listSessions and getSession', () => {
  it("lists only the caller's own sessions in the caller's workspace, newest first", async () => {
    const { ports, now } = setup();
    await startSession(ports, caller('person-1'), request);
    now.value = 1010;
    await startSession(ports, caller('person-2'), request);
    now.value = 1020;
    await startSession(ports, caller('person-1'), request);
    now.value = 1030;
    await startSession(ports, caller('person-1', 'globex'), request);
    const own = await listSessions(ports, caller('person-1'));
    expect(own.map((s) => s.id)).toEqual(['session-3', 'session-1']);
  });

  it('gets its own session, and not_found for another person, another workspace or no id', async () => {
    const { ports } = setup();
    await startSession(ports, caller('person-1'), request);
    expect(await getSession(ports, caller('person-1'), 'session-1')).toMatchObject({
      kind: 'ok',
      session: { id: 'session-1' },
    });
    for (const asked of [caller('person-2'), caller('person-1', 'globex')]) {
      expect(await getSession(ports, asked, 'session-1')).toEqual({ kind: 'not_found' });
    }
    expect(await getSession(ports, caller('person-1'), 'nope')).toEqual({ kind: 'not_found' });
  });
});

describe('stopSession', () => {
  it('marks the session stopped and tells its connected runner', async () => {
    const { ports, channel, now } = setup();
    await startSession(ports, caller(), request);
    await applyRunnerUpdate(ports, RUNNER, {
      type: 'session.update',
      sessionId: 'session-1',
      status: 'running',
    });
    now.value = 1500;
    const answer = await stopSession(ports, caller(), 'session-1');
    expect(answer).toMatchObject({ kind: 'ok', session: { status: 'stopped', endedAt: 1500 } });
    expect(channel.stopSession).toHaveBeenCalledWith('runner-1', 'session-1');
  });

  it('stops a session still starting', async () => {
    const { ports } = setup();
    await startSession(ports, caller(), request);
    expect(await stopSession(ports, caller(), 'session-1')).toMatchObject({
      session: { status: 'stopped' },
    });
  });

  // The choice: a person can always end their session. The row ends at once; the runner is told
  // only if it is connected, and when it comes back its `hello` finds the row ended and stops
  // the sandbox (Review Focus 7).
  it('while the runner is disconnected still ends the row, and sends nothing', async () => {
    const { ports } = setup();
    await startSession(ports, caller(), request);
    const down = { ...ports, runners: { ...ports.runners, connected: () => null } };
    const send = vi.fn(async () => {});
    down.runners.stopSession = send;
    const answer = await stopSession(down, caller(), 'session-1');
    expect(answer).toMatchObject({ kind: 'ok', session: { status: 'stopped' } });
    expect(send).not.toHaveBeenCalled();
    const held = await ports.sessions.find('session-1');
    expect(held).toMatchObject({ status: 'stopped', runnerId: 'runner-1' });
  });

  it('does not send the stop to a runner other than the session’s', async () => {
    const { ports, channel } = setup();
    await startSession(ports, caller(), request);
    const other = {
      ...ports,
      runners: { ...channel, connected: () => ({ ...offer, runnerId: 'runner-3' }) },
    };
    await stopSession(other, caller(), 'session-1');
    expect(channel.stopSession).not.toHaveBeenCalled();
    expect((await ports.sessions.find('session-1'))?.status).toBe('stopped');
  });

  it('keeps the stop when the runner cannot be told', async () => {
    const { ports, channel } = setup();
    await startSession(ports, caller(), request);
    vi.mocked(channel.stopSession).mockRejectedValue(new Error('socket closed'));
    expect(await stopSession(ports, caller(), 'session-1')).toMatchObject({
      session: { status: 'stopped' },
    });
  });

  it('is not_found for a session that is not the caller’s', async () => {
    const { ports, channel } = setup();
    await startSession(ports, caller('person-1'), request);
    expect(await stopSession(ports, caller('person-2'), 'session-1')).toEqual({
      kind: 'not_found',
    });
    expect(channel.stopSession).not.toHaveBeenCalled();
    expect((await ports.sessions.find('session-1'))?.status).toBe('starting');
  });

  it('on an ended session changes nothing and tells nobody', async () => {
    const { ports, channel, now } = setup();
    await startSession(ports, caller(), request);
    await stopSession(ports, caller(), 'session-1');
    now.value = 9999;
    vi.mocked(channel.stopSession).mockClear();
    const again = await stopSession(ports, caller(), 'session-1');
    expect(again).toMatchObject({ kind: 'ok', session: { status: 'stopped', endedAt: 1000 } });
    expect(channel.stopSession).not.toHaveBeenCalled();
  });
});

describe('applyRunnerUpdate', () => {
  const update = (over: Partial<SessionUpdate>): SessionUpdate => ({
    type: 'session.update',
    sessionId: 'session-1',
    ...over,
  });

  async function started() {
    const fake = setup();
    await startSession(fake.ports, caller(), request);
    return fake;
  }

  it('stores a title', async () => {
    const { ports } = await started();
    await applyRunnerUpdate(ports, RUNNER, update({ title: 'Fix the cart total' }));
    expect(await ports.sessions.find('session-1')).toMatchObject({
      title: 'Fix the cart total',
      status: 'starting',
    });
  });

  it('moves starting to running with its host address', async () => {
    const { ports } = await started();
    await applyRunnerUpdate(
      ports,
      RUNNER,
      update({ status: 'running', hostUrl: 'https://3000-abc.e2b.example' }),
    );
    expect(await ports.sessions.find('session-1')).toMatchObject({
      status: 'running',
      hostUrl: 'https://3000-abc.e2b.example',
      endedAt: null,
    });
  });

  it("keeps a runner's failure message in error, with no cell code", async () => {
    const { ports, now } = await started();
    now.value = 1200;
    await applyRunnerUpdate(ports, RUNNER, update({ status: 'failed', error: 'clone-failed' }));
    expect(await ports.sessions.find('session-1')).toMatchObject({
      status: 'failed',
      error: 'clone-failed',
      errorCode: null,
      endedAt: 1200,
    });
  });

  it('gives a failure the runner left unexplained the cell code runner_failed', async () => {
    const { ports, now } = await started();
    now.value = 1300;
    await applyRunnerUpdate(ports, RUNNER, update({ status: 'failed' }));
    expect(await ports.sessions.find('session-1')).toMatchObject({
      status: 'failed',
      error: null,
      errorCode: 'runner_failed',
      endedAt: 1300,
    });
  });

  it('keeps a title when another change moves the status first', async () => {
    const { ports } = await started();
    // The first compare-and-set loses: just before it, the row moves to running.
    const real = ports.sessions;
    let raced = false;
    const racing: CloudSessionStore = {
      ...real,
      async update(sessionId, expected, changes) {
        if (!raced) {
          raced = true;
          await real.update(sessionId, 'starting', { status: 'running' });
        }
        return real.update(sessionId, expected, changes);
      },
    };
    await applyRunnerUpdate(
      { ...ports, sessions: racing },
      RUNNER,
      update({ title: 'Fix the cart total', hostUrl: 'https://3000-abc.e2b.example' }),
    );
    expect(await real.find('session-1')).toMatchObject({
      status: 'running',
      title: 'Fix the cart total',
      hostUrl: 'https://3000-abc.e2b.example',
    });
  });

  it('drops a title once the row it was for has ended, and never reopens it', async () => {
    const { ports } = await started();
    const real = ports.sessions;
    let raced = false;
    const racing: CloudSessionStore = {
      ...real,
      async update(sessionId, expected, changes) {
        if (!raced) {
          raced = true;
          await real.update(sessionId, 'starting', { status: 'stopped', endedAt: 1100 });
        }
        return real.update(sessionId, expected, changes);
      },
    };
    await applyRunnerUpdate({ ...ports, sessions: racing }, RUNNER, update({ title: 'late' }));
    expect(await real.find('session-1')).toMatchObject({
      status: 'stopped',
      endedAt: 1100,
      title: null,
    });
  });

  it("ignores an update from a runner of the row's id that serves another workspace", async () => {
    const { ports } = await started();
    await applyRunnerUpdate(
      ports,
      { workspaceId: 'globex', runnerId: 'runner-1' },
      update({ status: 'running', hostUrl: 'https://evil.example', title: 'x' }),
    );
    expect(await ports.sessions.find('session-1')).toMatchObject({
      status: 'starting',
      hostUrl: null,
      title: null,
    });
  });

  it('ignores an update from a runner other than the row’s', async () => {
    const { ports } = await started();
    await applyRunnerUpdate(
      ports,
      { workspaceId: 'acme', runnerId: 'runner-2' },
      update({ status: 'running', hostUrl: 'https://evil.example', title: 'x' }),
    );
    expect(await ports.sessions.find('session-1')).toMatchObject({
      status: 'starting',
      hostUrl: null,
      title: null,
    });
  });

  it('changes nothing on an ended row', async () => {
    const { ports } = await started();
    await stopSession(ports, caller(), 'session-1');
    const before = await ports.sessions.find('session-1');
    await applyRunnerUpdate(
      ports,
      RUNNER,
      update({ status: 'failed', error: 'late', title: 'late', hostUrl: 'https://late.example' }),
    );
    expect(await ports.sessions.find('session-1')).toEqual(before);
  });

  it('ignores a session it does not know', async () => {
    const { ports } = await started();
    await expect(
      applyRunnerUpdate(ports, RUNNER, update({ sessionId: 'nope', status: 'running' })),
    ).resolves.toBeUndefined();
  });
});

describe('issuePass', () => {
  async function running(fake: Fake = setup()) {
    await startSession(fake.ports, caller(), request);
    await applyRunnerUpdate(fake.ports, RUNNER, {
      type: 'session.update',
      sessionId: 'session-1',
      status: 'running',
      hostUrl: 'https://3000-abc.e2b.example',
    });
    return fake;
  }

  const claimsOf = (pass: string): PassClaims => JSON.parse(pass.slice('pass:'.length));

  it("signs a pass for the caller's own running session, for the longest a pass may live", async () => {
    const { ports, now } = await running();
    now.value = 5000;
    const answer = await issuePass(ports, caller(), 'session-1');
    if (answer.kind !== 'ok') throw new Error(`expected a pass, got ${answer.kind}`);
    expect(answer.hostUrl).toBe('https://3000-abc.e2b.example');
    expect(claimsOf(answer.pass)).toEqual({
      aud: PASS_AUDIENCE,
      sub: 'person-1',
      ws: 'acme',
      sid: 'session-1',
      iat: 5000,
      exp: 5000 + PASS_MAX_LIFETIME_SECONDS,
    });
    expect(answer.expiresAt).toBe(5000 + PASS_MAX_LIFETIME_SECONDS);
    expect(PASS_MAX_LIFETIME_SECONDS).toBe(300);
  });

  it('is not_found for a session that is not running yet', async () => {
    const { ports } = setup();
    await startSession(ports, caller(), request);
    expect(await issuePass(ports, caller(), 'session-1')).toEqual({ kind: 'not_found' });
  });

  it('is not_found for an ended session', async () => {
    const { ports } = await running();
    await stopSession(ports, caller(), 'session-1');
    expect(await issuePass(ports, caller(), 'session-1')).toEqual({ kind: 'not_found' });
  });

  it("is not_found for another person's session, another workspace's, or an unknown id", async () => {
    const { ports } = await running();
    expect(await issuePass(ports, caller('person-2'), 'session-1')).toEqual({ kind: 'not_found' });
    expect(await issuePass(ports, caller('person-1', 'globex'), 'session-1')).toEqual({
      kind: 'not_found',
    });
    expect(await issuePass(ports, caller(), 'nope')).toEqual({ kind: 'not_found' });
  });

  it('is not_found for a running session whose host has no address yet', async () => {
    const { ports } = setup();
    await startSession(ports, caller(), request);
    await applyRunnerUpdate(ports, RUNNER, {
      type: 'session.update',
      sessionId: 'session-1',
      status: 'running',
    });
    expect(await issuePass(ports, caller(), 'session-1')).toEqual({ kind: 'not_found' });
  });

  it('is no_runner when the cell has no pass key', async () => {
    const { ports } = await running(setup(offer, null));
    expect(await issuePass(ports, caller(), 'session-1')).toEqual({ kind: 'no_runner' });
  });
});
