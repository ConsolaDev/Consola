import { describe, expect, it } from 'vitest';
import { FIRST_SEQUENCE, readOutboxMessage, WORKSPACE_CHANGE_TYPES } from './outbox.js';
import type { OutboxMessage } from './outbox.js';

const created: OutboxMessage = {
  workspaceId: 'workspace-sprocket',
  region: 'us',
  sequence: FIRST_SEQUENCE,
  change: { type: 'workspace.created' },
};

const added: OutboxMessage = {
  workspaceId: 'workspace-sprocket',
  region: 'us',
  sequence: 2,
  change: { type: 'member.added', personId: 'person-dana', role: 'owner' },
};

const roleChanged: OutboxMessage = {
  ...added,
  sequence: 3,
  change: { type: 'member.role-changed', personId: 'person-dana', role: 'member' },
};

const removed: OutboxMessage = {
  ...added,
  sequence: 4,
  change: { type: 'member.removed', personId: 'person-dana' },
};

const asSent = (message: unknown): unknown => JSON.parse(JSON.stringify(message));

const reasonFor = (message: unknown): string | null => {
  const result = readOutboxMessage(message);
  return result.ok ? null : result.reason;
};

describe('readOutboxMessage', () => {
  it.each([
    ['workspace.created', created],
    ['member.added', added],
    ['member.role-changed', roleChanged],
    ['member.removed', removed],
  ])('reads a %s message as it arrives', (_type, message) => {
    expect(readOutboxMessage(asSent(message))).toEqual({ ok: true, value: message });
  });

  it('has a message for each change type it names', () => {
    expect([created, added, roleChanged, removed].map((m) => m.change.type)).toEqual([
      ...WORKSPACE_CHANGE_TYPES,
    ]);
  });

  it.each([null, 'message', 1, [created]])('refuses a message that is not an object: %j', (m) => {
    expect(reasonFor(m)).toBe('the message is not an object');
  });

  it.each(['workspaceId', 'region', 'sequence', 'change'])(
    'refuses a message without %s',
    (name) => {
      const { [name as keyof OutboxMessage]: _left, ...rest } = added;
      expect(reasonFor(rest)).toBe(`the message has no \`${name}\``);
    },
  );

  it('refuses a field on the message the contract does not name', () => {
    expect(reasonFor({ ...added, sentAt: '2026-11-22T10:00:00Z' })).toBe(
      'the message has `sentAt`, which the contract does not name',
    );
  });

  it('refuses a message that carries anything else about the person', () => {
    const withEmail = { ...added, change: { ...added.change, email: 'dana@sprocket.test' } };
    expect(reasonFor(withEmail)).toBe(
      'the `member.added` change has `email`, which the contract does not name',
    );
    const withName = { ...removed, change: { ...removed.change, name: 'Dana' } };
    expect(reasonFor(withName)).toBe(
      'the `member.removed` change has `name`, which the contract does not name',
    );
  });

  it.each([
    ['an empty workspace', { workspaceId: '' }, "`workspaceId` is not a workspace's id"],
    ['a workspace that is no string', { workspaceId: 7 }, "`workspaceId` is not a workspace's id"],
    ['an unknown region', { region: 'ap' }, '`region` is not a region'],
    ['sequence 0', { sequence: 0 }, '`sequence` is not a whole number from 1'],
    ['a negative sequence', { sequence: -2 }, '`sequence` is not a whole number from 1'],
    ['a fraction', { sequence: 2.5 }, '`sequence` is not a whole number from 1'],
    ['a sequence as a string', { sequence: '2' }, '`sequence` is not a whole number from 1'],
    [
      'a sequence no number can hold',
      { sequence: 2 ** 60 },
      '`sequence` is not a whole number from 1',
    ],
    ['a change that is no object', { change: 'member.added' }, '`change` is not an object'],
  ])('refuses %s', (_case, change, reason) => {
    expect(reasonFor({ ...added, ...change })).toBe(reason);
  });

  it.each([
    [
      'an unknown type',
      { type: 'workspace.deleted' },
      '`change.type` is not a change the contract names',
    ],
    [
      'no type',
      { personId: 'person-dana', role: 'owner' },
      '`change.type` is not a change the contract names',
    ],
    [
      'no person',
      { type: 'member.added', role: 'owner' },
      'the `member.added` change has no `personId`',
    ],
    [
      'no role',
      { type: 'member.role-changed', personId: 'person-dana' },
      'the `member.role-changed` change has no `role`',
    ],
    [
      'a role on a removal',
      { type: 'member.removed', personId: 'person-dana', role: 'owner' },
      'the `member.removed` change has `role`, which the contract does not name',
    ],
    [
      'an empty person',
      { type: 'member.added', personId: '', role: 'owner' },
      "`change.personId` is not a person's id",
    ],
    [
      'an unknown role',
      { type: 'member.added', personId: 'person-dana', role: 'superuser' },
      '`change.role` is not a workspace role',
    ],
    [
      'several roles',
      { type: 'member.role-changed', personId: 'person-dana', role: 'admin,member' },
      '`change.role` is not a workspace role',
    ],
  ])('refuses a change with %s', (_case, change, reason) => {
    expect(reasonFor({ ...added, change })).toBe(reason);
  });

  it("refuses a workspace.created that is not the workspace's first message", () => {
    expect(reasonFor({ ...created, sequence: 2 })).toBe(
      "`workspace.created` is not the workspace's first message",
    );
  });

  it("refuses any other change as a workspace's first message", () => {
    expect(reasonFor({ ...added, sequence: FIRST_SEQUENCE })).toBe(
      "a workspace's first message is not its `workspace.created`",
    );
  });

  it('never puts what a field held in its reason', () => {
    const held = 'dana@sprocket.test';
    for (const message of [
      { ...added, region: held },
      { ...added, sequence: held },
      { ...added, change: { type: held } },
      { ...added, change: { ...added.change, role: held } },
    ]) {
      const reason = reasonFor(message);
      expect(reason).not.toBeNull();
      expect(reason).not.toContain(held);
    }
  });
});
