import type { SessionUpdate } from '@consola/runner-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import { createCloudSessionStore } from '../adapters/persistence/cloudSessions.js';
import type { Caller } from '../domain/caller.js';
import {
  applyRunnerUpdate,
  getSession,
  listSessions,
  sessionOptions,
  startSession,
  stopSession,
} from './cloudSessions.js';
import type { CloudSessionPorts, Offer, RunnerChannel } from './ports.js';

let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
});
afterEach(async () => {
  await close();
});

const caller = (personId = 'person-1', workspaceId = 'acme'): Caller =>
  ({ personId, workspaceId, role: 'member', region: 'eu' }) as Caller;

const offer: Offer = {
  runnerId: 'runner-1',
  repositories: ['sprocket/catalog-portal', 'sprocket/billing'],
  harnesses: ['claude'],
};

type Fake = { ports: CloudSessionPorts; channel: RunnerChannel; now: { value: number } };

function setup(connected: Offer | null = offer): Fake {
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
    await applyRunnerUpdate(ports, 'runner-1', {
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
    await applyRunnerUpdate(ports, 'runner-1', update({ title: 'Fix the cart total' }));
    expect(await ports.sessions.find('session-1')).toMatchObject({
      title: 'Fix the cart total',
      status: 'starting',
    });
  });

  it('moves starting to running with its host address', async () => {
    const { ports } = await started();
    await applyRunnerUpdate(
      ports,
      'runner-1',
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
    await applyRunnerUpdate(ports, 'runner-1', update({ status: 'failed', error: 'clone-failed' }));
    expect(await ports.sessions.find('session-1')).toMatchObject({
      status: 'failed',
      error: 'clone-failed',
      errorCode: null,
      endedAt: 1200,
    });
  });

  it('ignores an update from a runner other than the row’s', async () => {
    const { ports } = await started();
    await applyRunnerUpdate(
      ports,
      'runner-2',
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
      'runner-1',
      update({ status: 'failed', error: 'late', title: 'late', hostUrl: 'https://late.example' }),
    );
    expect(await ports.sessions.find('session-1')).toEqual(before);
  });

  it('ignores a session it does not know', async () => {
    const { ports } = await started();
    await expect(
      applyRunnerUpdate(ports, 'runner-1', update({ sessionId: 'nope', status: 'running' })),
    ).resolves.toBeUndefined();
  });
});
