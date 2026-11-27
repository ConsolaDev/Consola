import { CODE_REVIEW_TEAM_FILES } from '@consola/factory-spec';
import type { AgentRunReport } from '@consola/runner-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../adapters/persistence/database.js';
import { openTestDatabase } from '../adapters/persistence/database.test-helpers.js';
import { createSlackStores } from '../adapters/persistence/slackStores.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { Factory } from '../domain/factory.js';
import type { InstalledSlackApp } from '../domain/slackEvents.js';
import { SLACK_MARKDOWN_MAX, SLACK_TEXT_MAX, SUMMARY_CUT } from '../domain/slackRequests.js';
import { keepingRunsInStep } from './agentRuns.js';
import { applyRunnerUpdate, stopSession } from './cloudSessions.js';
import { callerAs, fakeMembership } from './membership.test-helpers.js';
import type { FakeMembership } from './membership.test-helpers.js';
import type { CloudSessionStore, Offer, RunnerChannel } from './ports.js';
import { readRun } from './runs.js';
import {
  countingTokens,
  fakeSlackApi,
  holdSprocket,
  installSlackApp,
  linkSlackUser,
  markingSealer,
  SPROCKET_SLACK,
} from './slack.test-helpers.js';
import type { FakeSlack } from './slack.test-helpers.js';
import { answeringInSlack, answerInThread } from './slackAnswers.js';
import type { SlackAnswerPorts } from './slackAnswers.js';
import { handleSlackEvent } from './slackRequests.js';

const NOW = 1_795_000_000;
const PUBLIC_URL = 'http://localhost:5175';
const RUN_URL = `${PUBLIC_URL}/#/runs/session-1`;
const RUNNER = { workspaceId: 'sprocket', runnerId: 'runner-1' };

let db: Database;
let close: () => Promise<void>;
let membership: FakeMembership;
let factory: Factory;
let app: InstalledSlackApp;
let slack: FakeSlack;
let lines: string[];
let tasks: Array<() => Promise<void>>;
let sessions: CloudSessionStore;
let answerPorts: SlackAnswerPorts;

const offer: Offer = {
  runnerId: 'runner-1',
  repositories: ['sprocket/catalog-portal'],
  harnesses: ['claude'],
};

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  membership = fakeMembership();
  ({ factory } = await holdSprocket(db, membership, [
    ...CODE_REVIEW_TEAM_FILES,
    { path: 'factory.yml', content: 'version: 1\nrepos: [sprocket/catalog-portal]\n' },
  ]));
  app = await installSlackApp(db, factory);
  await linkSlackUser(db, 'U0FAY', 'person-fay');
  slack = fakeSlackApi();
  lines = [];
  tasks = [];
  const stores = createDrizzleStores(db);
  const slackStores = createSlackStores(db);
  const report = (line: string) => {
    lines.push(line);
  };
  const clock = { nowSeconds: () => NOW };
  answerPorts = {
    slack: slack.api,
    apps: slackStores.apps,
    requests: slackStores.requests,
    sealer: markingSealer,
    publicUrl: PUBLIC_URL,
    later: (task) => {
      tasks.push(task);
    },
    report,
  };
  // As `compose.ts` wires it: every change to a session moves its run, and is said in Slack.
  sessions = answeringInSlack(
    keepingRunsInStep(stores.cloudSessions, { runs: stores.runs, clock, report }),
    answerPorts,
  );
  const runners: RunnerChannel = {
    connected: () => offer,
    startSession: async () => {},
    stopSession: async () => {},
  };
  const started = await handleSlackEvent(
    {
      sessions,
      runners,
      ids: { newId: () => 'session-1' },
      clock,
      factories: stores.factories,
      runs: stores.runs,
      teams: stores.teams,
      membership,
      apps: slackStores.apps,
      links: slackStores.links,
      requests: slackStores.requests,
      tokens: countingTokens(),
      slack: slack.api,
      sealer: markingSealer,
      publicUrl: PUBLIC_URL,
      report,
    },
    app,
    {
      apiAppId: SPROCKET_SLACK.appId,
      teamId: SPROCKET_SLACK.teamId,
      eventId: 'Ev0MENTION',
      eventType: 'app_mention',
      event: {
        type: 'app_mention',
        user: 'U0FAY',
        text: '<@U0BOT> price the catalog in euros',
        ts: '1795000000.000100',
        channel: 'C0CATALOG',
      },
    },
  );
  expect(started).toMatchObject({ kind: 'started' });
  // What the start said ("On it") is not what these tests look at.
  slack.calls.splice(0);
});
afterEach(async () => {
  await close();
});

/** Runs what the changes put off until they were done. */
async function afterTheChanges() {
  while (tasks.length > 0) {
    for (const task of tasks.splice(0)) await task();
  }
}

/** The runner says something of the request's session, as its socket would. */
async function runnerSays(update: {
  status?: 'running' | 'stopped' | 'failed';
  error?: string;
  agentRun?: AgentRunReport;
}) {
  await applyRunnerUpdate({ sessions, clock: { nowSeconds: () => NOW + 60 } }, RUNNER, {
    type: 'session.update',
    sessionId: 'session-1',
    ...update,
  });
  await afterTheChanges();
}

/** What the bot posted in the request's thread, in order. */
const posted = () =>
  slack.of('chat.postMessage').map(({ args }) => {
    expect([args.channel, args.threadTs]).toEqual(['C0CATALOG', '1795000000.000100']);
    return args.blocks === undefined
      ? { text: args.text }
      : { text: args.text, blocks: args.blocks };
  });

describe('answering in the thread', () => {
  it('says nothing while the run is queued or working', async () => {
    await runnerSays({ status: 'running' });
    await runnerSays({ agentRun: { state: 'working' } });
    expect(posted()).toEqual([]);
  });

  it('asks for an answer the first time the run waits on a person, and only then', async () => {
    await runnerSays({ status: 'running' });
    await runnerSays({ agentRun: { state: 'waiting' } });
    await runnerSays({ agentRun: { state: 'waiting', summary: 'Which currency first?' } });
    await runnerSays({ agentRun: { state: 'working' } });
    await runnerSays({ agentRun: { state: 'waiting' } });
    expect(posted()).toEqual([{ text: `I need an answer to carry on: ${RUN_URL}` }]);
  });

  it("posts the orchestrator's summary once when it is done, in a markdown block and as text", async () => {
    await runnerSays({ status: 'running' });
    await runnerSays({ agentRun: { state: 'waiting' } });
    const summary = 'Priced the catalog in euros.\n\n- **42** products\n- Opened #7';
    await runnerSays({ agentRun: { state: 'done', summary } });
    // The host stops once its run is done: the end, said once already.
    await runnerSays({ status: 'stopped' });
    expect(posted()).toEqual([
      { text: `I need an answer to carry on: ${RUN_URL}` },
      {
        text: `${summary}\n\n${RUN_URL}`,
        blocks: [{ type: 'markdown', text: `${summary}\n\n[Open the run in Consola](${RUN_URL})` }],
      },
    ]);
    expect((await createSlackStores(db).requests.ofSession('session-1'))?.posted).toBe('done');
  });

  it("cuts a long summary to Slack's limits, saying the rest is in the run", async () => {
    await runnerSays({ status: 'running' });
    await runnerSays({ agentRun: { state: 'done', summary: '🙂'.repeat(20_000) } });
    const [done] = posted();
    const text = String(done?.text);
    expect([...text].length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
    expect(text.endsWith(`${SUMMARY_CUT}\n\n${RUN_URL}`)).toBe(true);
    const [block] = (done?.blocks ?? []) as Array<{ text: string }>;
    expect([...String(block?.text)].length).toBeLessThanOrEqual(SLACK_MARKDOWN_MAX);
    expect(
      String(block?.text).endsWith(`${SUMMARY_CUT}\n\n[Open the run in Consola](${RUN_URL})`),
    ).toBe(true);
  });

  it('never lets a summary notify a whole channel', async () => {
    await runnerSays({ status: 'running' });
    await runnerSays({
      agentRun: {
        state: 'done',
        summary: 'Done <!channel>, <!here|here> and <!subteam^S0SALES>. Thanks <@U0FAY>.',
      },
    });
    expect(posted()[0]?.text).toBe(
      `Done @channel, @here and @group. Thanks <@U0FAY>.\n\n${RUN_URL}`,
    );
  });

  it('says when the run failed, and why, in words', async () => {
    await runnerSays({ status: 'running' });
    await runnerSays({ status: 'failed', error: 'The sandbox ran out of disk.' });
    expect(posted()).toEqual([
      { text: `The run stopped: the sandbox ran out of disk. ${RUN_URL}` },
    ]);
  });

  it("says when the run failed for a reason of the app's own", async () => {
    await runnerSays({ status: 'failed' });
    expect(posted()).toEqual([
      {
        text: `The run stopped: the runner says the run failed, and gave no reason. ${RUN_URL}`,
      },
    ]);
  });

  it('says when someone stopped the run before it finished', async () => {
    await runnerSays({ status: 'running' });
    const stopped = await stopSession(
      {
        sessions,
        runners: {
          connected: () => null,
          startSession: async () => {},
          stopSession: async () => {},
        },
        ids: { newId: () => 'x' },
        clock: { nowSeconds: () => NOW + 90 },
        passes: null,
        hosts: { sendFollowUp: async () => 'failed' },
      },
      callerAs('person-fay', 'member', 'sprocket'),
      'session-1',
    );
    expect(stopped).toMatchObject({ kind: 'ok', session: { status: 'stopped' } });
    await afterTheChanges();
    expect(posted()).toEqual([
      { text: `The run stopped: it was stopped before it finished. ${RUN_URL}` },
    ]);
  });

  it('posts each state once, however many changes call for it at once', async () => {
    await runnerSays({ status: 'running' });
    // Moved past the follower, then followed three times at once.
    const plain = createDrizzleStores(db).cloudSessions;
    await plain.update('session-1', 'running', { agentRun: { state: 'done', summary: 'Done.' } });
    const said = await Promise.all([
      answerInThread(plain, answerPorts, 'session-1'),
      answerInThread(plain, answerPorts, 'session-1'),
      answerInThread(plain, answerPorts, 'session-1'),
    ]);
    expect(said.filter((state) => state !== null)).toEqual(['done']);
    expect(posted()).toEqual([
      {
        text: `Done.\n\n${RUN_URL}`,
        blocks: [{ type: 'markdown', text: `Done.\n\n[Open the run in Consola](${RUN_URL})` }],
      },
    ]);
  });

  it('says nothing of a session that is no request from Slack', async () => {
    expect(
      await answerInThread(createDrizzleStores(db).cloudSessions, answerPorts, 'no-such'),
    ).toBeNull();
    expect(slack.calls).toEqual([]);
  });

  it('marks the app on a dead token, and changes neither the session nor its run', async () => {
    await runnerSays({ status: 'running' });
    slack.refuse('chat.postMessage', 'invalid_auth');
    await runnerSays({ agentRun: { state: 'done', summary: 'Done.' } });
    expect((await createSlackStores(db).apps.get('sprocket', factory.id))?.needsReinstall).toBe(
      true,
    );
    expect(await createDrizzleStores(db).cloudSessions.find('session-1')).toMatchObject({
      status: 'running',
      agentRun: { state: 'done', summary: 'Done.' },
    });
    const { teams, factories, runs } = createDrizzleStores(db);
    const read = await readRun(
      teams,
      factories,
      runs,
      callerAs('person-fay', 'member', 'sprocket'),
      'session-1',
    );
    expect(read).toMatchObject({
      kind: 'found',
      run: { status: 'completed', startedBy: 'person-fay' },
    });
    // Said once, even though it failed: never tried again.
    await runnerSays({ status: 'stopped' });
    expect(slack.of('chat.postMessage')).toHaveLength(1);
  });

  it('logs ids alone, never a summary or a token', async () => {
    await runnerSays({ status: 'running' });
    slack.refuse('chat.postMessage', 'channel_not_found');
    await runnerSays({ agentRun: { state: 'done', summary: 'Priced the catalog in euros.' } });
    for (const line of lines) expect(line).not.toMatch(/Priced the catalog|xoxb/);
    expect(lines).toContain(
      `Slack refused chat.postMessage for factory ${factory.id}: channel_not_found.`,
    );
  });
});
