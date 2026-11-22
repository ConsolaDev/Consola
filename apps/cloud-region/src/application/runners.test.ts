import type { RunnerHello } from '@consola/runner-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import { createCloudSessionStore } from '../adapters/persistence/cloudSessions.js';
import type { CloudSession, CloudSessionStatus } from '../domain/cloudSession.js';
import type { CloudSessionStore, RunnerUpdatePorts } from './ports.js';
import { runnerConnected } from './runners.js';

let db: Database;
let close: () => Promise<void>;
let sessions: CloudSessionStore;
let ports: RunnerUpdatePorts;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  sessions = createCloudSessionStore(db);
  ports = { sessions, clock: { nowSeconds: () => 2000 } };
});
afterEach(async () => {
  await close();
});

/** A row the cell holds, as Task 2's start would have written it. */
async function holds(
  id: string,
  status: CloudSessionStatus,
  over: Partial<CloudSession> = {},
): Promise<void> {
  await sessions.insert({
    id,
    workspaceId: 'acme',
    personId: 'person-1',
    repository: 'sprocket/catalog-portal',
    harness: 'claude',
    status,
    title: null,
    hostUrl: status === 'running' ? 'https://3000-sandbox.e2b.example' : null,
    error: null,
    errorCode: null,
    runnerId: 'runner-1',
    createdAt: 1000,
    endedAt: status === 'stopped' || status === 'failed' ? 1500 : null,
    ...over,
  });
}

const hello = (over: Partial<RunnerHello> = {}): RunnerHello => ({
  type: 'hello',
  runnerId: 'runner-1',
  repositories: ['sprocket/catalog-portal'],
  harnesses: ['claude'],
  runningSessionIds: [],
  endedSessions: [],
  ...over,
});

const row = (id: string) => sessions.find(id);

describe('runnerConnected', () => {
  it('fails every live session of the runner that hello does not list, and keeps the listed', async () => {
    await holds('s-1', 'running');
    await holds('s-2', 'running');

    const answer = await runnerConnected(ports, 'acme', hello({ runningSessionIds: ['s-1'] }));

    expect(await row('s-2')).toMatchObject({
      status: 'failed',
      errorCode: 'runner_restarted',
      error: null,
      endedAt: 2000,
    });
    expect(await row('s-1')).toMatchObject({ status: 'running', endedAt: null, errorCode: null });
    expect(answer.stop).toEqual([]);
  });

  it('fails a starting session the runner no longer has, too', async () => {
    await holds('s-1', 'starting');
    await runnerConnected(ports, 'acme', hello());
    expect(await row('s-1')).toMatchObject({ status: 'failed', errorCode: 'runner_restarted' });
  });

  it('keeps the real end of a session that ended while the socket was down', async () => {
    await holds('s-1', 'running');
    await holds('s-2', 'running');
    await holds('s-3', 'running');

    await runnerConnected(
      ports,
      'acme',
      hello({
        endedSessions: [
          { sessionId: 's-1', status: 'stopped' },
          { sessionId: 's-2', status: 'failed', error: 'The sandbox ran out of memory.' },
          { sessionId: 's-3', status: 'failed' },
        ],
      }),
    );

    expect(await row('s-1')).toMatchObject({
      status: 'stopped',
      error: null,
      errorCode: null,
      endedAt: 2000,
    });
    expect(await row('s-2')).toMatchObject({
      status: 'failed',
      error: 'The sandbox ran out of memory.',
      errorCode: null,
    });
    // A failure with no message of the runner's carries the cell's code, never neither.
    expect(await row('s-3')).toMatchObject({
      status: 'failed',
      error: null,
      errorCode: 'runner_failed',
    });
  });

  it('ends a starting session as reported: its running may have been lost with the socket', async () => {
    await holds('s-1', 'starting');
    await runnerConnected(
      ports,
      'acme',
      hello({ endedSessions: [{ sessionId: 's-1', status: 'stopped' }] }),
    );
    expect(await row('s-1')).toMatchObject({ status: 'stopped', errorCode: null, endedAt: 2000 });
  });

  it('never changes a session the cell already ended', async () => {
    await holds('s-1', 'stopped');
    const before = await row('s-1');
    await runnerConnected(
      ports,
      'acme',
      hello({ endedSessions: [{ sessionId: 's-1', status: 'failed', error: 'late' }] }),
    );
    expect(await row('s-1')).toEqual(before);
  });

  it('stops every listed session the cell holds as ended, or does not know', async () => {
    await holds('s-1', 'running');
    await holds('s-3', 'stopped');

    const answer = await runnerConnected(
      ports,
      'acme',
      hello({ runningSessionIds: ['s-1', 's-3', 's-4'] }),
    );

    expect(answer.stop).toEqual(['s-3', 's-4']);
    expect(await row('s-1')).toMatchObject({ status: 'running' });
    expect(await row('s-4')).toBeNull();
  });

  it('lets ended win when hello lists one session as both running and ended', async () => {
    await holds('s-1', 'running');

    const answer = await runnerConnected(
      ports,
      'acme',
      hello({
        runningSessionIds: ['s-1'],
        endedSessions: [{ sessionId: 's-1', status: 'failed', error: 'The host exited.' }],
      }),
    );

    expect(await row('s-1')).toMatchObject({
      status: 'failed',
      error: 'The host exited.',
      errorCode: null,
    });
    // The cell now holds it as ended, so whatever the runner still has of it stops.
    expect(answer.stop).toEqual(['s-1']);
  });

  it('takes a session listed twice once', async () => {
    await holds('s-3', 'stopped');
    await holds('s-5', 'running');

    const answer = await runnerConnected(
      ports,
      'acme',
      hello({
        runningSessionIds: ['s-3', 's-3', 's-4', 's-4'],
        endedSessions: [
          { sessionId: 's-5', status: 'stopped' },
          { sessionId: 's-5', status: 'failed', error: 'second' },
        ],
      }),
    );

    expect(answer.stop).toEqual(['s-3', 's-4']);
    expect(await row('s-5')).toMatchObject({ status: 'stopped', error: null });
  });

  it("leaves another runner's sessions, and another workspace's, alone", async () => {
    await holds('s-other-runner', 'running', { runnerId: 'runner-2' });
    await holds('s-other-workspace', 'starting', { workspaceId: 'globex' });

    const answer = await runnerConnected(
      ports,
      'acme',
      hello({
        runningSessionIds: ['s-other-runner', 's-other-workspace'],
        endedSessions: [
          { sessionId: 's-other-runner', status: 'failed', error: 'x' },
          { sessionId: 's-other-workspace', status: 'stopped' },
        ],
      }),
    );

    expect(await row('s-other-runner')).toMatchObject({ status: 'running', error: null });
    expect(await row('s-other-workspace')).toMatchObject({ status: 'starting' });
    // Neither is this runner's to hold, so whatever it has of them stops.
    expect(answer.stop).toEqual(['s-other-runner', 's-other-workspace']);
  });
});
