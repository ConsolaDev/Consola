import { CODE_REVIEW_TEAM_FILES, parseAgentTeam } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import type { CloudSession } from './cloudSession.js';
import {
  factoryPageUrl,
  isOpenRequest,
  runPageUrl,
  slackRequestStart,
  slackRequestTitle,
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

describe('isOpenRequest', () => {
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
