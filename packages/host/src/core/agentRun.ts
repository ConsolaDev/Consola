/**
 * The pure decisions of an agent run (`packages/host/AGENTS.md`, "Agent runs"): which agent a
 * dispatch may start, what a dispatched agent's brief and report say, when a report is ready to
 * deliver, and what the run's report (`AgentRunReport`) and the session's status are from what the
 * session's threads hold. `runtime/agentRun.ts` reads the threads and acts on these.
 */
import { AGENT_RUN_SUMMARY_MAX } from '@consola/runner-protocol';
import type {
  AgentRun,
  AgentRunAgent,
  AgentRunReport,
  AgentRunState,
  DispatchedAgent,
} from '@consola/runner-protocol';
import type {
  OrchestrationV2Run,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadProjection,
} from '@t3tools/contracts';
import type { SessionStatus } from './hostLine.ts';

/** The most dispatched agents that may run at once; a dispatch past it is refused. */
export const MAX_RUNNING_AGENTS = 4;
/** The most agents one run may dispatch: an `AgentRunReport` lists at most 32. */
export const MAX_DISPATCHED_AGENTS = 32;
/** How much of a dispatched agent's last report an `agent-run` line carries. */
export const DISPATCHED_SUMMARY_MAX = 2000;
/**
 * How long after a run completed its last message may still read as streaming before the report
 * goes with what it holds: t3 finishes a message before its run, so this is a safety net only.
 */
export const FINAL_MESSAGE_GRACE_MS = 10_000;

/** The statuses a run ends in (t3's `OrchestrationV2RunStatus`, less the live ones). */
const ENDED: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
]);

export const hasEnded = (run: Pick<OrchestrationV2Run, 'status'>): boolean => ENDED.has(run.status);

/** `text` cut to `max` characters. */
export const cut = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max);

/** The first message a dispatched agent gets: its standing instructions, then the brief. */
export const agentBrief = (agent: AgentRunAgent, task: string): string =>
  `${agent.instructions}\n\n# Brief from the orchestrator\n\n${task}`;

/** What one run of a thread said last: its last assistant message, and whether it is done. */
export type FinalMessage = { readonly text: string; readonly streaming: boolean };

/** The last assistant message of `runId` with text in it, or null. */
export function finalMessageOf(
  projection: Pick<OrchestrationV2ThreadProjection, 'messages'>,
  runId: string,
): FinalMessage | null {
  for (let index = projection.messages.length - 1; index >= 0; index -= 1) {
    const message = projection.messages[index];
    if (message === undefined) continue;
    if (message.runId === runId && message.role === 'assistant' && message.text.trim() !== '') {
      return { text: message.text.trim(), streaming: message.streaming };
    }
  }
  return null;
}

/** What t3 said of why `runId` did not complete (its error item), or null. */
export function failureOf(
  projection: Pick<OrchestrationV2ThreadProjection, 'turnItems'>,
  runId: string,
): string | null {
  for (let index = projection.turnItems.length - 1; index >= 0; index -= 1) {
    const item = projection.turnItems[index];
    if (item?.runId === runId && item.type === 'error') {
      const said = item.failure.message.trim();
      if (said !== '') return said;
    }
  }
  return null;
}

/**
 * Whether an ended run's report can go now: a run that did not complete goes at once, with its
 * status and reason; a completed one once its last message is done, or `FINAL_MESSAGE_GRACE_MS`
 * after it was first seen ended.
 */
export function reportReady(
  run: Pick<OrchestrationV2Run, 'status'>,
  final: FinalMessage | null,
  endedForMs: number,
): boolean {
  if (run.status !== 'completed') return true;
  if (final !== null && !final.streaming) return true;
  return endedForMs >= FINAL_MESSAGE_GRACE_MS;
}

/** What a dispatched agent's run ended with: the text its report carries. */
export function reportBody(
  status: OrchestrationV2RunStatus,
  final: FinalMessage | null,
  failure: string | null,
): string {
  if (status === 'completed') {
    return final === null ? '(The agent ended its turn without a message.)' : final.text;
  }
  const lines = [
    failure === null ? `Its run ended ${status}; t3 gave no reason.` : `Reason: ${failure}`,
  ];
  if (final !== null) lines.push(`Its last message:\n\n${final.text}`);
  return lines.join('\n\n');
}

/** The message that delivers a dispatched agent's report to the orchestrator's conversation. */
export const reportMessage = (input: {
  readonly agent: string;
  readonly childId: string;
  readonly status: OrchestrationV2RunStatus;
  readonly body: string;
}): string =>
  `Report from agent \`${input.agent}\` (id ${input.childId}, status ${input.status}):\n\n${input.body}`;

/** A dispatch refused, in the words the tool answers with. */
export type Refusal = { readonly ok: false; readonly error: string };

export const NOT_THE_ORCHESTRATOR = 'You cannot dispatch other agents.';

/** Which agent a `delegate_task` call starts, or why it starts none. */
export function decideDispatch(input: {
  readonly run: Pick<AgentRun, 'agents'>;
  readonly callerIsOrchestrator: boolean;
  readonly agent: string;
  readonly running: number;
  readonly dispatched: number;
}): { readonly ok: true; readonly agent: AgentRunAgent } | Refusal {
  if (!input.callerIsOrchestrator) return { ok: false, error: NOT_THE_ORCHESTRATOR };
  const agent = input.run.agents.find((each) => each.name === input.agent);
  if (agent === undefined) {
    const names = input.run.agents.map((each) => each.name);
    return {
      ok: false,
      error:
        names.length === 0
          ? `There is no agent \`${input.agent}\`: this run has no agents to dispatch.`
          : `There is no agent \`${input.agent}\`. The agents you may dispatch are: ${names.join(', ')}.`,
    };
  }
  if (input.running >= MAX_RUNNING_AGENTS) {
    return { ok: false, error: runningCapError(input.running) };
  }
  if (input.dispatched >= MAX_DISPATCHED_AGENTS) {
    return {
      ok: false,
      error: `This run has dispatched ${input.dispatched} agents, the most one run may; send follow-ups to one of them with t3_thread_send instead.`,
    };
  }
  return { ok: true, agent };
}

const runningCapError = (running: number) =>
  `${running} dispatched agents are running, the most that may run at once (${MAX_RUNNING_AGENTS}). End your turn: each report arrives as a message, and you can dispatch again then.`;

/** Whether a follow-up may go to a dispatched agent: never past the running cap. */
export function decideFollowUp(input: {
  readonly callerIsOrchestrator: boolean;
  readonly childRunning: boolean;
  readonly running: number;
}): { readonly ok: true } | Refusal {
  if (!input.callerIsOrchestrator) return { ok: false, error: NOT_THE_ORCHESTRATOR };
  if (!input.childRunning && input.running >= MAX_RUNNING_AGENTS) {
    return { ok: false, error: runningCapError(input.running) };
  }
  return { ok: true };
}

/** What the orchestrator's thread holds that the run's report reads. */
export type OrchestratorFacts = {
  /** A run that owns the thread's turn now (t3's `isActiveRun`). */
  readonly active: boolean;
  /** A message queued behind the active run and not held: a report on its way. */
  readonly queued: boolean;
  readonly pendingRequest: boolean;
  /** The status of the thread's latest run, or null before its first. */
  readonly lastRunStatus: OrchestrationV2RunStatus | null;
  /** Its last finished assistant message, or null. */
  readonly lastMessage: { readonly id: string; readonly text: string } | null;
};

/** What one dispatched agent's thread holds that the run's report reads. */
export type ChildFacts = {
  readonly id: string;
  readonly agent: string;
  readonly active: boolean;
  /** A message queued for it (a follow-up behind its turn). */
  readonly queued: boolean;
  readonly pendingRequest: boolean;
  /** An ended run whose report has not yet been handed to the orchestrator's thread. */
  readonly undelivered: boolean;
  /** How its last ended run ended, and its report's body, once one has. */
  readonly lastEnded: {
    readonly status: OrchestrationV2RunStatus;
    readonly body: string;
  } | null;
};

/** What `complete_task` recorded: its summary, and the last message the orchestrator had said. */
export type Completion = { readonly summary: string; readonly afterMessageId: string | null };

/** The run's report and the session's status (`status` line, idle exit), together. */
export type AgentRunView = { readonly report: AgentRunReport; readonly status: SessionStatus };

/** Whether two views say the same: a line is printed only when the view changes. */
export const sameView = (a: AgentRunView, b: AgentRunView): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Whether two reports say the same. */
export const sameReport = (a: AgentRunReport, b: AgentRunReport): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** A dispatched agent's status in the report: working until its last run's report is delivered. */
export function dispatchedStatus(child: ChildFacts): DispatchedAgent['status'] {
  if (child.active || child.queued || child.pendingRequest || child.undelivered) return 'working';
  if (child.lastEnded === null) return 'working';
  return child.lastEnded.status === 'completed' ? 'done' : 'failed';
}

/**
 * The run's report and the session's status from what its threads hold. `waiting` while any
 * thread waits on a runtime request; `working` while any has an active run, a message queued, or
 * an ended run whose report is undelivered (and before the orchestrator's first run); else
 * `failed` when the orchestrator's latest run did not complete, `done` when it did. The session's
 * status is the same, but `idle` for `done` and `failed`.
 */
export function agentRunView(input: {
  readonly orchestrator: OrchestratorFacts;
  readonly children: readonly ChildFacts[];
  readonly completion: Completion | null;
}): AgentRunView {
  const { orchestrator, children, completion } = input;
  const waiting = orchestrator.pendingRequest || children.some((child) => child.pendingRequest);
  const busy =
    orchestrator.active ||
    orchestrator.queued ||
    children.some((child) => child.active || child.queued || child.undelivered);
  const state: AgentRunState = waiting
    ? 'waiting'
    : busy || orchestrator.lastRunStatus === null
      ? 'working'
      : orchestrator.lastRunStatus === 'completed'
        ? 'done'
        : hasEnded({ status: orchestrator.lastRunStatus })
          ? 'failed'
          : 'working';
  const status: SessionStatus = waiting ? 'waiting' : busy ? 'working' : 'idle';

  const said =
    completion !== null && completion.afterMessageId === (orchestrator.lastMessage?.id ?? null)
      ? completion.summary
      : orchestrator.lastMessage?.text;
  const report: AgentRunReport = { state };
  if (said !== undefined && said !== '') report.summary = cut(said, AGENT_RUN_SUMMARY_MAX);
  if (children.length > 0) {
    report.agents = children.map((child) => {
      const dispatched: DispatchedAgent = {
        id: child.id,
        agent: child.agent,
        status: dispatchedStatus(child),
      };
      if (child.lastEnded !== null && child.lastEnded.body !== '') {
        dispatched.summary = cut(child.lastEnded.body, DISPATCHED_SUMMARY_MAX);
      }
      return dispatched;
    });
  }
  return { report, status };
}
