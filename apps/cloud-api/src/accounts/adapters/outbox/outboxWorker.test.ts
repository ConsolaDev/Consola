import { generateKeyPairSync } from 'node:crypto';
import type { Region } from '@consola/cloud-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellDelivery, DeliveryAnswer, OutboxStore } from '../../application/ports.js';
import type { Ed25519PrivateJwk } from '../../config.js';
import { createCellTokenSigner } from '../cellToken/cellTokenSigner.js';
import { migrateDatabase, openDatabase } from '../persistence/database.js';
import type { Database } from '../persistence/database.js';
import { schema } from '../persistence/schema.js';
import { createDrizzleStores } from '../persistence/stores.js';
import { createOutboxWorker, OUTBOX_POLL_MS } from './outboxWorker.js';
import type { OutboxWorker, Timers } from './outboxWorker.js';

/** Timers the test fires by hand. */
function handTimers() {
  let last = 0;
  const pending = new Map<number, { run: () => void; ms: number }>();
  const timers: Timers = {
    set(run, ms) {
      last += 1;
      pending.set(last, { run, ms });
      return last;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    /** The delay of each timer waiting. */
    waiting: () => [...pending.values()].map((timer) => timer.ms),
    /** Fires the one timer waiting. */
    fire() {
      const [entry] = pending;
      if (!entry) throw new Error('no timer is waiting');
      pending.delete(entry[0]);
      entry[1].run();
    },
  };
}

/** A cell port that answers as the test says, keeping every signed message it was handed. */
function handCells(reach: Region[] = ['eu', 'us']) {
  const sent: string[] = [];
  let answer: (signal?: AbortSignal) => Promise<DeliveryAnswer> = async () => ({
    kind: 'confirmed',
    status: 200,
  });
  const cells: CellDelivery = {
    reaches: (region) => reach.includes(region),
    deliver: (_region, signed, signal) => {
      sent.push(signed);
      return answer(signal);
    },
  };
  return {
    cells,
    sent,
    answerWith(next: (signal?: AbortSignal) => Promise<DeliveryAnswer>) {
      answer = next;
    },
  };
}

let db: Database;
let close: () => Promise<void>;
let key: Ed25519PrivateJwk;
let clock: Date;
let lines: string[];
let worker: OutboxWorker | null;

const log = {
  info: (line: string) => lines.push(`info ${line}`),
  warn: (line: string) => lines.push(`warn ${line}`),
  error: (line: string) => lines.push(`error ${line}`),
};

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db
    .insert(schema.user)
    .values([
      { id: 'person-dana', name: 'Dana Ortiz', email: 'dana@acme.test', emailVerified: true },
    ]);
  key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as Ed25519PrivateJwk;
  clock = new Date('2026-11-22T10:00:00Z');
  lines = [];
  worker = null;
});

afterEach(async () => {
  await worker?.stop();
  await close();
});

/** A worker on the test's database, timers, clock and log, woken by every change written. */
async function workerWith(cells: CellDelivery, outbox?: (store: OutboxStore) => OutboxStore) {
  const hand = handTimers();
  let wake = () => {};
  const stores = createDrizzleStores(db, { messageWritten: () => wake() });
  worker = createOutboxWorker({
    outbox: outbox ? outbox(stores.outbox) : stores.outbox,
    signer: await createCellTokenSigner(key),
    cells,
    now: () => clock,
    timers: hand.timers,
    log,
  });
  wake = worker.wake;
  const makeAcme = async () => {
    const made = await stores.workspaces.create(
      { name: 'Acme', slug: 'acme', region: 'eu' },
      { userId: 'person-dana', role: 'owner' },
    );
    if (made.kind !== 'created') throw new Error('not created');
    return made.workspace.id;
  };
  return { worker, hand, makeAcme };
}

/** Waits until the pass running has ended and scheduled the next. */
const passEnded = (hand: ReturnType<typeof handTimers>) =>
  vi.waitFor(() => expect(hand.waiting()).toHaveLength(1));

describe('the outbox worker', () => {
  it('delivers at once when it starts, then waits for the poll', async () => {
    const { cells, sent } = handCells();
    const { worker, hand, makeAcme } = await workerWith(cells);
    const acme = await makeAcme();

    worker.start();
    await passEnded(hand);

    expect(sent).toHaveLength(2);
    expect(hand.waiting()).toEqual([OUTBOX_POLL_MS]);
    expect(lines).toEqual([
      `info Outbox: delivered message 1 of workspace ${acme} (status 200, attempt 1).`,
      `info Outbox: delivered message 2 of workspace ${acme} (status 200, attempt 1).`,
    ]);
  });

  it('wakes when a change writes a message, without waiting for the poll', async () => {
    const { cells, sent } = handCells();
    const { worker, hand, makeAcme } = await workerWith(cells);
    worker.start();
    await passEnded(hand);
    expect(sent).toEqual([]);

    await makeAcme();

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await passEnded(hand);
    expect(hand.waiting()).toEqual([OUTBOX_POLL_MS]);
  });

  it('runs one more pass right after one it was woken during', async () => {
    const { cells, sent, answerWith } = handCells();
    let release = () => {};
    answerWith(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ kind: 'confirmed', status: 200 });
        }),
    );
    const { worker, hand, makeAcme } = await workerWith(cells);
    await makeAcme();
    worker.start();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    // Woken twice while the pass waits on its cell: one more pass, not two, and not at once.
    worker.wake();
    worker.wake();
    expect(sent).toHaveLength(1);
    answerWith(async () => ({ kind: 'confirmed', status: 200 }));
    release();

    await passEnded(hand);
    expect(hand.waiting()).toEqual([0]);
    hand.fire();
    await passEnded(hand);
    expect(hand.waiting()).toEqual([OUTBOX_POLL_MS]);
    expect(sent).toHaveLength(2);
  });

  it('comes back when the earliest retry is due, sooner than the poll', async () => {
    const { cells, sent, answerWith } = handCells();
    answerWith(async () => ({ kind: 'failed', error: 'status 503 (unavailable)' }));
    const { worker, hand, makeAcme } = await workerWith(cells);
    const acme = await makeAcme();

    worker.start();
    await passEnded(hand);
    expect(hand.waiting()).toEqual([1000]);
    expect(lines).toEqual([
      `warn Outbox: could not deliver message 1 of workspace ${acme} (status 503 (unavailable)); attempt 1, next in 1 s.`,
    ]);

    clock = new Date(clock.getTime() + 1000);
    hand.fire();
    await passEnded(hand);
    expect(sent).toHaveLength(2);
    expect(hand.waiting()).toEqual([2000]);
    expect(lines.at(-1)).toContain('attempt 2, next in 2 s.');
  });

  it('says once that a region has messages and no cell, and keeps them', async () => {
    const { cells, sent } = handCells([]);
    const { worker, hand, makeAcme } = await workerWith(cells);
    await makeAcme();

    worker.start();
    await passEnded(hand);
    hand.fire();
    await passEnded(hand);

    expect(sent).toEqual([]);
    expect(hand.waiting()).toEqual([OUTBOX_POLL_MS]);
    expect(lines).toEqual([
      'warn Outbox: eu has messages and no cell (CELL_URL_EU is not set), so they wait.',
    ]);
  });

  it('logs a pass that fails and tries again at the next poll', async () => {
    const { cells, sent } = handCells();
    let failures = 1;
    const { worker, hand, makeAcme } = await workerWith(cells, (store) => ({
      ...store,
      async firstUndelivered() {
        if (failures-- > 0) throw new Error('the database is gone\nwith a second line');
        return store.firstUndelivered();
      },
    }));
    await makeAcme();

    worker.start();
    await passEnded(hand);
    expect(lines).toEqual([
      'error Outbox: a delivery pass failed (Error: the database is gone); trying again in 10 s.',
    ]);
    expect(hand.waiting()).toEqual([OUTBOX_POLL_MS]);

    hand.fire();
    await passEnded(hand);
    expect(sent).toHaveLength(2);
  });

  it('stops: the delivery in flight is abandoned, and no pass starts again', async () => {
    const { cells, sent, answerWith } = handCells();
    answerWith(
      (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ kind: 'stopped' }));
        }),
    );
    const { worker, hand, makeAcme } = await workerWith(cells);
    await makeAcme();
    worker.start();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    await worker.stop();

    expect(hand.waiting()).toEqual([]);
    worker.wake();
    worker.start();
    expect(sent).toHaveLength(1);
    const [row] = await db.select().from(schema.outboxMessage).limit(1);
    expect(row).toMatchObject({ attempts: 0, lastError: null });
  });

  it('sends nothing before it starts, even when woken', async () => {
    const { cells, sent } = handCells();
    const { worker, hand, makeAcme } = await workerWith(cells);
    await makeAcme();
    worker.wake();
    expect(sent).toEqual([]);
    expect(hand.waiting()).toEqual([]);
  });

  it('logs ids and statuses, never a signed message or the key', async () => {
    const { cells, sent, answerWith } = handCells();
    let calls = 0;
    answerWith(async () =>
      calls++ === 0
        ? { kind: 'failed', error: 'no connection (ECONNREFUSED)' }
        : { kind: 'confirmed', status: 200 },
    );
    const { worker, hand, makeAcme } = await workerWith(cells);
    await makeAcme();
    worker.start();
    await passEnded(hand);
    clock = new Date(clock.getTime() + 1000);
    hand.fire();
    await passEnded(hand);

    expect(sent).toHaveLength(3);
    const logged = lines.join('\n');
    for (const signed of sent) {
      for (const part of signed.split('.')) expect(logged).not.toContain(part);
    }
    expect(logged).not.toContain(key.d);
    expect(logged).not.toContain('dana');
    expect(logged).not.toContain('Dana');
  });
});
