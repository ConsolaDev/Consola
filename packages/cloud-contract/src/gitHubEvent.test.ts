import { describe, expect, it } from 'vitest';
import { CELL_TOKEN_KEYS_PATH } from './cellToken.js';
import {
  GITHUB_EVENT_ANSWER,
  GITHUB_EVENT_DELIVERY_MAX_BYTES,
  GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
  GITHUB_EVENT_DELIVERY_PATH,
  GITHUB_EVENT_TYPE,
  GITHUB_PAYLOAD_MAX_BYTES,
  type GitHubEventMessage,
  isGitHubDeliveryId,
  isGitHubEventName,
  readGitHubEventMessage,
} from './gitHubEvent.js';
import { OUTBOX_DELIVERY_PATH, OUTBOX_MESSAGE_TYPE } from './outboxDelivery.js';

/** A pull request opened in the `sprocket` organisation's repository, as GitHub sends it. */
const opened: GitHubEventMessage = {
  workspaceId: 'workspace-sprocket',
  region: 'us',
  deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  event: 'pull_request',
  installationId: 41,
  payload: {
    action: 'opened',
    number: 7,
    pull_request: { title: 'Price the catalog in euros', draft: false },
    repository: { full_name: 'sprocket/catalog-portal', private: true },
    installation: { id: 41, node_id: 'MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uNDE=' },
  },
};

const asSent = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const reasonFor = (value: unknown): string | null => {
  const result = readGitHubEventMessage(value);
  return result.ok ? null : result.reason;
};

describe('the GitHub event delivery', () => {
  it('is a path on the cell of its own, under /api', () => {
    expect(GITHUB_EVENT_DELIVERY_PATH.startsWith('/api/')).toBe(true);
    expect(GITHUB_EVENT_DELIVERY_PATH).not.toBe(OUTBOX_DELIVERY_PATH);
    expect(GITHUB_EVENT_DELIVERY_PATH).not.toBe(CELL_TOKEN_KEYS_PATH);
  });

  it('is a compact JWS, typed as an event, never as an outbox message or a token', () => {
    expect(GITHUB_EVENT_DELIVERY_MEDIA_TYPE).toBe('application/jose');
    expect(GITHUB_EVENT_TYPE).not.toBe(OUTBOX_MESSAGE_TYPE);
    expect(GITHUB_EVENT_TYPE.toUpperCase()).not.toBe('JWT');
  });

  it('takes, signed, any payload GitHub sends', () => {
    // A compact JWS carries its payload in base64url, four characters for every three bytes,
    // beside a header and a signature of well under a kilobyte.
    const largest = Math.ceil((GITHUB_PAYLOAD_MAX_BYTES + 1024) / 3) * 4 + 1024;
    expect(GITHUB_EVENT_DELIVERY_MAX_BYTES).toBeGreaterThanOrEqual(largest);
  });

  it('is confirmed by a 2xx alone, which says whether the cell had it already', () => {
    const statuses = Object.values(GITHUB_EVENT_ANSWER);
    expect(new Set(statuses).size).toBe(statuses.length);
    const confirming = statuses.filter((status) => status >= 200 && status < 300);
    expect(confirming.sort()).toEqual(
      [GITHUB_EVENT_ANSWER.recorded, GITHUB_EVENT_ANSWER.recordedBefore].sort(),
    );
  });
});

describe('isGitHubDeliveryId', () => {
  it('takes the GUID GitHub names a delivery with', () => {
    expect(isGitHubDeliveryId('72d3162e-cc78-11e3-81ab-4c9367dc0958')).toBe(true);
  });

  it.each([
    ['nothing', ''],
    ['a space', '72d3162e cc78'],
    ['a line break', '72d3162e\ncc78'],
    ['a slash', '../72d3162e'],
    ['too long an id', 'a'.repeat(65)],
    ['a number', 72],
  ])('refuses %s', (_what, value) => {
    expect(isGitHubDeliveryId(value)).toBe(false);
  });
});

describe('isGitHubEventName', () => {
  it.each(['pull_request', 'push', 'installation_repositories', 'check_run'])(
    'takes %s',
    (name) => {
      expect(isGitHubEventName(name)).toBe(true);
    },
  );

  it.each([
    ['nothing', ''],
    ['capitals', 'Pull_Request'],
    ['a dot', 'pull_request.opened'],
    ['a line break', 'push\n'],
    ['too long a name', `p${'a'.repeat(64)}`],
    ['a number', 1],
  ])('refuses %s', (_what, value) => {
    expect(isGitHubEventName(value)).toBe(false);
  });
});

describe('readGitHubEventMessage', () => {
  it('reads an event as it arrives', () => {
    expect(readGitHubEventMessage(asSent(opened))).toEqual({ ok: true, value: opened });
  });

  it.each([null, 'event', 1, [opened]])('refuses a message that is not an object: %j', (m) => {
    expect(reasonFor(m)).toBe('the message is not an object');
  });

  it.each(['workspaceId', 'region', 'deliveryId', 'event', 'installationId', 'payload'])(
    'refuses a message without %s',
    (name) => {
      const { [name as keyof GitHubEventMessage]: _left, ...rest } = opened;
      expect(reasonFor(rest)).toBe(`the message has no \`${name}\``);
    },
  );

  it('refuses a field on the message the contract does not name', () => {
    expect(reasonFor({ ...opened, signature: 'sha256=0' })).toBe(
      'the message has `signature`, which the contract does not name',
    );
  });

  it('refuses a workspace id that is not one', () => {
    expect(reasonFor({ ...opened, workspaceId: '' })).toBe("`workspaceId` is not a workspace's id");
  });

  it('refuses a region the contract does not list', () => {
    expect(reasonFor({ ...opened, region: 'apac' })).toBe('`region` is not a region');
  });

  it('refuses a delivery id that is not GitHub’s', () => {
    expect(reasonFor({ ...opened, deliveryId: 'not a guid' })).toBe(
      "`deliveryId` is not GitHub's id of a delivery",
    );
  });

  it('refuses an event name that is not one', () => {
    expect(reasonFor({ ...opened, event: 'pull_request.opened' })).toBe(
      "`event` is not the name of one of GitHub's events",
    );
  });

  it.each([0, -41, 4.1, '41', 2 ** 53])('refuses an installation id that is not one: %j', (id) => {
    expect(reasonFor({ ...opened, installationId: id })).toBe(
      '`installationId` is not a whole number from 1',
    );
  });

  it.each([null, 'opened', [1], 7])('refuses a payload that is not an object: %j', (payload) => {
    expect(reasonFor({ ...opened, payload })).toBe('`payload` is not an object');
  });

  it('refuses a payload about another installation than the message names', () => {
    const elsewhere = { ...opened.payload, installation: { id: 42 } };
    expect(reasonFor({ ...opened, payload: elsewhere })).toBe(
      '`payload.installation.id` is not `installationId`',
    );
    const { installation: _none, ...without } = opened.payload;
    expect(reasonFor({ ...opened, payload: without })).toBe(
      '`payload.installation.id` is not `installationId`',
    );
  });
});
