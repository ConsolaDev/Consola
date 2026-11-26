import { AGENT_RUN_SUMMARY_MAX, readAgentRunReport } from '@consola/runner-protocol';
import { describe, expect, it } from 'vite-plus/test';
import {
  agentBrief,
  agentRunView,
  DISPATCHED_SUMMARY_MAX,
  decideDispatch,
  decideFollowUp,
  FINAL_MESSAGE_GRACE_MS,
  MAX_DISPATCHED_AGENTS,
  MAX_RUNNING_AGENTS,
  NOT_THE_ORCHESTRATOR,
  reportBody,
  reportMessage,
  reportReady,
} from './agentRun.ts';
import type { ChildFacts, OrchestratorFacts } from './agentRun.ts';
import { AGENT_RUN_TOOLS, readToolCall } from './agentRunTools.ts';

const review = { name: 'review', description: 'Reviews a pull request.', instructions: 'Review.' };
const lint = { name: 'lint', description: 'Lints.', instructions: 'Lint.' };
const run = { agents: [review, lint] };

const idleOrchestrator: OrchestratorFacts = {
  active: false,
  queued: false,
  pendingRequest: false,
  lastRunStatus: 'completed',
  lastMessage: { id: 'message-2', text: 'Posted the review on Sprocket#12.' },
};

const child = (fields: Partial<ChildFacts> = {}): ChildFacts => ({
  id: 'session-sprocket-review-1',
  agent: 'review',
  active: false,
  queued: false,
  pendingRequest: false,
  undelivered: false,
  lastEnded: { status: 'completed', body: 'Two findings.' },
  ...fields,
});

describe('decideDispatch', () => {
  it('starts an agent the run names', () => {
    const decided = decideDispatch({
      run,
      callerIsOrchestrator: true,
      agent: 'review',
      running: 0,
      dispatched: 0,
    });
    expect(decided).toEqual({ ok: true, agent: review });
  });

  it('refuses a dispatched agent: only the orchestrator dispatches', () => {
    expect(
      decideDispatch({
        run,
        callerIsOrchestrator: false,
        agent: 'review',
        running: 0,
        dispatched: 0,
      }),
    ).toEqual({ ok: false, error: NOT_THE_ORCHESTRATOR });
    expect(NOT_THE_ORCHESTRATOR).toBe('You cannot dispatch other agents.');
  });

  it('refuses an agent the run does not name, listing the names', () => {
    const decided = decideDispatch({
      run,
      callerIsOrchestrator: true,
      agent: 'deploy',
      running: 0,
      dispatched: 0,
    });
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.error).toContain('review, lint');
  });

  it(`refuses a fifth while ${MAX_RUNNING_AGENTS} run, and saying so`, () => {
    expect(MAX_RUNNING_AGENTS).toBe(4);
    const decided = decideDispatch({
      run,
      callerIsOrchestrator: true,
      agent: 'review',
      running: 4,
      dispatched: 4,
    });
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.error).toContain('the most that may run at once (4)');
    expect(
      decideDispatch({
        run,
        callerIsOrchestrator: true,
        agent: 'review',
        running: 3,
        dispatched: 9,
      }).ok,
    ).toBe(true);
  });

  it('refuses past the most a report can list', () => {
    expect(
      decideDispatch({
        run,
        callerIsOrchestrator: true,
        agent: 'review',
        running: 0,
        dispatched: MAX_DISPATCHED_AGENTS,
      }).ok,
    ).toBe(false);
  });
});

describe('decideFollowUp', () => {
  it('refuses a dispatched agent, and a finished agent past the cap, but not a running one', () => {
    expect(decideFollowUp({ callerIsOrchestrator: false, childRunning: true, running: 0 })).toEqual(
      {
        ok: false,
        error: NOT_THE_ORCHESTRATOR,
      },
    );
    expect(decideFollowUp({ callerIsOrchestrator: true, childRunning: false, running: 4 }).ok).toBe(
      false,
    );
    expect(decideFollowUp({ callerIsOrchestrator: true, childRunning: true, running: 4 }).ok).toBe(
      true,
    );
  });
});

describe('a report', () => {
  it('briefs an agent with its instructions, then the orchestrator’s task', () => {
    expect(agentBrief(review, 'Review Sprocket#12.')).toBe(
      'Review.\n\n# Brief from the orchestrator\n\nReview Sprocket#12.',
    );
  });

  it('carries a completed run’s final message, as is', () => {
    expect(
      reportMessage({
        agent: 'review',
        childId: 'session-sprocket-review-1',
        status: 'completed',
        body: reportBody('completed', { text: 'Two findings.', streaming: false }, null),
      }),
    ).toBe(
      'Report from agent `review` (id session-sprocket-review-1, status completed):\n\nTwo findings.',
    );
  });

  it('carries a failed run’s status and t3’s reason, and invents nothing', () => {
    expect(reportBody('failed', null, 'The provider stopped.')).toBe(
      'Reason: The provider stopped.',
    );
    expect(reportBody('interrupted', null, null)).toBe(
      'Its run ended interrupted; t3 gave no reason.',
    );
    expect(reportBody('failed', { text: 'Half done.', streaming: false }, 'Out of turns.')).toBe(
      'Reason: Out of turns.\n\nIts last message:\n\nHalf done.',
    );
  });

  it('waits for a completed run’s message to finish, but not past the grace', () => {
    const completed = { status: 'completed' as const };
    expect(reportReady(completed, { text: 'Two', streaming: true }, 0)).toBe(false);
    expect(reportReady(completed, { text: 'Two findings.', streaming: false }, 0)).toBe(true);
    expect(reportReady(completed, null, 0)).toBe(false);
    expect(reportReady(completed, null, FINAL_MESSAGE_GRACE_MS)).toBe(true);
    expect(reportReady({ status: 'failed' }, null, 0)).toBe(true);
  });
});

describe('agentRunView', () => {
  it('is working before the orchestrator’s first run, and while anything runs or waits to be delivered', () => {
    const before = agentRunView({
      orchestrator: { ...idleOrchestrator, lastRunStatus: null, lastMessage: null },
      children: [],
      completion: null,
    });
    expect(before).toEqual({ report: { state: 'working' }, status: 'idle' });

    for (const busy of [
      { orchestrator: { ...idleOrchestrator, active: true }, children: [] },
      { orchestrator: { ...idleOrchestrator, queued: true }, children: [] },
      { orchestrator: idleOrchestrator, children: [child({ active: true })] },
      { orchestrator: idleOrchestrator, children: [child({ undelivered: true })] },
    ]) {
      const view = agentRunView({ ...busy, completion: null });
      expect(view.report.state).toBe('working');
      expect(view.status).toBe('working');
    }
  });

  it('is waiting while any thread waits on a question', () => {
    const view = agentRunView({
      orchestrator: { ...idleOrchestrator, active: true },
      children: [child({ active: true, pendingRequest: true })],
      completion: null,
    });
    expect(view.report.state).toBe('waiting');
    expect(view.status).toBe('waiting');
  });

  it('is done once the orchestrator’s last run completed and nothing is active, and failed when it did not', () => {
    const done = agentRunView({
      orchestrator: idleOrchestrator,
      children: [child()],
      completion: null,
    });
    expect(done).toEqual({
      report: {
        state: 'done',
        summary: 'Posted the review on Sprocket#12.',
        agents: [
          {
            id: 'session-sprocket-review-1',
            agent: 'review',
            status: 'done',
            summary: 'Two findings.',
          },
        ],
      },
      status: 'idle',
    });
    const failed = agentRunView({
      orchestrator: { ...idleOrchestrator, lastRunStatus: 'failed' },
      children: [child({ lastEnded: { status: 'interrupted', body: 'Reason: stopped.' } })],
      completion: null,
    });
    expect(failed.report.state).toBe('failed');
    expect(failed.report.agents?.[0]?.status).toBe('failed');
    expect(failed.status).toBe('idle');
  });

  it('says complete_task’s summary while no message followed it, and the later message once one did', () => {
    const recorded = { summary: 'Reviewed and posted.', afterMessageId: 'message-2' };
    expect(
      agentRunView({ orchestrator: idleOrchestrator, children: [], completion: recorded }).report
        .summary,
    ).toBe('Reviewed and posted.');
    const later = {
      ...idleOrchestrator,
      lastMessage: { id: 'message-3', text: 'All done.' },
    };
    expect(
      agentRunView({ orchestrator: later, children: [], completion: recorded }).report.summary,
    ).toBe('All done.');
  });

  it('cuts what it says to what the protocol reads', () => {
    const view = agentRunView({
      orchestrator: { ...idleOrchestrator, lastMessage: { id: 'm', text: 'a'.repeat(20_000) } },
      children: [child({ lastEnded: { status: 'completed', body: 'b'.repeat(5000) } })],
      completion: null,
    });
    expect(view.report.summary).toHaveLength(AGENT_RUN_SUMMARY_MAX);
    expect(view.report.agents?.[0]?.summary).toHaveLength(DISPATCHED_SUMMARY_MAX);
    expect(readAgentRunReport(view.report).ok).toBe(true);
  });
});

describe('the tools', () => {
  it('lists the names t3’s orchestration instructions teach, and complete_task', () => {
    expect(AGENT_RUN_TOOLS.map((tool) => tool.name)).toEqual([
      'orchestrator_capabilities',
      'delegate_task',
      't3_thread_send',
      'task_status',
      'task_cancel',
      'complete_task',
    ]);
  });

  it('reads a call’s arguments, ignores fields it does not name, and names one it lacks', () => {
    expect(
      readToolCall('delegate_task', { agent: ' review ', task: 'Review #12.', target: {} }),
    ).toEqual({ ok: true, call: { tool: 'delegate_task', agent: 'review', task: 'Review #12.' } });
    expect(readToolCall('delegate_task', { task: 'Review #12.' })).toEqual({
      ok: false,
      error: 'delegate_task needs `agent`, as text.',
    });
    const unknown = readToolCall('t3_thread_launch', {});
    expect(unknown.ok).toBe(false);
  });
});
