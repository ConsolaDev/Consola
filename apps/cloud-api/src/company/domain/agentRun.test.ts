import { describe, expect, it } from 'vitest';
import { agentRunError, agentRunRecord } from './agentRun.js';
import type { CloudSession } from './cloudSession.js';
import { checkRun } from './run.js';

const PERMALINK = 'https://sprocket.slack.com/archives/C0CATALOG/p1795000000000100';

/** A request from Slack, as its session holds it. */
const slackSession = (over: Partial<CloudSession> = {}): CloudSession => ({
  id: 'session-1',
  workspaceId: 'sprocket',
  personId: null,
  repository: 'sprocket/catalog-portal',
  harness: 'claude',
  status: 'running',
  title: 'Code review · Slack: Price the catalog in euros',
  hostUrl: null,
  error: null,
  errorCode: null,
  runnerId: 'runner-1',
  createdAt: 1_795_000_000,
  endedAt: null,
  origin: {
    kind: 'slack',
    factoryId: 'factory-1',
    factoryName: 'Code review',
    agent: 'orchestrator',
    via: 'mention',
    message: {
      teamId: 'T0SPROCKET',
      channelId: 'C0CATALOG',
      threadTs: '1795000000.000100',
      messageTs: '1795000000.000100',
      permalink: PERMALINK,
      title: 'Price the catalog in euros',
    },
  },
  agentRun: null,
  ...over,
});

const facts = {
  factoryVersion: 2,
  text: 'The orchestrator is asked to price the catalog in euros.',
  createdAt: '2026-11-27T10:00:00.000Z',
  startedBy: 'person-alice',
};

describe('agentRunRecord, for a request from Slack', () => {
  it('is a request on the Slack message, started by the person who asked', () => {
    const record = agentRunRecord(slackSession(), facts, '2026-11-27T10:00:01.000Z');
    expect(record).toMatchObject({
      id: 'session-1',
      factoryId: 'factory-1',
      factoryVersion: 2,
      automation: null,
      status: 'running',
      trigger: 'event',
      triggerDetail: 'slack_mention',
      startedBy: 'person-alice',
      item: {
        url: PERMALINK,
        title: 'Price the catalog in euros',
        kind: 'slack',
        repo: null,
        number: null,
      },
      conversation: 'session-1',
      request: { text: facts.text },
    });
    if (record === null) throw new Error('no record');
    const checked = checkRun(record);
    expect(checked).toMatchObject({
      ok: true,
      run: { kind: 'request', title: 'Price the catalog in euros' },
    });
  });

  it('names a direct message as one', () => {
    const session = slackSession();
    if (session.origin?.kind !== 'slack') throw new Error('not from Slack');
    const dm = { ...session, origin: { ...session.origin, via: 'dm' as const } };
    expect(agentRunRecord(dm, facts, '2026-11-27T10:00:01.000Z')?.triggerDetail).toBe('slack_dm');
  });

  it('is started by nobody when the facts name no one, as an automation’s is', () => {
    const { startedBy: _, ...none } = facts;
    expect(agentRunRecord(slackSession(), none, '2026-11-27T10:00:01.000Z')?.startedBy).toBeNull();
  });
});

describe('agentRunError', () => {
  it('is null until the run fails, then says why in words', () => {
    expect(agentRunError(slackSession())).toBeNull();
    expect(agentRunError(slackSession({ status: 'stopped', endedAt: 1_795_000_100 }))).toBeNull();
    expect(
      agentRunError(
        slackSession({ status: 'failed', errorCode: 'runner_restarted', endedAt: 1_795_000_100 }),
      ),
    ).toBe('The runner restarted, and the sandbox this run worked in is gone.');
    expect(
      agentRunError(
        slackSession({ status: 'failed', error: 'The sandbox ran out of disk.', endedAt: 1 }),
      ),
    ).toBe('The sandbox ran out of disk.');
    expect(agentRunError(slackSession({ agentRun: { state: 'failed' } }))).toBe(
      'The agent says its run failed.',
    );
  });
});
