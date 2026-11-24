import { createHmac } from 'node:crypto';
import type { GitHubEventMessage, Region } from '@consola/cloud-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookSignatures } from '../adapters/github/webhookSignatures.js';
import { migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import type { Database } from '../adapters/persistence/database.js';
import { schema } from '../adapters/persistence/schema.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { CellEventAnswer, CellEvents, GitHubEventSigner, InstallationStore } from './ports.js';
import { receiveGitHubWebhook } from './webhooks.js';
import type { WebhookDelivery } from './webhooks.js';

let db: Database;
let close: () => Promise<void>;
let installations: InstallationStore;

const SECRET = 'sprocket-test-webhook-secret-0123456789';
const signatures = createWebhookSignatures(SECRET);
const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db
    .insert(schema.user)
    .values([{ id: 'lee', name: 'Lee', email: 'lee@sprocket.test', emailVerified: true }]);
  await db
    .insert(schema.organization)
    .values([
      { id: 'sprocket', name: 'Sprocket', slug: 'sprocket', region: 'us', createdAt: new Date() },
    ]);
  ({ installations } = createDrizzleStores(db));
  await installations.connect({
    installation: {
      id: 41,
      account: { id: 9001, login: 'sprocket', type: 'Organization' },
      repositorySelection: 'selected',
    },
    workspaceId: 'sprocket',
    connectedBy: 'lee',
    at: new Date('2026-11-22T09:00:00Z'),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

/** Signs nothing: says what it was asked to sign, so a test can read it back. */
const signer: GitHubEventSigner = {
  signGitHubEvent: async (event) => `signed:${JSON.stringify(event)}`,
};

/** Cells in each region named, each answering `answer`, keeping what they were passed. */
function cells(answer: CellEventAnswer = { kind: 'recorded' }, regions: Region[] = ['eu', 'us']) {
  const passed: Array<{ region: Region; event: GitHubEventMessage }> = [];
  const events: CellEvents = {
    reaches: (region) => regions.includes(region),
    pass: async (region, signed) => {
      passed.push({ region, event: JSON.parse(signed.slice('signed:'.length)) });
      return answer;
    },
  };
  return { events, passed };
}

const pullRequestOpened = {
  action: 'opened',
  number: 7,
  pull_request: { title: 'Price the catalog in euros' },
  repository: { full_name: 'sprocket/catalog-portal' },
  installation: { id: 41 },
};

/** A delivery as GitHub sends it: the body's bytes, signed with `secret`. */
function delivery(
  payload: unknown,
  overrides: Partial<WebhookDelivery> = {},
  secret = SECRET,
): WebhookDelivery {
  const body = new TextEncoder().encode(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
  );
  return {
    body,
    signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    event: 'pull_request',
    deliveryId: DELIVERY_ID,
    ...overrides,
  };
}

const receive = (sent: WebhookDelivery, events: CellEvents = cells().events) =>
  receiveGitHubWebhook({ signatures, installations, signer, cells: events }, sent);

describe('receiveGitHubWebhook', () => {
  it('passes a signed event on to the cell of the workspace that holds its installation', async () => {
    const { events, passed } = cells();
    expect(await receive(delivery(pullRequestOpened), events)).toEqual({
      kind: 'delivered',
      delivery: { deliveryId: DELIVERY_ID, event: 'pull_request' },
      passing: { installationId: 41, workspaceId: 'sprocket', region: 'us' },
    });
    expect(passed).toEqual([
      {
        region: 'us',
        event: {
          workspaceId: 'sprocket',
          region: 'us',
          deliveryId: DELIVERY_ID,
          event: 'pull_request',
          installationId: 41,
          payload: pullRequestOpened,
        },
      },
    ]);
  });

  it('checks the signature before anything else, and reads nothing it does not check', async () => {
    const holderOf = vi.spyOn(installations, 'holderOf');
    const { events, passed } = cells();
    for (const sent of [
      delivery(pullRequestOpened, { signature: undefined }),
      delivery(pullRequestOpened, {}, 'acme-webhook-secret-that-is-not-sprockets'),
      {
        ...delivery(pullRequestOpened),
        body: new TextEncoder().encode('{"installation":{"id":42}}'),
      },
      // Unsigned, a body and headers that would each be refused are never looked at.
      delivery('not json', { signature: 'sha256=00', event: undefined, deliveryId: undefined }),
    ]) {
      expect(await receive(sent, events)).toEqual({ kind: 'bad-signature' });
    }
    expect(holderOf).not.toHaveBeenCalled();
    expect(passed).toEqual([]);
  });

  it('refuses every delivery while no webhook secret is set', async () => {
    const { events, passed } = cells();
    const answer = await receiveGitHubWebhook(
      { signatures: null, installations, signer, cells: events },
      delivery(pullRequestOpened),
    );
    expect(answer).toEqual({ kind: 'not-configured' });
    expect(passed).toEqual([]);
  });

  it.each([
    [{ event: undefined }, 'it has no X-GitHub-Event'],
    [{ deliveryId: undefined }, 'it has no X-GitHub-Delivery'],
    [{ deliveryId: '../etc' }, "its X-GitHub-Delivery is not GitHub's id of a delivery"],
  ])('refuses a signed delivery whose headers do not read: %j', async (headers, reason) => {
    expect(await receive(delivery(pullRequestOpened, headers))).toEqual({
      kind: 'invalid',
      reason,
    });
  });

  it.each([
    ['not JSON', 'action=opened', 'its body is not JSON'],
    ['a JSON array', [pullRequestOpened], 'its body is not a JSON object'],
  ])('refuses a signed body that is %s', async (_what, payload, reason) => {
    expect(await receive(delivery(payload))).toEqual({ kind: 'invalid', reason });
  });

  it("answers GitHub's ping and passes it on to no cell", async () => {
    const { events, passed } = cells();
    const ping = delivery({ zen: 'Keep it logically awesome.', hook_id: 1 }, { event: 'ping' });
    expect(await receive(ping, events)).toEqual({
      kind: 'ping',
      delivery: { deliveryId: DELIVERY_ID, event: 'ping' },
    });
    expect(passed).toEqual([]);
  });

  it('drops an event through an installation no workspace holds', async () => {
    const { events, passed } = cells();
    const elsewhere = { ...pullRequestOpened, installation: { id: 52 } };
    expect(await receive(delivery(elsewhere), events)).toEqual({
      kind: 'unknown-installation',
      delivery: { deliveryId: DELIVERY_ID, event: 'pull_request' },
      installationId: 52,
    });
    expect(passed).toEqual([]);
  });

  it('drops an event that came through no installation', async () => {
    const revoked = delivery(
      { action: 'revoked', sender: { login: 'lee' } },
      {
        event: 'github_app_authorization',
      },
    );
    expect(await receive(revoked)).toEqual({
      kind: 'no-installation',
      delivery: { deliveryId: DELIVERY_ID, event: 'github_app_authorization' },
    });
  });

  it("says when the workspace's region has no cell", async () => {
    const { events, passed } = cells({ kind: 'recorded' }, ['eu']);
    expect(await receive(delivery(pullRequestOpened), events)).toMatchObject({
      kind: 'no-cell',
      passing: { region: 'us' },
    });
    expect(passed).toEqual([]);
  });

  it('calls a delivery the cell had already a duplicate', async () => {
    const { events } = cells({ kind: 'recorded-before' });
    expect(await receive(delivery(pullRequestOpened), events)).toMatchObject({
      kind: 'duplicate',
    });
  });

  it("says the cell did not take it, and why, so GitHub's Redeliver can send it again", async () => {
    const { events } = cells({ kind: 'failed', error: 'status 503 (unavailable)' });
    expect(await receive(delivery(pullRequestOpened), events)).toMatchObject({
      kind: 'failed',
      error: 'status 503 (unavailable)',
    });
  });
});
