import {
  CODE_REVIEW_TEAM_FILES,
  matchPullRequestAutomations,
  parseAgentTeam,
  planAgentRun,
  pullRequestEventOf,
} from '@consola/factory-spec';
import { AGENT_RUN_FACTORY_DIR, SESSION_REPOSITORY_DIR } from '@consola/runner-protocol';
import type { AgentRun } from '@consola/runner-protocol';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import {
  makeTestWorkspace,
  openTestDatabase,
} from '../adapters/persistence/database.test-helpers.js';
import type { Caller } from '../domain/caller.js';
import type { FactoryFile } from '../domain/factory.js';
import { keepingRunsInStep, startAgentRunsFor } from './agentRuns.js';
import type { GitHubEvent } from './agentRuns.js';
import { applyRunnerUpdate, getSession, listSessions, stopSession } from './cloudSessions.js';
import type {
  AgentRunPorts,
  CloudSessionPorts,
  FactoryStore,
  Offer,
  RunnerChannel,
  SessionStartRequest,
  TeamStore,
} from './ports.js';
import { readRun } from './runs.js';
import { callerAs, fakeMembership } from './membership.test-helpers.js';
import type { FakeMembership } from './membership.test-helpers.js';

let db: Database;
let close: () => Promise<void>;
let teams: TeamStore;
let factories: FactoryStore;
let stores: ReturnType<typeof createDrizzleStores>;
let membership: FakeMembership;

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  stores = createDrizzleStores(db);
  ({ teams, factories } = stores);
  membership = fakeMembership();
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
/** A pull request's event, as the webhook hands on one it recorded for the first time. */
const eventOf = (
  payload: Record<string, unknown> = pullRequestPayload(),
  over: Partial<GitHubEvent> = {},
): GitHubEvent => ({
  workspaceId: 'acme',
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
  const clock = { nowSeconds: () => 1000 };
  const report = (line: string) => {
    lines.push(line);
  };
  const ports: AgentRunPorts & CloudSessionPorts = {
    // As `compose.ts` wires it: every change to a session moves its run.
    sessions: keepingRunsInStep(stores.cloudSessions, { runs: stores.runs, clock, report }),
    runners: channel,
    ids: { newId: () => `run-${++next}` },
    clock,
    passes: null,
    factories,
    runs: stores.runs,
    report,
  };
  return { ports, channel, starts, lines };
}

/** Acme, made whole, with Dana (owner) and Fay (member) in its first team. */
async function holdAcme() {
  await makeTestWorkspace(db, membership, 'acme', [
    ['person-dana', 'owner'],
    ['person-fay', 'member'],
  ]);
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

const caller = (personId: string): Caller => callerAs(personId, 'member');

/** The agent runs the tests' ids name, as the app holds them. */
async function agentRunSessions() {
  const found = await Promise.all(
    ['run-1', 'run-2', 'run-3'].map((id) => stores.cloudSessions.find(id)),
  );
  return found.filter((session) => session !== null);
}

/** An agent run's run, as the Runs pages read it for Fay, a member of the factory's team. */
async function runOf(id: string) {
  const read = await readRun(teams, factories, stores.runs, caller('person-fay'), id);
  if (read.kind !== 'found') throw new Error(`no run ${id}: ${read.kind}`);
  return read;
}

describe('an event starts agent runs', () => {
  it("starts one orchestrator run for an opened pull request, with the plan's prompt and the head to check out", async () => {
    await holdAcme();
    const factory = await factoryWith(CODE_REVIEW_TEAM_FILES);
    const { ports, starts } = portsFor();

    expect(await startAgentRunsFor(ports, eventOf())).toHaveLength(1);

    const [run, ...others] = await agentRunSessions();
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
        agent: 'orchestrator',
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
    expect(agentRun.agent).toBe('orchestrator');
    expect(agentRun.prompt).toBe(plan.prompt);
    expect(agentRun.checkout).toEqual({ ref: 'refs/pull/7/head', sha: HEAD });
    expect(agentRun.agents.map((agent) => agent.name)).toEqual(['review']);
    expect(agentRun.files.map((file) => file.path)).toEqual(plan.files.map((file) => file.path));
  });

  it('still starts on a draft: the prompt handles drafts', async () => {
    await holdAcme();
    await factoryWith(CODE_REVIEW_TEAM_FILES);
    const { ports, starts } = portsFor();
    await startAgentRunsFor(ports, eventOf(pullRequestPayload({ draft: true })));
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
    expect(await startAgentRunsFor(ports, eventOf())).toHaveLength(1);
    expect(await agentRunSessions()).toMatchObject([
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
    expect(await startAgentRunsFor(ports, eventOf())).toEqual([]);
    expect(starts).toEqual([]);
    expect(await agentRunSessions()).toEqual([]);
    expect(lines.join('\n')).toContain('problem(s) in its files, so it starts nothing');
  });

  it('starts nothing for an action no trigger names, another event, or a bot author', async () => {
    await holdAcme();
    await factoryWith(CODE_REVIEW_TEAM_FILES);
    const { ports, starts } = portsFor();
    await startAgentRunsFor(ports, eventOf(pullRequestPayload({ action: 'edited' })));
    await startAgentRunsFor(ports, eventOf(pullRequestPayload(), { event: 'issues' }));
    await startAgentRunsFor(ports, eventOf(pullRequestPayload({ login: 'renovate[bot]' })));
    expect(starts).toEqual([]);
  });

  it('throws only when the factories cannot be read, for the webhook to log, and logs no payload', async () => {
    await holdAcme();
    await factoryWith(CODE_REVIEW_TEAM_FILES);
    const { ports, lines } = portsFor();
    vi.spyOn(factories, 'list').mockRejectedValue(new Error('the database went away'));
    await expect(startAgentRunsFor(ports, eventOf())).rejects.toThrow('the database went away');
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
    await startAgentRunsFor(fake.ports, eventOf());
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

  it("is every member's to open and stop, listed with the runs, while a person's own session stays theirs", async () => {
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

    // The Sessions list is a person's own: an agent run is a run, listed with the runs.
    expect(await listSessions(ports, caller('person-fay'))).toEqual([]);
    expect((await listSessions(ports, caller('person-dana'))).map((s) => s.id)).toEqual([
      'dana-own',
    ]);
    expect(await getSession(ports, caller('person-fay'), 'dana-own')).toEqual({
      kind: 'not_found',
    });
    expect(await getSession(ports, caller('person-fay'), 'run-1')).toMatchObject({ kind: 'ok' });
    // Another workspace sees neither.
    const inSprocket = callerAs('person-fay', 'member', 'sprocket');
    expect(await getSession(ports, inSprocket, 'run-1')).toEqual({ kind: 'not_found' });

    const stopped = await stopSession(ports, caller('person-fay'), 'run-1');
    expect(stopped).toMatchObject({ kind: 'ok', session: { status: 'stopped' } });
    expect(channel.stopSession).toHaveBeenCalledWith('runner-1', 'run-1');
    expect(await stopSession(ports, caller('person-fay'), 'dana-own')).toEqual({
      kind: 'not_found',
    });
  });
});

describe("an agent run's run", () => {
  const RUNNER = { workspaceId: 'acme', runnerId: 'runner-1' };

  async function started(connected: Offer | null = offer) {
    await holdAcme();
    const factory = await factoryWith(CODE_REVIEW_TEAM_FILES);
    const fake = portsFor(connected);
    await startAgentRunsFor(fake.ports, eventOf());
    return { ...fake, factory };
  }

  it('is a request of the Runs pages: the orchestrator its one step, the pull request its item, the session its conversation', async () => {
    const { factory, starts } = await started();
    const read = await runOf('run-1');
    expect(read.run).toMatchObject({
      id: 'run-1',
      kind: 'request',
      title: 'Price the catalog in euros',
      status: 'queued',
      phase: 'active',
      factory: { id: factory.id, name: 'Reviews', version: 2 },
      automation: null,
      parentId: null,
      trigger: 'event',
      triggerDetail: 'pull_request',
      startedBy: null,
      item: {
        url: 'https://github.com/sprocket/catalog-portal/pull/7',
        title: 'Price the catalog in euros',
        kind: 'pr',
        repo: 'sprocket/catalog-portal',
        number: 7,
      },
      runner: 'cloud',
      startedAt: null,
      finishedAt: null,
    });
    expect(read.steps).toMatchObject([
      { id: 'orchestrator', kind: 'orchestrator', status: 'queued', agent: 'orchestrator' },
    ]);
    // Its text is what the orchestrator is sent, and its conversation the session it works in.
    expect(read.request?.text).toBe(starts[0]?.[1].agentRun?.prompt);
    expect(read.conversation).toBe('run-1');
    expect(read.children).toEqual([]);
  });

  it('follows its session: at work, waiting on a question, then done with the orchestrator’s first line', async () => {
    const { ports } = await started();
    const update = (over: Record<string, unknown>) =>
      applyRunnerUpdate(ports, RUNNER, { type: 'session.update', sessionId: 'run-1', ...over });

    await update({ status: 'running', agentRun: { state: 'working' } });
    expect((await runOf('run-1')).run).toMatchObject({
      status: 'running',
      phase: 'active',
      startedAt: new Date(1_000_000).toISOString(),
    });

    await update({ agentRun: { state: 'waiting' } });
    expect((await runOf('run-1')).run).toMatchObject({
      status: 'waiting',
      waitingOn: 'person',
      phase: 'needs-you',
    });

    await update({
      agentRun: { state: 'done', summary: '\nPosted a comment review on #7.\nTwo findings.' },
    });
    const done = await runOf('run-1');
    expect(done.run).toMatchObject({
      status: 'completed',
      phase: 'completed',
      summary: 'Posted a comment review on #7.',
      finishedAt: null,
    });
    expect(done.steps).toMatchObject([{ status: 'completed' }]);

    // The host stops once nobody is connected: the run stays done, and says when it ended.
    await update({ status: 'stopped' });
    expect((await runOf('run-1')).run).toMatchObject({
      status: 'completed',
      finishedAt: new Date(1_000_000).toISOString(),
    });
  });

  it('is cancelled when a person stops it before it is done', async () => {
    const { ports } = await started();
    await applyRunnerUpdate(ports, RUNNER, {
      type: 'session.update',
      sessionId: 'run-1',
      status: 'running',
      agentRun: { state: 'working' },
    });
    await stopSession(ports, caller('person-fay'), 'run-1');
    expect((await runOf('run-1')).run).toMatchObject({ status: 'cancelled', phase: 'stopped' });
  });

  it("fails with the runner's message, or the app's sentence for its own code", async () => {
    const { ports } = await started();
    await applyRunnerUpdate(ports, RUNNER, {
      type: 'session.update',
      sessionId: 'run-1',
      status: 'failed',
      error: 'The sandbox was not made within 60 s.',
    });
    const read = await runOf('run-1');
    expect(read.run).toMatchObject({
      status: 'failed',
      error: 'The sandbox was not made within 60 s.',
    });
    expect(read.steps).toMatchObject([
      { status: 'failed', error: 'The sandbox was not made within 60 s.' },
    ]);
  });

  it('is recorded failed when nothing ran, saying why', async () => {
    await started(null);
    expect((await runOf('run-1')).run).toMatchObject({
      status: 'failed',
      error: 'No runner was connected for this workspace, so nothing ran.',
    });
  });

  it('leaves a session it holds no run of alone, and says so', async () => {
    const { ports, lines } = await started();
    await db.execute(sql`delete from run where run_id = 'run-1'`);
    await applyRunnerUpdate(ports, RUNNER, {
      type: 'session.update',
      sessionId: 'run-1',
      status: 'running',
    });
    expect((await ports.sessions.find('run-1'))?.status).toBe('running');
    expect(lines.join('\n')).toContain('the cell holds no run of it to follow');
  });
});
