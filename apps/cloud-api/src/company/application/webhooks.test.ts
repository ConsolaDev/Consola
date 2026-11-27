import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookSignatures } from '../adapters/github/webhookSignatures.js';
import { createGitHubStores } from '../adapters/persistence/gitHubStores.js';
import * as gitHubTables from '../adapters/persistence/gitHubTables.js';
import type { GitHubEventStore, InstallationStore } from './gitHubPorts.js';
import type { AgentRunPorts, FactoryStore } from './ports.js';
import { receiveGitHubWebhook, recordGitHubEvent } from './webhooks.js';
import type { WebhookDelivery } from './webhooks.js';

let client: PGlite;
let db: PgliteDatabase;
let installations: InstallationStore;
let events: GitHubEventStore;

const SECRET = 'sprocket-test-webhook-secret-0123456789';
const signatures = createWebhookSignatures(SECRET);
const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const HEAD = 'a'.repeat(40);

beforeEach(async () => {
  client = new PGlite();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(gitHubTables),
  );
  for (const statement of statements) await client.exec(statement);
  db = drizzle(client);
  ({ installations, events } = createGitHubStores(db));
  await installations.connect({
    installation: {
      id: 41,
      account: { id: 9001, login: 'sprocket', type: 'Organization' },
    },
    workspaceId: 'sprocket',
    connectedBy: 'lee',
    at: new Date('2026-11-22T09:00:00Z'),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (!client.closed) await client.close();
});

/** The body GitHub POSTs when a pull request opens, as the agent runs read it. */
const pullRequestOpened = {
  action: 'opened',
  number: 7,
  pull_request: {
    number: 7,
    html_url: 'https://github.com/sprocket/catalog-portal/pull/7',
    title: 'Price the catalog in euros',
    body: 'Customers in Lyon asked.',
    draft: false,
    user: { login: 'octocat', type: 'User' },
    head: { sha: HEAD, ref: 'euros' },
    base: { ref: 'main' },
    labels: [],
  },
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

/**
 * What starting agent runs reads, as far as it gets for a workspace with no factory: the list of
 * its factories, counted, and the lines it reports. Nothing past the list is reached.
 */
function agentRunsWith(list: FactoryStore['list'] = async () => []) {
  const lines: string[] = [];
  const listed = vi.fn(list);
  const ports = {
    factories: { list: listed },
    report: (line: string) => {
      lines.push(line);
    },
  } as unknown as AgentRunPorts;
  return { ports, listed, lines };
}

const receive = (sent: WebhookDelivery, agentRuns?: AgentRunPorts) =>
  receiveGitHubWebhook({ signatures, installations, events, agentRuns }, sent);

const recorded = () =>
  db
    .select()
    .from(gitHubTables.gitHubEvents)
    .orderBy(asc(gitHubTables.gitHubEvents.workspaceId), asc(gitHubTables.gitHubEvents.deliveryId));

const named = { deliveryId: DELIVERY_ID, event: 'pull_request' };

describe('receiveGitHubWebhook', () => {
  it('records a signed event for the workspace that holds its installation, as GitHub sent it', async () => {
    expect(await receive(delivery(pullRequestOpened))).toEqual({
      kind: 'recorded',
      delivery: named,
      holding: { installationId: 41, workspaceId: 'sprocket' },
    });
    expect(await recorded()).toEqual([
      {
        workspaceId: 'sprocket',
        deliveryId: DELIVERY_ID,
        event: 'pull_request',
        installationId: 41,
        payload: JSON.stringify(pullRequestOpened),
        receivedAt: expect.any(Date),
      },
    ]);
  });

  it('checks the signature before anything else, and reads nothing it does not check', async () => {
    const holderOf = vi.spyOn(installations, 'holderOf');
    const record = vi.spyOn(events, 'record');
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
      expect(await receive(sent)).toEqual({ kind: 'bad-signature' });
    }
    expect(holderOf).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(await recorded()).toEqual([]);
  });

  it('refuses every delivery while no webhook secret is set', async () => {
    const answer = await receiveGitHubWebhook(
      { signatures: null, installations, events },
      delivery(pullRequestOpened),
    );
    expect(answer).toEqual({ kind: 'not-configured' });
    expect(await recorded()).toEqual([]);
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

  it("answers GitHub's ping and records it for no workspace", async () => {
    const ping = delivery({ zen: 'Keep it logically awesome.', hook_id: 1 }, { event: 'ping' });
    expect(await receive(ping)).toEqual({
      kind: 'ping',
      delivery: { deliveryId: DELIVERY_ID, event: 'ping' },
    });
    expect(await recorded()).toEqual([]);
  });

  it('drops an event through an installation no workspace holds', async () => {
    const elsewhere = { ...pullRequestOpened, installation: { id: 52 } };
    expect(await receive(delivery(elsewhere))).toEqual({
      kind: 'unknown-installation',
      delivery: named,
      installationId: 52,
    });
    expect(await recorded()).toEqual([]);
  });

  it('drops an event that came through no installation', async () => {
    const revoked = delivery(
      { action: 'revoked', sender: { login: 'lee' } },
      { event: 'github_app_authorization' },
    );
    expect(await receive(revoked)).toEqual({
      kind: 'no-installation',
      delivery: { deliveryId: DELIVERY_ID, event: 'github_app_authorization' },
    });
    expect(await recorded()).toEqual([]);
  });

  it('records a delivery once, however often it arrives, and calls the next ones duplicates', async () => {
    expect(await receive(delivery(pullRequestOpened))).toMatchObject({ kind: 'recorded' });
    const closed = { ...pullRequestOpened, action: 'closed' };
    expect(await receive(delivery(closed))).toEqual({
      kind: 'duplicate',
      delivery: named,
      holding: { installationId: 41, workspaceId: 'sprocket' },
    });

    const rows = await recorded();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? '')).toMatchObject({ action: 'opened' });
  });

  it('keeps a payload whatever it holds, a NUL character included', async () => {
    const edited = { ...pullRequestOpened, action: 'edited', comment: 'before\u0000after' };
    expect(await receive(delivery(edited))).toMatchObject({ kind: 'recorded' });
    expect(JSON.parse((await recorded())[0]?.payload ?? '')).toEqual(edited);
  });

  it('says the database did not answer, rather than throwing, whether for the holder or the record', async () => {
    const failing: GitHubEventStore = {
      record: async () => {
        throw new Error('Failed query: insert into "github_event"', {
          cause: new Error('the database is gone\nand a second line'),
        });
      },
    };
    expect(
      await receiveGitHubWebhook(
        { signatures, installations, events: failing },
        delivery(pullRequestOpened),
      ),
    ).toEqual({ kind: 'unavailable', delivery: named, reason: 'the database is gone' });

    await client.close();
    expect(await receive(delivery(pullRequestOpened))).toMatchObject({
      kind: 'unavailable',
      delivery: named,
    });
  });
});

describe('an event recorded now starts its agent runs', () => {
  it('starts them for a first delivery, and never for one sent again', async () => {
    const { ports, listed } = agentRunsWith();
    expect(await receive(delivery(pullRequestOpened), ports)).toMatchObject({ kind: 'recorded' });
    expect(listed).toHaveBeenCalledTimes(1);
    expect(listed).toHaveBeenCalledWith('sprocket');

    expect(await receive(delivery(pullRequestOpened), ports)).toMatchObject({
      kind: 'duplicate',
    });
    expect(listed).toHaveBeenCalledTimes(1);
  });

  it('starts none for a delivery that is refused or dropped', async () => {
    const { ports, listed } = agentRunsWith();
    await receive(delivery(pullRequestOpened, { signature: undefined }), ports);
    await receive(delivery({ ...pullRequestOpened, installation: { id: 52 } }), ports);
    await receive(delivery({ zen: 'Keep it logically awesome.' }, { event: 'ping' }), ports);
    expect(listed).not.toHaveBeenCalled();
  });

  it('records the event, and answers so, when starting its runs fails', async () => {
    const { ports, lines } = agentRunsWith(async () => {
      throw new Error('the factories could not be read');
    });
    expect(await receive(delivery(pullRequestOpened), ports)).toMatchObject({ kind: 'recorded' });
    expect(await recorded()).toHaveLength(1);
    expect(lines).toEqual([
      `GitHub delivery ${DELIVERY_ID} (pull_request) for workspace sprocket started no agent run: the factories could not be read`,
    ]);
  });
});

describe('recordGitHubEvent', () => {
  const event = {
    workspaceId: 'sprocket',
    deliveryId: DELIVERY_ID,
    event: 'pull_request',
    installationId: 41,
    payload: pullRequestOpened,
  };

  it('records an event once per workspace and delivery id', async () => {
    expect(await recordGitHubEvent({ events }, event)).toEqual({ kind: 'recorded', now: true });
    expect(await recordGitHubEvent({ events }, event)).toEqual({ kind: 'recorded', now: false });
    // The same delivery id in another workspace is another event.
    expect(await recordGitHubEvent({ events }, { ...event, workspaceId: 'acme' })).toEqual({
      kind: 'recorded',
      now: true,
    });
    expect(await recorded()).toHaveLength(2);
  });
});
