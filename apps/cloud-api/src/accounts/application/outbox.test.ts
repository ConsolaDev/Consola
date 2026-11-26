import { generateKeyPairSync } from 'node:crypto';
import {
  CELL_TOKEN_ALGORITHM,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_MESSAGE_TYPE,
  readOutboxMessage,
} from '@consola/cloud-contract';
import type { OutboxMessage, Region } from '@consola/cloud-contract';
import { and, eq, sql } from 'drizzle-orm';
import { compactVerify, createLocalJWKSet } from 'jose';
import type { JSONWebKeySet } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCellTokenSigner } from '../adapters/cellToken/cellTokenSigner.js';
import { createCellDelivery } from '../adapters/outbox/cellDelivery.js';
import { migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import type { Database } from '../adapters/persistence/database.js';
import { schema } from '../adapters/persistence/schema.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { Ed25519PrivateJwk } from '../config.js';
import { deliverOutbox } from './outbox.js';
import type { CellDelivery, OutboxStore, WorkspaceStore } from './ports.js';

const ACME_CELL = 'http://127.0.0.1:3101';
const SPROCKET_CELL = 'http://127.0.0.1:3102';

/**
 * A scripted answer: a status (and body); a connection refused, so the cell never sees the
 * request; or a hang, where the cell handles the request and its answer never arrives.
 */
type Scripted = { status: number; body?: unknown } | 'refuse-connection' | 'hang';

/**
 * A regional cell as the contract has one answer: it checks the signature against the published
 * keys (EdDSA alone, its `typ`), reads the message, checks its region, then its sequence, and
 * applies a workspace's messages in order, answering 200 for one it applied before. A test can
 * script its answers instead.
 */
function fakeCell(region: Region, keys: () => JSONWebKeySet) {
  const next = new Map<string, number>();
  const cell = {
    /** Every message that reached it, in the order it came, applied or not. */
    received: [] as OutboxMessage[],
    /** What it answers next, one entry a request. */
    script: [] as Scripted[],
    /** What it answers every request the script does not, while set. */
    always: null as Scripted | null,
    async handle(
      request: Request,
      scripted: { status: number; body?: unknown } | null,
    ): Promise<Response> {
      if (request.headers.get('content-type') !== OUTBOX_DELIVERY_MEDIA_TYPE) {
        return new Response(null, { status: 400 });
      }
      let message: OutboxMessage;
      try {
        const { payload, protectedHeader } = await compactVerify(
          await request.text(),
          createLocalJWKSet(keys()),
          { algorithms: [CELL_TOKEN_ALGORITHM] },
        );
        if (protectedHeader.typ !== OUTBOX_MESSAGE_TYPE) return new Response(null, { status: 401 });
        const read = readOutboxMessage(JSON.parse(new TextDecoder().decode(payload)));
        if (!read.ok) return new Response(null, { status: 400 });
        message = read.value;
      } catch {
        return new Response(null, { status: 401 });
      }
      cell.received.push(message);
      if (scripted) return Response.json(scripted.body ?? null, { status: scripted.status });
      if (message.region !== region) return new Response(null, { status: 421 });
      const expected = next.get(message.workspaceId) ?? 1;
      if (message.sequence > expected) {
        return Response.json({ nextSequence: expected }, { status: 409 });
      }
      if (message.sequence === expected) next.set(message.workspaceId, expected + 1);
      return Response.json({ applied: message.sequence });
    },
  };
  return cell;
}

type Cell = ReturnType<typeof fakeCell>;

/**
 * `fetch` as the cells answer it: each origin goes to its cell, a refused connection fails as
 * Node's `fetch` does, and a hang keeps the answer until the request is abandoned.
 */
function fetchTo(cells: Record<string, Cell>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const cell = cells[new URL(request.url).origin];
    if (!cell) throw new TypeError('fetch failed');
    const scripted = cell.script.shift() ?? cell.always;
    if (scripted === 'refuse-connection') {
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3101'), {
        code: 'ECONNREFUSED',
      });
      throw new TypeError('fetch failed', { cause });
    }
    if (scripted !== 'hang') return cell.handle(request, scripted);
    await cell.handle(request, null);
    // As `fetch` does: a request stopped before it waits rejects at once. Checking the message
    // takes long enough on a busy machine that the stop can land first, and a listener added
    // after it would never hear it.
    return new Promise<Response>((_resolve, reject) => {
      if (request.signal.aborted) reject(request.signal.reason);
      else request.signal.addEventListener('abort', () => reject(request.signal.reason));
    });
  };
}

let db: Database;
let close: () => Promise<void>;
let workspaces: WorkspaceStore;
let outbox: OutboxStore;
let signer: Awaited<ReturnType<typeof createCellTokenSigner>>;
let acmeCell: Cell;
let sprocketCell: Cell;
let cells: CellDelivery;
let clock: Date;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values([
    { id: 'person-dana', name: 'Dana Ortiz', email: 'dana@acme.test', emailVerified: true },
    { id: 'person-lee', name: 'Lee Park', email: 'lee@sprocket.test', emailVerified: true },
  ]);
  const stores = createDrizzleStores(db);
  ({ workspaces, outbox } = stores);
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  signer = await createCellTokenSigner(key as Ed25519PrivateJwk);
  acmeCell = fakeCell('eu', () => signer.publicKeys());
  sprocketCell = fakeCell('us', () => signer.publicKeys());
  cells = createCellDelivery({
    cellUrls: { eu: ACME_CELL, us: SPROCKET_CELL },
    fetch: fetchTo({ [ACME_CELL]: acmeCell, [SPROCKET_CELL]: sprocketCell }),
    timeoutMs: 50,
  });
  clock = new Date('2026-11-22T10:00:00Z');
});

afterEach(async () => {
  await close();
});

const pass = (options: { cells?: CellDelivery; signal?: AbortSignal } = {}) =>
  deliverOutbox(
    { outbox, signer, cells: options.cells ?? cells },
    { now: () => clock, signal: options.signal },
  );

const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

async function make(slug: string, region: Region, owner: string): Promise<string> {
  const made = await workspaces.create(
    { name: slug, slug, region },
    { userId: owner, role: 'owner' },
  );
  if (made.kind !== 'created') throw new Error('not created');
  return made.workspace.id;
}

const rowOf = async (workspaceId: string, sequence: number) => {
  const [row] = await db
    .select()
    .from(schema.outboxMessage)
    .where(
      and(
        eq(schema.outboxMessage.organizationId, workspaceId),
        eq(schema.outboxMessage.sequence, sequence),
      ),
    );
  return row;
};

const sequencesOf = (cell: Cell, workspaceId: string) =>
  cell.received.filter((m) => m.workspaceId === workspaceId).map((m) => m.sequence);

describe('delivering the outbox', () => {
  it("a 2xx confirms: a new workspace's messages reach its cell, in order, signed", async () => {
    const acme = await make('acme', 'eu', 'person-dana');

    const done = await pass();

    expect(acmeCell.received).toEqual([
      { workspaceId: acme, region: 'eu', sequence: 1, change: { type: 'workspace.created' } },
      {
        workspaceId: acme,
        region: 'eu',
        sequence: 2,
        change: { type: 'member.added', personId: 'person-dana', role: 'owner' },
      },
    ]);
    expect(done).toEqual({
      outcomes: [
        { kind: 'delivered', key: { workspaceId: acme, sequence: 1 }, attempts: 1, status: 200 },
        { kind: 'delivered', key: { workspaceId: acme, sequence: 2 }, attempts: 1, status: 200 },
      ],
      waiting: [],
      nextDueAt: null,
    });
    expect(await rowOf(acme, 1)).toMatchObject({
      deliveredAt: clock,
      attempts: 1,
      lastError: null,
    });
    expect(await outbox.firstUndelivered()).toEqual([]);

    // Nothing is sent again.
    await pass();
    expect(acmeCell.received).toHaveLength(2);
  });

  it.each<[string, Scripted, string]>([
    ['a 500', { status: 500 }, 'status 500'],
    ['a 503', { status: 503 }, 'status 503 (unavailable)'],
    [
      'a 409',
      { status: 409, body: { nextSequence: 1 } },
      'status 409 (outOfOrder): the cell applies sequence 1 next',
    ],
    [
      'a 409 that does not read',
      { status: 409, body: { next: 1 } },
      'status 409 (outOfOrder): the answer has no `nextSequence`',
    ],
    ['a 401', { status: 401 }, 'status 401 (unsigned)'],
    ['a 400', { status: 400 }, 'status 400 (unreadable)'],
    ['a 421', { status: 421 }, 'status 421 (otherRegion)'],
    ['a redirect', { status: 307 }, 'status 307'],
    ['a network error', 'refuse-connection', 'no connection (ECONNREFUSED)'],
    ['no answer in time', 'hang', 'no answer within 50 ms'],
  ])(
    '%s is retried, waiting longer each time, until the cell confirms',
    async (_what, answer, error) => {
      const acme = await make('acme', 'eu', 'person-dana');
      acmeCell.script = [answer, answer, answer];
      const start = clock.getTime();

      // The first try fails, and the next is due a second later.
      expect((await pass()).outcomes).toEqual([
        {
          kind: 'failed',
          key: { workspaceId: acme, sequence: 1 },
          attempts: 1,
          error,
          nextAttemptAt: new Date(start + 1000),
        },
      ]);
      expect(await rowOf(acme, 1)).toMatchObject({
        attempts: 1,
        lastError: error,
        lastAttemptAt: new Date(start),
        nextAttemptAt: new Date(start + 1000),
        deliveredAt: null,
      });

      // Not before it is due.
      later(999);
      const early = await pass();
      expect(early.outcomes).toEqual([]);
      expect(early.nextDueAt).toEqual(new Date(start + 1000));

      // Then two seconds, then four: the wait grows.
      later(1);
      expect((await pass()).outcomes).toEqual([
        expect.objectContaining({
          kind: 'failed',
          attempts: 2,
          nextAttemptAt: new Date(start + 3000),
        }),
      ]);
      later(2000);
      expect((await pass()).outcomes).toEqual([
        expect.objectContaining({
          kind: 'failed',
          attempts: 3,
          nextAttemptAt: new Date(start + 7000),
        }),
      ]);

      // The cell answers at last: the message is delivered, and the next one at once after it.
      later(4000);
      expect((await pass()).outcomes).toEqual([
        { kind: 'delivered', key: { workspaceId: acme, sequence: 1 }, attempts: 4, status: 200 },
        { kind: 'delivered', key: { workspaceId: acme, sequence: 2 }, attempts: 1, status: 200 },
      ]);
      expect(await rowOf(acme, 1)).toMatchObject({
        attempts: 4,
        deliveredAt: clock,
        lastError: error,
      });
    },
  );

  it('never sends message 2 before the cell confirms message 1', async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    acmeCell.always = { status: 503 };

    for (let i = 0; i < 4; i++) {
      await pass();
      later(10 * 60_000);
    }
    // Only message 1, tried each time; message 2 stayed where it was.
    expect(sequencesOf(acmeCell, acme)).toEqual([1, 1, 1, 1]);
    expect(await rowOf(acme, 2)).toMatchObject({ attempts: 0, lastAttemptAt: null });

    acmeCell.always = null;
    await pass();
    expect(sequencesOf(acmeCell, acme)).toEqual([1, 1, 1, 1, 1, 2]);
  });

  it('sends a message again when its answer is lost, never the next one in its place', async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    // Message 1 reaches the cell, but its answer is lost: the outbox sends 1 again, which the
    // cell has applied already and confirms, and only then 2.
    acmeCell.script = ['hang'];
    await pass();
    later(1000);
    await pass();
    expect(sequencesOf(acmeCell, acme)).toEqual([1, 1, 2]);
    expect(await outbox.firstUndelivered()).toEqual([]);
  });

  it('two workspaces do not hold each other up', async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    const sprocket = await make('sprocket', 'us', 'person-lee');
    const acmeEu2 = await make('acme-two', 'eu', 'person-lee');
    // The EU cell refuses everything; the US cell is fine.
    acmeCell.always = { status: 503 };

    const done = await pass();

    expect(sequencesOf(sprocketCell, sprocket)).toEqual([1, 2]);
    expect(await outbox.firstUndeliveredOf(sprocket)).toBeNull();
    expect(sequencesOf(acmeCell, acme)).toEqual([1]);
    expect(sequencesOf(acmeCell, acmeEu2)).toEqual([1]);
    expect(done.outcomes.filter((o) => o.kind === 'delivered')).toHaveLength(2);
    expect(done.nextDueAt).toEqual(new Date(clock.getTime() + 1000));
  });

  it('a cell slow to answer holds up its own workspace alone', async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    const sprocket = await make('sprocket', 'us', 'person-lee');
    acmeCell.script = ['hang'];

    const done = await pass();

    expect(done.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'failed', key: { workspaceId: acme, sequence: 1 } }),
        expect.objectContaining({ kind: 'delivered', key: { workspaceId: sprocket, sequence: 2 } }),
      ]),
    );
  });

  it('a region with no cell keeps its messages as they are, and says so', async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    const sprocket = await make('sprocket', 'us', 'person-lee');
    const euOnly = createCellDelivery({
      cellUrls: { eu: ACME_CELL },
      fetch: fetchTo({ [ACME_CELL]: acmeCell }),
    });

    const done = await pass({ cells: euOnly });

    expect(done.waiting).toEqual(['us']);
    // Waiting is not a retry: nothing is due until a cell is configured.
    expect(done.nextDueAt).toBeNull();
    expect(sequencesOf(acmeCell, acme)).toEqual([1, 2]);
    expect(sprocketCell.received).toEqual([]);
    expect(await rowOf(sprocket, 1)).toMatchObject({
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      nextAttemptAt: null,
    });

    // Once the region has a cell, its messages go as if they had just been written.
    await pass();
    expect(sequencesOf(sprocketCell, sprocket)).toEqual([1, 2]);
  });

  it("never sends a stored message the contract's reader refuses, and says why", async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    // A row past the table's checks that no writer here makes: a person with an empty id.
    await db.execute(sql`insert into outbox_message
      (organization_id, sequence, region, change_type, person_id, role, created_at)
      values (${acme}, 3, 'eu', 'member.added', '', 'member', now())`);
    const unreadable = expect.objectContaining({
      kind: 'failed',
      key: { workspaceId: acme, sequence: 3 },
      error: "the stored message does not read: `change.personId` is not a person's id",
    });

    expect((await pass()).outcomes).toEqual([
      expect.objectContaining({ kind: 'delivered', key: { workspaceId: acme, sequence: 1 } }),
      expect.objectContaining({ kind: 'delivered', key: { workspaceId: acme, sequence: 2 } }),
      unreadable,
    ]);
    later(1000);
    expect((await pass()).outcomes).toEqual([unreadable]);
    // It is not sent, and never skipped: the workspace waits on it, where it can be seen.
    expect(sequencesOf(acmeCell, acme)).toEqual([1, 2]);
    expect(await rowOf(acme, 3)).toMatchObject({ attempts: 2, deliveredAt: null });
  });

  it('a pass stopped mid-delivery records nothing, so the message goes again later', async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    acmeCell.script = ['hang'];
    const stopping = new AbortController();
    const slow = createCellDelivery({
      cellUrls: { eu: ACME_CELL },
      fetch: fetchTo({ [ACME_CELL]: acmeCell }),
      timeoutMs: 60_000,
    });

    const running = pass({ cells: slow, signal: stopping.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stopping.abort();
    const done = await running;

    expect(done.outcomes).toEqual([]);
    expect(await rowOf(acme, 1)).toMatchObject({ attempts: 0, lastError: null, deliveredAt: null });
  });
});
