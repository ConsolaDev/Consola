import { PASS_AUDIENCE, readPassClaims } from '@consola/runner-protocol';
import type { FollowUp } from '@consola/runner-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCloudSessionStore } from '../adapters/persistence/cloudSessions.js';
import { openTestDatabase } from '../adapters/persistence/database.test-helpers.js';
import type { Database } from '../adapters/persistence/database.js';
import type { CloudSession } from '../domain/cloudSession.js';
import { FOLLOW_UP_PASS_SECONDS } from '../domain/followUp.js';
import { sendFollowUp } from './followUps.js';
import type { FollowUpRequest } from './followUps.js';
import type { FollowUpPorts, HostFollowUpAnswer, PassSigner } from './ports.js';

let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
});
afterEach(async () => {
  await close();
});

const HOST_URL = 'https://7420-sandbox-sprocket.example.dev';

/** An agent run of `acme`, running, its host at `HOST_URL`. */
const agentRun = (over: Partial<CloudSession> = {}): CloudSession => ({
  id: 'session-run-1',
  workspaceId: 'acme',
  personId: null,
  repository: 'sprocket/catalog-portal',
  harness: 'claude',
  status: 'running',
  title: 'review-pull-requests · sprocket/catalog-portal#7 Price the catalog in euros',
  hostUrl: HOST_URL,
  error: null,
  errorCode: null,
  runnerId: 'runner-1',
  createdAt: 900,
  endedAt: null,
  origin: {
    kind: 'automation',
    factoryId: 'factory-1',
    factoryName: 'Reviews',
    automation: 'review-pull-requests',
    agent: 'orchestrator',
    item: {
      kind: 'pull_request',
      repository: 'sprocket/catalog-portal',
      number: 7,
      url: 'https://github.com/sprocket/catalog-portal/pull/7',
      title: 'Price the catalog in euros',
      headSha: 'a'.repeat(40),
    },
  },
  agentRun: { state: 'working' },
  ...over,
});

const request: FollowUpRequest = {
  key: 'slack:Ev0A1B2C3D4E',
  text: 'Please also check the cart page.',
  author: { personId: 'person-1', label: 'a teammate in Slack' },
};

/** Signs nothing: a pass here is its claims, as JSON, so a test can read what was signed. */
const passSigner: PassSigner = { sign: async (claims) => `pass:${JSON.stringify(claims)}` };

type Sent = { hostUrl: string; pass: string; followUp: FollowUp };

/**
 * A host that keeps what it was sent and answers as t3 would: `delivered` for a key it has not
 * seen, `already-delivered` for one it has; or always `answer`, when one is given.
 */
function setup(options: { answer?: HostFollowUpAnswer; passes?: PassSigner | null } = {}) {
  const sent: Sent[] = [];
  const seen = new Set<string>();
  const ports: FollowUpPorts = {
    sessions: createCloudSessionStore(db),
    clock: { nowSeconds: () => 1000 },
    passes: options.passes === undefined ? passSigner : options.passes,
    hosts: {
      sendFollowUp: async (hostUrl, pass, followUp) => {
        sent.push({ hostUrl, pass, followUp });
        if (options.answer !== undefined) return options.answer;
        if (seen.has(followUp.key)) return 'already-delivered';
        seen.add(followUp.key);
        return 'delivered';
      },
    },
  };
  return { ports, sent };
}

const target = { workspaceId: 'acme', sessionId: 'session-run-1' };

describe('sendFollowUp', () => {
  it('sends the follow-up to the run’s host with a short pass for its author', async () => {
    const { ports, sent } = setup();
    await ports.sessions.insert(agentRun());

    expect(await sendFollowUp(ports, target, request)).toEqual({ kind: 'delivered' });
    expect(sent).toHaveLength(1);
    const [first] = sent;
    expect(first?.hostUrl).toBe(HOST_URL);
    expect(first?.followUp).toEqual({
      key: 'slack:Ev0A1B2C3D4E',
      text: 'Please also check the cart page.',
      authorLabel: 'a teammate in Slack',
    });
    const claims = JSON.parse(first?.pass.replace(/^pass:/, '') ?? 'null');
    expect(claims).toEqual({
      aud: PASS_AUDIENCE,
      sub: 'person-1',
      ws: 'acme',
      sid: 'session-run-1',
      iat: 1000,
      exp: 1000 + FOLLOW_UP_PASS_SECONDS,
    });
    expect(readPassClaims(claims).ok).toBe(true);
  });

  it('is already delivered when the same key comes again, whatever it says', async () => {
    const { ports, sent } = setup();
    await ports.sessions.insert(agentRun());
    expect(await sendFollowUp(ports, target, request)).toEqual({ kind: 'delivered' });
    expect(await sendFollowUp(ports, target, { ...request, text: 'Again.' })).toEqual({
      kind: 'already_delivered',
    });
    expect(sent.map((each) => each.followUp.key)).toEqual([request.key, request.key]);
  });

  it.each([
    ['still starting', { status: 'starting', hostUrl: null }, 'starting'],
    ['running with no host address yet', { hostUrl: null }, 'starting'],
    ['stopped', { status: 'stopped', endedAt: 1000 }, 'not_running'],
    ['failed', { status: 'failed', endedAt: 1000, errorCode: 'runner_restarted' }, 'not_running'],
    [
      'a person’s own session',
      { personId: 'person-1', origin: null, agentRun: null },
      'not_running',
    ],
  ] as const)('sends nothing to a run %s: %s', async (_, over, kind) => {
    const { ports, sent } = setup();
    await ports.sessions.insert(agentRun(over));
    expect(await sendFollowUp(ports, target, request)).toEqual({ kind });
    expect(sent).toEqual([]);
  });

  it('finds no run of another workspace, nor one it does not hold', async () => {
    const { ports, sent } = setup();
    await ports.sessions.insert(agentRun({ workspaceId: 'globex' }));
    expect(await sendFollowUp(ports, target, request)).toEqual({ kind: 'not_running' });
    expect(
      await sendFollowUp(ports, { workspaceId: 'acme', sessionId: 'session-none' }, request),
    ).toEqual({ kind: 'not_running' });
    expect(sent).toEqual([]);
  });

  it.each([
    ['a key with a space', { ...request, key: 'Ev 1' }, "`key` is not a follow-up's key"],
    ['a blank text', { ...request, text: '  ' }, '`text` is not text of 1 to 40000 characters'],
    [
      'a label on two lines',
      { ...request, author: { personId: 'person-1', label: 'a teammate\nConsola' } },
      '`authorLabel` is not one line of 1 to 100 characters',
    ],
    [
      'no person',
      { ...request, author: { personId: '', label: 'a teammate' } },
      "the author's person id is empty",
    ],
  ])('refuses %s before it reads or sends anything', async (_, invalid, reason) => {
    const { ports, sent } = setup();
    await ports.sessions.insert(agentRun());
    expect(await sendFollowUp(ports, target, invalid)).toEqual({ kind: 'invalid', reason });
    expect(sent).toEqual([]);
  });

  it.each([
    ['not-ready', 'starting'],
    ['not-here', 'not_running'],
    ['failed', 'host_unreachable'],
  ] as const)('reads the host’s %s as %s', async (answer, kind) => {
    const { ports } = setup({ answer });
    await ports.sessions.insert(agentRun());
    expect(await sendFollowUp(ports, target, request)).toEqual({ kind });
  });

  it('cannot reach a host without a pass key, and sends nothing', async () => {
    const { ports, sent } = setup({ passes: null });
    await ports.sessions.insert(agentRun());
    expect(await sendFollowUp(ports, target, request)).toEqual({ kind: 'host_unreachable' });
    expect(sent).toEqual([]);
  });
});
