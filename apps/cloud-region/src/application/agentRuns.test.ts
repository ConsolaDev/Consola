import type { GitHubEventMessage } from '@consola/cloud-contract';
import {
  CODE_REVIEW_TEAM_FILES,
  matchPullRequestAutomations,
  parseAgentTeam,
  planAgentRun,
  pullRequestEventOf,
} from '@consola/factory-spec';
import { AGENT_RUN_FACTORY_DIR, SESSION_REPOSITORY_DIR } from '@consola/runner-protocol';
import type { AgentRun } from '@consola/runner-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import type { Database } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { Caller } from '../domain/caller.js';
import type { FactoryFile } from '../domain/factory.js';
import { startAgentRunsFor } from './agentRuns.js';
import { applyRunnerUpdate, getSession, listSessions, stopSession } from './cloudSessions.js';
import type {
  AgentRunPorts,
  CloudSessionPorts,
  DeliveryVerifier,
  FactoryStore,
  Offer,
  RunnerChannel,
  SessionStartRequest,
  TeamStore,
  WorkspaceCopies,
} from './ports.js';
import { receiveGitHubEvent } from './receiveGitHubEvent.js';

let db: Database;
let close: () => Promise<void>;
let workspaceCopies: WorkspaceCopies;
let teams: TeamStore;
let factories: FactoryStore;
let stores: ReturnType<typeof createDrizzleStores>;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  stores = createDrizzleStores(db);
  ({ workspaceCopies, teams, factories } = stores);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

const HEAD = 'a'.repeat(40);

/** The body GitHub POSTs for a pull request, as `pullRequestEventOf` reads it. */
const pullRequestPayload = (over: { action?: string; draft?: boolean; login?: string } = {}) => ({
  action: over.action ?? 'opened',
  number: 7,
  pull_request: {
    number: 7,
    html_url: 'https://github.com/sprocket/catalog-portal/pull/7',
    title: 'Price the catalog in euros',
    body: 'Customers in Lyon asked.',
    draft: over.draft ?? false,
    user: { login: over.login ?? 'octocat', type: 'User' },
    head: { sha: HEAD, ref: 'euros' },
    base: { ref: 'main' },
    labels: [],
  },
  repository: { full_name: 'sprocket/catalog-portal' },
  installation: { id: 41 },
});

let deliveries = 0;
const eventOf = (
  payload: Record<string, unknown> = pullRequestPayload(),
  over: Partial<GitHubEventMessage> = {},
): GitHubEventMessage => ({
  workspaceId: 'acme',
  region: 'eu',
  deliveryId: `delivery-${++deliveries}`,
  event: 'pull_request',
  installationId: 41,
  payload,
  ...over,
});

const offer: Offer = {
  runnerId: 'runner-1',
  repositories: ['sprocket/catalog-portal'],
  harnesses: ['claude'],
};

/** A runner channel that records what it was handed. */
function channelFor(connected: Offer | null) {
  const starts: Array<[string, SessionStartRequest]> = [];
  const channel: RunnerChannel = {
    connected: vi.fn(() => connected),
    startSession: vi.fn(async (runnerId: string, request: SessionStartRequest) => {
      starts.push([runnerId, request]);
    }),
    stopSession: vi.fn(async () => {}),
  };
  return { channel, starts };
}

function portsFor(connected: Offer | null = offer) {
  const { channel, starts } = channelFor(connected);
  const lines: string[] = [];
  let next = 0;
  const ports: AgentRunPorts & CloudSessionPorts = {
    sessions: stores.cloudSessions,
    runners: channel,
    ids: { newId: () => `run-${++next}` },
    clock: { nowSeconds: () => 1000 },
    passes: null,
    factories,
    report: (line) => lines.push(line),
  };
  return { ports, channel, starts, lines };
}

/** A verifier that takes every delivery as signed, its body being its payload. */
const signedAsSent: DeliveryVerifier = {
  async verify(delivery) {
    return { kind: 'verified', payload: new TextEncoder().encode(delivery) };
  },
};

const deliver = (ports: AgentRunPorts, event: GitHubEventMessage) =>
  receiveGitHubEvent(
    { events: signedAsSent, gitHubEvents: stores.gitHubEvents, agentRuns: ports },
    'eu',
    JSON.stringify(event),
  );

/** The cell holds Acme, with Dana (owner) and Fay (member) in its first team. */
async function holdAcme() {
  const changes: Array<Parameters<WorkspaceCopies['applyAfter']>[0]['change']> = [
    { kind: 'open-workspace' },
    { kind: 'put-member', personId: 'person-dana', role: 'owner' },
    { kind: 'put-member', personId: 'person-fay', role: 'member' },
  ];
  for (const [index, change] of changes.entries()) {
    await workspaceCopies.applyAfter({
      workspaceId: 'acme',
      sequence: index + 1,
      after: index === 0 ? null : index,
      change,
    });
  }
}

/** A factory of Acme's first team holding `files` as its latest version. */
async function factoryWith(files: readonly FactoryFile[], name = 'Reviews') {
  const [first] = await teams.list('acme');
  if (!first) throw new Error('Acme has no first team');
  const made = await factories.create('acme', { name, teamId: first.id, personId: 'person-dana' });
  if (typeof made === 'string') throw new Error(made);
  const saved = await factories.save('acme', made.id, {
    baseVersion: 1,
    files,
    personId: 'person-dana',
  });
  if (saved.kind !== 'saved') throw new Error(saved.kind);
  return made;
}

const caller = (personId: string): Caller =>
  ({ personId, workspaceId: 'acme', role: 'member', region: 'eu' }) as Caller;

describe('an event starts agent runs', () => {
  it("starts one foreman run for an opened pull request, with the plan's prompt and the head to check out", async () => {
    await holdAcme();
    const factory = await factoryWith(CODE_REVIEW_TEAM_FILES);
    const { ports, starts } = portsFor();

    expect(await deliver(ports, eventOf())).toMatchObject({ kind: 'recorded', now: true });

    const [run, ...others] = await stores.cloudSessions.listSeen('acme', 'person-fay');
    expect(others).toEqual([]);
    expect(run).toEqual({
      id: 'run-1',
      workspaceId: 'acme',
      personId: null,
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
      status: 'starting',
      title: 'review-pull-requests · sprocket/catalog-portal#7 Price the catalog in euros',
      hostUrl: null,
      error: null,
      errorCode: null,
      runnerId: 'runner-1',
      createdAt: 1000,
      endedAt: null,
      origin: {
        kind: 'automation',
        factoryId: factory.id,
        factoryName: 'Reviews',
        automation: 'review-pull-requests',
        agent: 'foreman',
        item: {
          kind: 'pull_request',
          repository: 'sprocket/catalog-portal',
          number: 7,
          url: 'https://github.com/sprocket/catalog-portal/pull/7',
          title: 'Price the catalog in euros',
          headSha: HEAD,
        },
      },
      agentRun: null,
    });

    // What the runner is handed is factory-spec's plan, with the pull request's head.
    const { team } = parseAgentTeam(CODE_REVIEW_TEAM_FILES);
    const event = pullRequestEventOf(pullRequestPayload());
    if (!event) throw new Error('the payload does not read');
    const [automation] = matchPullRequestAutomations(team, event);
    if (!automation) throw new Error('nothing matched');
    const plan = planAgentRun(team, automation, event, {
      factoryDir: AGENT_RUN_FACTORY_DIR,
      repositoryDir: SESSION_REPOSITORY_DIR,
      runId: 'run-1',
    });
    expect(starts).toHaveLength(1);
    const [runnerId, request] = starts[0] ?? [];
    expect(runnerId).toBe('runner-1');
    expect(request).toMatchObject({
      sessionId: 'run-1',
      workspaceId: 'acme',
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
    });
    const agentRun = request?.agentRun as AgentRun;
    expect(agentRun.agent).toBe('foreman');
    expect(agentRun.prompt).toBe(plan.prompt);
    expect(agentRun.checkout).toEqual({ ref: 'refs/pull/7/head', sha: HEAD });
    expect(agentRun.agents.map((agent) => agent.name)).toEqual(['review']);
    expect(agentRun.files.map((file) => file.path)).toEqual(plan.files.map((file) => file.path));
  });

  it('starts nothing for an event recorded before', async () => {
    await holdAcme();
    await factoryWith(CODE_REVIEW_TEAM_FILES);
    const { ports, starts } = portsFor();
    const event = eventOf();
    await deliver(ports, event);
    expect(await deliver(ports, event)).toMatchObject({ kind: 'recorded', now: false });
    expect(starts).toHaveLength(1);
    expect(await stores.cloudSessions.listSeen('acme', 'person-fay')).toHaveLength(1);
  });

  it('still starts on a draft: the prompt handles drafts', async () => {
    await holdAcme();
    await factoryWith(CODE_REVIEW_TEAM_FILES);
    const { ports, starts } = portsFor();
    await deliver(ports, eventOf(pullRequestPayload({ draft: true })));
    expect(starts).toHaveLength(1);
    expect(starts[0]?.[1].agentRun?.prompt).toContain('draft: true');
  });

  it.each([
    ['no runner is connected', null, 'runner_unavailable'],
    [
      'the runner does not offer the repository',
      { ...offer, repositories: ['sprocket/billing'] },
      'repository_not_offered',
    ],
    [
      'the runner does not offer the harness',
      { ...offer, harnesses: ['codex'] },
      'harness_not_offered',
    ],
  ] as const)('records a failed run when %s, and sends nothing', async (_why, connected, code) => {
    await holdAcme();
    await factoryWith(CODE_REVIEW_TEAM_FILES);
    const { ports, channel } = portsFor(connected as Offer | null);
    expect(await deliver(ports, eventOf())).toMatchObject({ kind: 'recorded', now: true });
    expect(await stores.cloudSessions.listSeen('acme', 'person-fay')).toMatchObject([
      {
        status: 'failed',
        errorCode: code,
        error: null,
        runnerId: null,
        endedAt: 1000,
        personId: null,
        origin: { automation: 'review-pull-requests' },
      },
    ]);
    expect(channel.startSession).not.toHaveBeenCalled();
  });

  it('starts nothing from a factory whose team has issues, and says so', async () => {
    await holdAcme();
    const broken = [
      ...CODE_REVIEW_TEAM_FILES,
      { path: 'agents/stray/agent.md', content: '---\nagentType: NOBODY\n---\nHello.\n' },
    ];
    // Stored around the check, as a version saved before the rules changed would be.
    await factoryWith(broken);
    const { ports, starts, lines } = portsFor();
    expect(await deliver(ports, eventOf())).toMatchObject({ kind: 'recorded', now: true });
    expect(starts).toEqual([]);
    expect(await stores.cloudSessions.listSeen('acme', 'person-fay')).toEqual([]);
    expect(lines.join('\n')).toContain('problem(s) in its files, so it starts nothing');
  });

  it('starts nothing for an action no trigger names, another event, or a bot author', async () => {
    await holdAcme();
    await factoryWith(CODE_REVIEW_TEAM_FILES);
    const { ports, starts } = portsFor();
    await deliver(ports, eventOf(pullRequestPayload({ action: 'edited' })));
    await deliver(ports, eventOf(pullRequestPayload(), { event: 'issues' }));
    await deliver(ports, eventOf(pullRequestPayload({ login: 'renovate[bot]' })));
    expect(starts).toEqual([]);
  });

  it('records the event whatever goes wrong starting runs, logging no payload', async () => {
    await holdAcme();
    await factoryWith(CODE_REVIEW_TEAM_FILES);
    const { ports, lines } = portsFor();
    vi.spyOn(factories, 'list').mockRejectedValue(new Error('the database went away'));
    expect(await deliver(ports, eventOf())).toMatchObject({ kind: 'recorded', now: true });
    expect(lines.join('\n')).toContain('started no agent run: the database went away');
    expect(lines.join('\n')).not.toContain('Lyon');
  });

  it('answers the runs it started, one per matching automation of each factory', async () => {
    await holdAcme();
    await factoryWith(CODE_REVIEW_TEAM_FILES, 'Reviews');
    await factoryWith(CODE_REVIEW_TEAM_FILES, 'More reviews');
    const { ports } = portsFor();
    const started = await startAgentRunsFor(ports, eventOf());
    expect(
      started.map((run) => run.origin?.factoryName ?? '').sort((a, b) => a.localeCompare(b)),
    ).toEqual(['More reviews', 'Reviews']);
  });
});

describe("an agent run's life", () => {
  async function started() {
    await holdAcme();
    await factoryWith(CODE_REVIEW_TEAM_FILES);
    const fake = portsFor();
    await deliver(fake.ports, eventOf());
    return fake;
  }
  const RUNNER = { workspaceId: 'acme', runnerId: 'runner-1' };

  it("keeps the runner's latest report, and never takes its title", async () => {
    const { ports } = await started();
    const title = 'review-pull-requests · sprocket/catalog-portal#7 Price the catalog in euros';
    await applyRunnerUpdate(ports, RUNNER, {
      type: 'session.update',
      sessionId: 'run-1',
      status: 'running',
      title: 'Reviewing',
      agentRun: { state: 'working', agents: [{ id: 'c-1', agent: 'review', status: 'working' }] },
    });
    expect(await ports.sessions.find('run-1')).toMatchObject({
      status: 'running',
      title,
      agentRun: { state: 'working', agents: [{ id: 'c-1', agent: 'review', status: 'working' }] },
    });
    await applyRunnerUpdate(ports, RUNNER, {
      type: 'session.update',
      sessionId: 'run-1',
      title: 'Something else',
      agentRun: { state: 'done', summary: 'Posted the review.' },
    });
    expect(await ports.sessions.find('run-1')).toMatchObject({
      title,
      agentRun: { state: 'done', summary: 'Posted the review.' },
    });
  });

  it("keeps no report from a runner that is not the run's", async () => {
    const { ports } = await started();
    await applyRunnerUpdate(
      ports,
      { workspaceId: 'acme', runnerId: 'runner-2' },
      { type: 'session.update', sessionId: 'run-1', agentRun: { state: 'failed' } },
    );
    expect((await ports.sessions.find('run-1'))?.agentRun).toBeNull();
  });

  it("is every member's to see and stop, while a person's own session stays theirs", async () => {
    const { ports, channel } = await started();
    // Dana's own session, which Fay must not see.
    await ports.sessions.insert({
      id: 'dana-own',
      workspaceId: 'acme',
      personId: 'person-dana',
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
      status: 'running',
      title: null,
      hostUrl: null,
      error: null,
      errorCode: null,
      runnerId: 'runner-1',
      createdAt: 900,
      endedAt: null,
      origin: null,
      agentRun: null,
    });

    expect((await listSessions(ports, caller('person-fay'))).map((s) => s.id)).toEqual(['run-1']);
    expect((await listSessions(ports, caller('person-dana'))).map((s) => s.id)).toEqual([
      'run-1',
      'dana-own',
    ]);
    expect(await getSession(ports, caller('person-fay'), 'dana-own')).toEqual({
      kind: 'not_found',
    });
    expect(await getSession(ports, caller('person-fay'), 'run-1')).toMatchObject({ kind: 'ok' });
    // Another workspace sees neither.
    const globex = { ...caller('person-fay'), workspaceId: 'globex' } as Caller;
    expect(await getSession(ports, globex, 'run-1')).toEqual({ kind: 'not_found' });

    const stopped = await stopSession(ports, caller('person-fay'), 'run-1');
    expect(stopped).toMatchObject({ kind: 'ok', session: { status: 'stopped' } });
    expect(channel.stopSession).toHaveBeenCalledWith('runner-1', 'run-1');
    expect(await stopSession(ports, caller('person-fay'), 'dana-own')).toEqual({
      kind: 'not_found',
    });
  });
});
