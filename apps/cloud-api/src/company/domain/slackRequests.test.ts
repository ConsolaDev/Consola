import { CODE_REVIEW_TEAM_FILES, parseAgentTeam } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import type { CloudSession } from './cloudSession.js';
import {
  factoryPageUrl,
  isOpenRequest,
  runPageUrl,
  shouldPost,
  slackAnswerFor,
  slackRequestStart,
  slackRequestTitle,
  slackStateOf,
  withoutBroadcasts,
} from './slackRequests.js';

const request = {
  kind: 'mention' as const,
  text: 'price the catalog in euros',
  slackUserId: 'U0ALICE',
  channelId: 'C0CATALOG',
  permalink: 'https://sprocket.slack.com/archives/C0CATALOG/p1795000000000100',
  repository: 'sprocket/catalog-portal',
};

describe('slackRequestTitle', () => {
  it("is the factory and the message's first line, on one line", () => {
    expect(slackRequestTitle('Code review', '\n  price the catalog\tin euros\nSee #42.')).toBe(
      'Code review · Slack: price the catalog in euros',
    );
  });

  it('is cut to 200 characters, with an ellipsis', () => {
    const title = slackRequestTitle('Code review', 'x'.repeat(500));
    expect([...title]).toHaveLength(200);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('the links Consola sends', () => {
  it("lead to the web app's pages", () => {
    expect(runPageUrl('http://localhost:5175', 'run/1')).toBe(
      'http://localhost:5175/#/runs/run%2F1',
    );
    expect(factoryPageUrl('http://localhost:5175', 'f-1')).toBe(
      'http://localhost:5175/#/factories/f-1/definition',
    );
  });
});

describe('slackRequestStart', () => {
  const { team } = parseAgentTeam(CODE_REVIEW_TEAM_FILES);

  it("is the orchestrator's plan for the message, on the default branch", () => {
    const start = slackRequestStart(team, request, 'run-1');
    expect(start).toMatchObject({ ok: true, value: { agent: 'orchestrator' } });
    if (!start.ok) throw new Error(start.reason);
    expect(start.value).not.toHaveProperty('checkout');
    expect(start.value.prompt).toContain('```text\nprice the catalog in euros\n```');
  });

  it('says why a team with no orchestrator cannot plan one', () => {
    const start = slackRequestStart({ ...team, orchestrator: undefined, agents: [] }, request, 'r');
    expect(start).toMatchObject({ ok: false });
    if (start.ok) throw new Error('planned');
    expect(start.reason).toMatch(/^the run could not be planned: This factory has no orchestrator/);
  });
});

/** A session of a request from Slack, as `over` has it. */
const session = (over: Partial<CloudSession>): CloudSession => ({
  id: 'run-1',
  workspaceId: 'sprocket',
  personId: null,
  repository: 'sprocket/catalog-portal',
  harness: 'claude',
  status: 'running',
  title: null,
  hostUrl: null,
  error: null,
  errorCode: null,
  runnerId: 'runner-1',
  createdAt: 1,
  endedAt: null,
  origin: null,
  agentRun: null,
  ...over,
});

describe('isOpenRequest', () => {
  it('is open while it starts, works or waits on a person, and not once it ends', () => {
    expect(isOpenRequest(session({ status: 'starting' }))).toBe(true);
    expect(isOpenRequest(session({}))).toBe(true);
    expect(isOpenRequest(session({ agentRun: { state: 'waiting' } }))).toBe(true);
    expect(isOpenRequest(session({ agentRun: { state: 'done' } }))).toBe(false);
    expect(isOpenRequest(session({ agentRun: { state: 'failed' } }))).toBe(false);
    expect(isOpenRequest(session({ status: 'stopped', endedAt: 2 }))).toBe(false);
    expect(isOpenRequest(session({ status: 'failed', endedAt: 2 }))).toBe(false);
  });
});

describe('what Consola says in the thread', () => {
  const url = 'http://localhost:5175/#/runs/run-1';

  it('is something only once the run waits, ends or stops', () => {
    expect(slackStateOf(session({ status: 'starting' }))).toBeNull();
    expect(slackStateOf(session({}))).toBeNull();
    expect(slackStateOf(session({ agentRun: { state: 'waiting' } }))).toBe('waiting');
    expect(slackStateOf(session({ agentRun: { state: 'done' } }))).toBe('done');
    expect(slackStateOf(session({ agentRun: { state: 'failed' } }))).toBe('stopped');
    expect(slackStateOf(session({ status: 'stopped', endedAt: 2 }))).toBe('stopped');
    expect(slackStateOf(session({ status: 'failed', endedAt: 2 }))).toBe('stopped');
  });

  it('is posted once per state: a question only before the end, nothing after it', () => {
    expect(shouldPost(null, null)).toBe(false);
    expect(shouldPost(null, 'waiting')).toBe(true);
    expect(shouldPost('waiting', 'waiting')).toBe(false);
    expect(shouldPost('waiting', 'done')).toBe(true);
    expect(shouldPost(null, 'stopped')).toBe(true);
    expect(shouldPost('done', 'stopped')).toBe(false);
    expect(shouldPost('stopped', 'waiting')).toBe(false);
  });

  it('says why a run stopped in words, on one line, after a colon', () => {
    const failed = session({ status: 'failed', endedAt: 2, error: 'Sandbox\nlost.  <!here>' });
    expect(slackAnswerFor('stopped', failed, url)).toEqual({
      text: `The run stopped: sandbox lost. @here. ${url}`,
    });
    const coded = session({ status: 'failed', endedAt: 2, errorCode: 'runner_unavailable' });
    expect(slackAnswerFor('stopped', coded, url).text).toBe(
      `The run stopped: no runner was connected for this workspace, so nothing ran. ${url}`,
    );
    const named = session({ status: 'failed', endedAt: 2, error: 'E2B refused the sandbox.' });
    expect(slackAnswerFor('stopped', named, url).text).toBe(
      `The run stopped: E2B refused the sandbox. ${url}`,
    );
  });

  it('says a finished run left no summary when it left none', () => {
    expect(
      slackAnswerFor('done', session({ agentRun: { state: 'done', summary: '  ' } }), url),
    ).toEqual({
      text: `Done. The run left no summary: ${url}`,
    });
  });

  it("makes Slack's broadcasts plain words, and keeps a mention of one person", () => {
    expect(
      withoutBroadcasts('<!channel> <!here> <!everyone|everyone> <!subteam^S0X|@sales> <@U0FAY>'),
    ).toBe('@channel @here @everyone @group <@U0FAY>');
  });
});
