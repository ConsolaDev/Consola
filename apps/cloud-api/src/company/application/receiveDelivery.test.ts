import type { OutboxMessage, WorkspaceChange } from '@consola/cloud-contract';
import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import type { Database } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import { workspaceMembers, workspaces } from '../adapters/persistence/tables.js';
import type { DeliveryCheck, DeliveryVerifier, WorkspaceCopies } from './ports.js';
import { receiveDelivery } from './receiveDelivery.js';

let db: Database;
let close: () => Promise<void>;
let workspaceCopies: WorkspaceCopies;

beforeEach(async () => {
  const opened = openDatabase('pglite:memory');
  db = opened.db;
  // Once only: a test may close it first.
  let closed = false;
  close = async () => {
    if (closed) return;
    closed = true;
    await opened.close();
  };
  await migrateDatabase(db);
  ({ workspaceCopies } = createDrizzleStores(db));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

/** A verifier that takes every delivery as signed, its body being its payload. */
const signedAsSent: DeliveryVerifier = {
  async verify(delivery) {
    return { kind: 'verified', payload: new TextEncoder().encode(delivery) };
  },
};

/** A verifier that answers `check` for every delivery. */
const answering = (check: DeliveryCheck): DeliveryVerifier => ({ verify: async () => check });

const message = (
  sequence: number,
  change: WorkspaceChange,
  overrides: Partial<OutboxMessage> = {},
): OutboxMessage => ({ workspaceId: 'acme', region: 'eu', sequence, change, ...overrides });

const created = (overrides: Partial<OutboxMessage> = {}) =>
  message(1, { type: 'workspace.created' }, overrides);

/** Delivers `value` as JSON to the eu cell, signed as sent. */
const deliver = (value: unknown, deliveries: DeliveryVerifier = signedAsSent) =>
  receiveDelivery({ deliveries, workspaceCopies }, 'eu', JSON.stringify(value));

async function tables() {
  return {
    workspaces: await db.select().from(workspaces).orderBy(asc(workspaces.workspaceId)),
    members: await db
      .select()
      .from(workspaceMembers)
      .orderBy(asc(workspaceMembers.workspaceId), asc(workspaceMembers.personId)),
  };
}

describe('receiveDelivery', () => {
  it('refuses what the signature check refuses, without reading or applying anything', async () => {
    const lastApplied = vi.spyOn(workspaceCopies, 'lastApplied');
    for (const check of [
      { kind: 'unsigned', reason: 'its signature does not check' },
      { kind: 'keys-unavailable' },
    ] as const) {
      expect(await deliver(created(), answering(check))).toEqual(check);
    }
    expect(lastApplied).not.toHaveBeenCalled();
    expect(await tables()).toEqual({ workspaces: [], members: [] });
  });

  it('refuses a signed payload that is no message, with the reason, applying nothing', async () => {
    const payload = (bytes: number[]): DeliveryVerifier =>
      answering({ kind: 'verified', payload: new Uint8Array(bytes) });
    const json = (text: string) => payload([...new TextEncoder().encode(text)]);

    expect(await deliver(null, payload([0xff, 0xfe]))).toEqual({
      kind: 'unreadable',
      reason: 'the payload is not UTF-8',
    });
    expect(await deliver(null, json('{"workspaceId":'))).toEqual({
      kind: 'unreadable',
      reason: 'the payload is not JSON',
    });
    expect(await deliver({ ...created(), email: 'dana@acme.test' })).toEqual({
      kind: 'unreadable',
      reason: 'the message has `email`, which the contract does not name',
    });
    expect(await deliver(message(1, { type: 'member.removed', personId: 'person-dana' }))).toEqual({
      kind: 'unreadable',
      reason: "a workspace's first message is not its `workspace.created`",
    });
    expect(await tables()).toEqual({ workspaces: [], members: [] });
  });

  it("refuses another region's message before looking at its sequence", async () => {
    const lastApplied = vi.spyOn(workspaceCopies, 'lastApplied');
    const sprocket = created({ workspaceId: 'sprocket', region: 'us' });
    expect(await deliver(sprocket)).toEqual({ kind: 'other-region', message: sprocket });
    // A gap too: the region is judged first.
    const later = message(
      5,
      { type: 'member.removed', personId: 'person-dana' },
      {
        workspaceId: 'sprocket',
        region: 'us',
      },
    );
    expect((await deliver(later)).kind).toBe('other-region');
    expect(lastApplied).not.toHaveBeenCalled();
    expect(await tables()).toEqual({ workspaces: [], members: [] });
  });

  it('applies a workspace through its whole life, in order', async () => {
    const steps: OutboxMessage[] = [
      created(),
      message(2, { type: 'member.added', personId: 'person-dana', role: 'owner' }),
      message(3, { type: 'member.added', personId: 'person-eli', role: 'member' }),
      message(4, { type: 'member.role-changed', personId: 'person-eli', role: 'admin' }),
      message(5, { type: 'member.added', personId: 'person-fay', role: 'member' }),
      message(6, { type: 'member.removed', personId: 'person-fay' }),
    ];
    for (const step of steps) {
      expect(await deliver(step)).toEqual({ kind: 'applied', message: step, now: true });
    }
    expect(await tables()).toEqual({
      workspaces: [{ workspaceId: 'acme', lastAppliedSequence: 6 }],
      members: [
        { workspaceId: 'acme', personId: 'person-dana', role: 'owner' },
        { workspaceId: 'acme', personId: 'person-eli', role: 'admin' },
      ],
    });
  });

  it('changes nothing the second time it gets a message, nor for any it has applied', async () => {
    const added = message(2, { type: 'member.added', personId: 'person-dana', role: 'owner' });
    const changed = message(3, {
      type: 'member.role-changed',
      personId: 'person-dana',
      role: 'member',
    });
    await deliver(created());
    await deliver(added);
    await deliver(changed);
    const before = await tables();

    // Sent again, each would undo what came after it if it were applied.
    for (const again of [changed, added, created()]) {
      expect(await deliver(again)).toEqual({ kind: 'applied', message: again, now: false });
    }
    expect(await tables()).toEqual(before);
  });

  it('answers out of order for a workspace it holds nothing of, naming the first sequence', async () => {
    const added = message(2, { type: 'member.added', personId: 'person-dana', role: 'owner' });
    expect(await deliver(added)).toEqual({ kind: 'out-of-order', message: added, nextSequence: 1 });
    expect(await tables()).toEqual({ workspaces: [], members: [] });
  });

  it('answers out of order across a gap, naming the next sequence, and applies nothing', async () => {
    await deliver(created());
    await deliver(message(2, { type: 'member.added', personId: 'person-dana', role: 'owner' }));
    const before = await tables();
    const ahead = message(4, { type: 'member.removed', personId: 'person-dana' });
    expect(await deliver(ahead)).toEqual({ kind: 'out-of-order', message: ahead, nextSequence: 3 });
    expect(await tables()).toEqual(before);
  });

  it('applies a message delivered many times at once exactly once', async () => {
    const answers = await Promise.all(Array.from({ length: 8 }, () => deliver(created())));
    expect(answers.filter((answer) => answer.kind === 'applied' && answer.now)).toHaveLength(1);
    expect(answers.every((answer) => answer.kind === 'applied')).toBe(true);

    const added = message(2, { type: 'member.added', personId: 'person-dana', role: 'owner' });
    const again = await Promise.all(Array.from({ length: 8 }, () => deliver(added)));
    expect(again.filter((answer) => answer.kind === 'applied' && answer.now)).toHaveLength(1);
    expect(again.every((answer) => answer.kind === 'applied')).toBe(true);

    expect(await tables()).toEqual({
      workspaces: [{ workspaceId: 'acme', lastAppliedSequence: 2 }],
      members: [{ workspaceId: 'acme', personId: 'person-dana', role: 'owner' }],
    });
  });

  it('places a message again when another delivery moved the sequence under it', async () => {
    await deliver(created());
    const added = message(2, { type: 'member.added', personId: 'person-dana', role: 'owner' });
    // Another delivery applies #2 between this one's read and its compare-and-set.
    const applyAfter = workspaceCopies.applyAfter.bind(workspaceCopies);
    vi.spyOn(workspaceCopies, 'applyAfter').mockImplementationOnce(async (step) => {
      await applyAfter(step);
      return applyAfter(step);
    });
    expect(await deliver(added)).toEqual({ kind: 'applied', message: added, now: false });
    expect((await tables()).workspaces).toEqual([{ workspaceId: 'acme', lastAppliedSequence: 2 }]);
  });

  it('applies the odd cases as states to reach, so the copy ends where cloud-global is', async () => {
    await deliver(created());
    await deliver(message(2, { type: 'member.added', personId: 'person-dana', role: 'owner' }));
    // Added while already a member: the message's role.
    await deliver(message(3, { type: 'member.added', personId: 'person-dana', role: 'admin' }));
    // A role change for someone the copy does not hold: they are added with it.
    await deliver(
      message(4, { type: 'member.role-changed', personId: 'person-eli', role: 'member' }),
    );
    // Removed while not a member: nothing to remove.
    await deliver(message(5, { type: 'member.removed', personId: 'person-fay' }));
    expect(await tables()).toEqual({
      workspaces: [{ workspaceId: 'acme', lastAppliedSequence: 5 }],
      members: [
        { workspaceId: 'acme', personId: 'person-dana', role: 'admin' },
        { workspaceId: 'acme', personId: 'person-eli', role: 'member' },
      ],
    });
  });

  it("keeps each workspace's order apart", async () => {
    await deliver(created());
    const sprocketFirst = created({ workspaceId: 'sprocket' });
    expect((await deliver(sprocketFirst)).kind).toBe('applied');
    const acmeSecond = message(2, { type: 'member.added', personId: 'person-dana', role: 'owner' });
    expect((await deliver(acmeSecond)).kind).toBe('applied');
    expect(await deliver({ ...acmeSecond, workspaceId: 'umbrella' })).toMatchObject({
      kind: 'out-of-order',
      nextSequence: 1,
    });
  });

  it('answers that the database is unavailable when it does not answer, naming why', async () => {
    await close();
    const answer = await deliver(created());
    expect(answer).toMatchObject({ kind: 'database-unavailable', message: created() });
    expect(answer.kind === 'database-unavailable' && answer.reason).toMatch(/closed/i);
  });
});
