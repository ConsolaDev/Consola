import { describe, expect, it } from 'vitest';
import type { paths } from './apiContract';
import {
  agentRunPhase,
  agentRunPhaseWords,
  agentRunSummary,
  chatMounted,
  dispatchedAgents,
  isAgentRun,
  keepsShownOn,
  listPollIntervalMs,
  pollIntervalMs,
  pullRequestLabel,
  pullRequestUrl,
  sessionLabel,
  sessionPollIntervalMs,
  sessionScreen,
  shortSha,
  shouldRenewPass,
  slackMessageUrl,
  startedAt,
} from './cloudSession';
import type {
  AgentRun,
  AgentRunPhase,
  AgentRunReport,
  CellFailureCode,
  CloudSession,
  CloudSessionOrigin,
  CloudSessionStatus,
  DispatchedAgentStatus,
  Harness,
  SlackOrigin,
  StartRefusalCode,
} from './cloudSession';
import {
  AGENT_RUN_PHASE_WORDS,
  DISPATCHED_STATUS_WORDS,
  dispatchedCount,
  noAgentsWords,
  noSummaryWords,
  HARNESS_NAMES,
  messageForPassAnswer,
  messageForSessionAnswer,
  messageForStartAnswer,
  messageForStopAnswer,
  NO_RUNNER_WORDS,
  SESSION_STATUS_WORDS,
  START_NOTE,
} from './cloudSessionMessages';

const session: CloudSession = {
  id: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
  workspaceId: 'ws-acme',
  personId: 'p-ada',
  repository: 'sprocket/catalog-portal',
  harness: 'claude',
  status: 'running',
  title: 'Fix the flaky login test',
  hostUrl: 'https://7420-sandbox.e2b.test',
  error: null,
  errorCode: null,
  runnerId: 'runner-1',
  createdAt: 1_795_000_000,
  endedAt: null,
  origin: null,
  agentRun: null,
};

describe('the contract', () => {
  it('names every harness, failure code and status the API has', () => {
    // A harness, a code or a status the API gains fails the typecheck until the page words it.
    const harnesses: Record<Harness, string> = HARNESS_NAMES;
    const statuses: Record<CloudSessionStatus, string> = SESSION_STATUS_WORDS;
    expect(Object.keys(harnesses).sort()).toEqual(['claude', 'codex']);
    expect(Object.keys(statuses).sort()).toEqual(['failed', 'running', 'starting', 'stopped']);
  });

  it('refuses a start only with the codes the API answers', () => {
    type Refused =
      | paths['/api/cloud-sessions']['post']['responses'][400]['content']['application/json']['error']
      | paths['/api/cloud-sessions']['post']['responses'][503]['content']['application/json']['error'];
    const exact: Exclude<Refused, 'token_check_unavailable'> extends StartRefusalCode
      ? StartRefusalCode extends Exclude<Refused, 'token_check_unavailable'>
        ? true
        : false
      : false = true;
    expect(exact).toBe(true);
  });
});

describe('sessionLabel', () => {
  it('is the session’s title', () => {
    expect(sessionLabel(session)).toBe('Fix the flaky login test');
  });

  it('is “Session” and the id’s first eight characters while it has no title', () => {
    expect(sessionLabel({ ...session, title: null })).toBe('Session 1a2b3c4d');
    expect(sessionLabel({ ...session, title: '   ' })).toBe('Session 1a2b3c4d');
  });
});

describe('pollIntervalMs', () => {
  it('reads a starting session every 2 s, a running one every 10 s, and an ended one never', () => {
    expect(pollIntervalMs('starting')).toBe(2000);
    expect(pollIntervalMs('running')).toBe(10_000);
    expect(pollIntervalMs('stopped')).toBeNull();
    expect(pollIntervalMs('failed')).toBeNull();
  });
});

describe('listPollIntervalMs', () => {
  it('reads the list as often as its liveliest session asks', () => {
    expect(
      listPollIntervalMs([{ status: 'running' }, { status: 'starting' }, { status: 'stopped' }]),
    ).toBe(2000);
    expect(listPollIntervalMs([{ status: 'running' }, { status: 'failed' }])).toBe(10_000);
  });

  it('reads it now and then once no session shown can change, for one started elsewhere', () => {
    expect(listPollIntervalMs([{ status: 'stopped' }, { status: 'failed' }])).toBe(30_000);
    expect(listPollIntervalMs([])).toBe(30_000);
  });
});

describe('keepsShownOn', () => {
  it('keeps what was shown through a read that failed for a while: the next may work', () => {
    expect(keepsShownOn({ kind: 'unavailable' })).toBe(true);
  });

  it('ends what was shown, a running chat included, once signed out or switched', () => {
    expect(keepsShownOn({ kind: 'signed-out' })).toBe(false);
    expect(keepsShownOn({ kind: 'switched' })).toBe(false);
  });

  it('ends a session the API no longer has', () => {
    expect(keepsShownOn({ kind: 'not-found' })).toBe(false);
  });
});

describe('the chat and its pass', () => {
  it('mounts the chat and renews its pass only while the session runs', () => {
    expect(chatMounted('running')).toBe(true);
    expect(shouldRenewPass('running')).toBe(true);
    for (const status of ['starting', 'stopped', 'failed'] as const) {
      expect(chatMounted(status)).toBe(false);
      expect(shouldRenewPass(status)).toBe(false);
    }
  });

  it('unmounts the chat and asks no new pass once a running session stops', () => {
    const seen = (['running', 'stopped'] as const).map((status) => ({
      mounted: chatMounted(status),
      renew: shouldRenewPass(status),
      poll: pollIntervalMs(status),
    }));
    expect(seen).toEqual([
      { mounted: true, renew: true, poll: 10_000 },
      { mounted: false, renew: false, poll: null },
    ]);
  });
});

describe('sessionScreen', () => {
  it('says the sandbox is starting', () => {
    expect(sessionScreen({ ...session, status: 'starting' })).toEqual({
      kind: 'starting',
      words: 'Starting the sandbox…',
    });
  });

  it('shows the chat with the warning above it, and Stop, while running', () => {
    expect(sessionScreen(session)).toEqual({
      kind: 'running',
      warning: 'Changes not pushed to a branch are lost when this session stops.',
    });
  });

  it('says the session stopped, with no composer', () => {
    expect(sessionScreen({ ...session, status: 'stopped' })).toEqual({
      kind: 'stopped',
      words: 'This session has stopped.',
    });
  });

  it('says a failure with the runner’s message as it came', () => {
    expect(
      sessionScreen({
        ...session,
        status: 'failed',
        error: 'clone-failed: repository not found',
      }),
    ).toEqual({
      kind: 'failed',
      words: 'This session failed: clone-failed: repository not found',
    });
  });

  it.each([
    ['runner_restarted', 'The runner restarted.'],
    ['runner_unreachable', 'The runner couldn’t be reached to start this session.'],
    ['runner_failed', 'The runner stopped this session without saying why.'],
  ] satisfies Array<[CellFailureCode, string]>)(
    'words the API’s code %s, never the code itself',
    (errorCode, words) => {
      expect(sessionScreen({ ...session, status: 'failed', errorCode })).toEqual({
        kind: 'failed',
        words,
      });
    },
  );

  it('says the session failed when the API gave neither a message nor a code it knows', () => {
    expect(sessionScreen({ ...session, status: 'failed' })).toEqual({
      kind: 'failed',
      words: 'This session failed.',
    });
    expect(
      sessionScreen({
        ...session,
        status: 'failed',
        errorCode: 'runner_exploded' as CellFailureCode,
      }),
    ).toEqual({ kind: 'failed', words: 'This session failed.' });
  });
});

describe('an agent run', () => {
  const origin: CloudSessionOrigin = {
    kind: 'automation',
    factoryId: 'f-1',
    factoryName: 'Code review',
    automation: 'review-pull-requests',
    agent: 'foreman',
    item: {
      kind: 'pull_request',
      repository: 'sprocket/catalog-portal',
      number: 12,
      url: 'https://github.com/sprocket/catalog-portal/pull/12',
      title: 'Fix the flaky login test',
      headSha: '0123456789abcdef0123456789abcdef01234567',
    },
  };
  const run: AgentRun = {
    ...session,
    personId: null,
    title: 'review-pull-requests · sprocket/catalog-portal#12 Fix the flaky login test',
    origin,
    agentRun: null,
  };
  const reported = (agentRun: AgentRunReport, status = run.status) => ({
    ...run,
    status,
    agentRun,
  });

  it('is told apart from a person’s session by what started it', () => {
    expect(isAgentRun(run)).toBe(true);
    expect(isAgentRun(session)).toBe(false);
  });

  it('names its pull request as a person does, and links it only on https', () => {
    expect(pullRequestLabel(origin.item)).toBe(
      'sprocket/catalog-portal#12 Fix the flaky login test',
    );
    expect(pullRequestLabel({ ...origin.item, title: '  ' })).toBe('sprocket/catalog-portal#12');
    expect(pullRequestUrl(origin.item)).toBe(origin.item.url);
    expect(pullRequestUrl({ ...origin.item, url: 'javascript:alert(1)' })).toBeNull();
    expect(pullRequestUrl({ ...origin.item, url: 'http://github.com/x' })).toBeNull();
    expect(shortSha(origin.item.headSha)).toBe('0123456');
  });

  it('links a request from Slack to its message, only on https', () => {
    const slack: SlackOrigin = {
      kind: 'slack',
      factoryId: 'f-1',
      factoryName: 'Code review',
      agent: 'orchestrator',
      message: {
        teamId: 'T024BE7LD',
        channelId: 'C024BE91L',
        threadTs: '1732700000.000100',
        messageTs: '1732700000.000100',
        permalink: 'https://sprocket.slack.com/archives/C024BE91L/p1732700000000100',
      },
    };
    expect(isAgentRun({ ...run, origin: slack })).toBe(true);
    expect(slackMessageUrl(slack)).toBe(slack.message.permalink);
    const plain = { ...slack.message, permalink: 'http://sprocket.slack.com/archives/C1/p1' };
    expect(slackMessageUrl({ ...slack, message: plain })).toBeNull();
  });

  it('stands where the runner last reported, while the sandbox runs', () => {
    expect(agentRunPhase(run)).toBe('working');
    expect(agentRunPhase(reported({ state: 'working' }))).toBe('working');
    expect(agentRunPhase(reported({ state: 'waiting' }))).toBe('waiting');
    expect(agentRunPhase({ ...run, status: 'starting' })).toBe('starting');
  });

  it('keeps a finished or failed report as its end, whatever came of the sandbox after', () => {
    expect(agentRunPhase(reported({ state: 'done' }, 'stopped'))).toBe('done');
    expect(agentRunPhase(reported({ state: 'done' }, 'failed'))).toBe('done');
    expect(agentRunPhase(reported({ state: 'failed' }, 'running'))).toBe('failed');
  });

  it('failed, or was stopped before it finished, when the sandbox ended first', () => {
    const failed: AgentRun = { ...run, status: 'failed', errorCode: 'runner_unavailable' };
    expect(agentRunPhase(failed)).toBe('failed');
    expect(agentRunPhase(reported({ state: 'working' }, 'stopped'))).toBe('stopped');
    expect(agentRunPhase({ ...run, status: 'stopped' })).toBe('stopped');
  });

  it('says where it stands in words', () => {
    const phases: Record<AgentRunPhase, string> = AGENT_RUN_PHASE_WORDS;
    expect(phases).toEqual({
      starting: 'Starting',
      working: 'Working',
      waiting: 'Waiting on a question',
      done: 'Finished',
      failed: 'Failed',
      stopped: 'Stopped before it finished',
    });
    expect(agentRunPhaseWords(reported({ state: 'waiting' }))).toBe('Waiting on a question');
    expect(agentRunPhaseWords(reported({ state: 'done' }, 'stopped'))).toBe('Finished');
  });

  it('reads the foreman’s result and the agents it dispatched from the report', () => {
    expect(agentRunSummary(run)).toBeNull();
    expect(dispatchedAgents(run)).toEqual([]);
    expect(agentRunSummary(reported({ state: 'working', summary: ' \n ' }))).toBeNull();
    const review = { id: 'c-2', agent: 'review', status: 'done' as const, summary: 'LGTM.' };
    const done = reported({
      state: 'done',
      summary: 'Posted the review.\n\n- one',
      agents: [review],
    });
    expect(agentRunSummary(done)).toBe('Posted the review.\n\n- one');
    expect(dispatchedAgents(done)).toEqual([review]);
    const statuses: Record<DispatchedAgentStatus, string> = DISPATCHED_STATUS_WORDS;
    expect(statuses).toEqual({ working: 'Working', done: 'Done', failed: 'Failed' });
  });

  it('says what it has not reported yet, by where it stands', () => {
    expect(noSummaryWords('starting', 'foreman')).toBe('foreman starts once the sandbox is ready.');
    expect(noSummaryWords('working', 'foreman')).toBe('foreman hasn’t reported a result yet.');
    expect(noSummaryWords('failed', 'foreman')).toBe('foreman reported no result.');
    expect(noAgentsWords('waiting', 'foreman')).toBe('foreman hasn’t dispatched an agent yet.');
    expect(noAgentsWords('done', 'foreman')).toBe('foreman dispatched no agent.');
    expect(dispatchedCount(1)).toBe('1 agent');
    expect(dispatchedCount(3)).toBe('3 agents');
  });

  it('is read every 5 s while it runs, since its report moves, and never once it ended', () => {
    expect(sessionPollIntervalMs(run)).toBe(5000);
    expect(sessionPollIntervalMs({ ...run, status: 'starting' })).toBe(2000);
    expect(sessionPollIntervalMs({ ...run, status: 'stopped' })).toBeNull();
    expect(sessionPollIntervalMs(session)).toBe(10_000);
  });

  it.each([
    [
      'runner_unavailable',
      'No runner was connected when the pull request’s event arrived, so this run never started.',
    ],
    [
      'repository_not_offered',
      'The connected runner doesn’t offer sprocket/catalog-portal, so this run never started.',
    ],
    [
      'harness_not_offered',
      'The connected runner has no API key for Claude Code, so this run never started.',
    ],
    [
      'agent_run_invalid',
      'Consola Cloud couldn’t put this run together from the factory’s files, so it never started.',
    ],
  ] satisfies Array<[CellFailureCode, string]>)(
    'words the API’s code %s for a run it could not hand to a runner',
    (errorCode, words) => {
      expect(sessionScreen({ ...run, status: 'failed', errorCode })).toEqual({
        kind: 'failed',
        words,
      });
    },
  );
});

describe('startedAt', () => {
  it('is the session’s start, from the API’s epoch seconds', () => {
    expect(startedAt(session)).toBe('2026-11-18T11:06:40.000Z');
  });
});

describe('the sentences', () => {
  it('says no runner is connected', () => {
    expect(NO_RUNNER_WORDS).toBe('No runner is connected for this workspace.');
    expect(messageForStartAnswer({ kind: 'refused', code: 'no_runner' }, session)).toBe(
      'No runner is connected for this workspace.',
    );
    expect(messageForPassAnswer({ kind: 'no-runner' })).toBe(
      'No runner is connected for this workspace.',
    );
  });

  it('names the repository or the harness the runner does not offer', () => {
    expect(
      messageForStartAnswer({ kind: 'refused', code: 'repository_not_offered' }, session),
    ).toBe('This runner does not offer sprocket/catalog-portal.');
    expect(
      messageForStartAnswer(
        { kind: 'refused', code: 'harness_not_offered' },
        { ...session, harness: 'codex' },
      ),
    ).toBe('This runner has no API key for Codex.');
    expect(messageForStartAnswer({ kind: 'refused', code: 'harness_not_offered' }, session)).toBe(
      'This runner has no API key for Claude Code.',
    );
  });

  it('says a start the API could not read', () => {
    expect(messageForStartAnswer({ kind: 'refused', code: 'invalid_request' }, session)).toBe(
      'Consola Cloud couldn’t read this repository or harness. Pick them again.',
    );
  });

  it('says a refusal of the API’s the way every page of the API does', () => {
    expect(messageForStartAnswer({ kind: 'unavailable' }, session)).toBe(
      'Consola Cloud isn’t answering. Start it with pnpm dev:cloud and try again.',
    );
    expect(messageForSessionAnswer({ kind: 'signed-out' })).toBe(
      'You’ve been signed out. Reload to sign in again.',
    );
  });

  it('says a session that is not the person’s, or not there', () => {
    const gone = 'This session isn’t here. It may be someone else’s, or the link may be wrong.';
    expect(messageForSessionAnswer({ kind: 'not-found' })).toBe(gone);
    expect(messageForStopAnswer({ kind: 'not-found' })).toBe(gone);
  });

  it('says what starting a session trusts', () => {
    expect(START_NOTE).toBe(
      'Starting a session runs this repository’s own settings and hooks inside a sandbox for this session.',
    );
  });
});
