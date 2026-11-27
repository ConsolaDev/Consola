import { planAgentRun } from '@consola/factory-spec';
import type { AgentTeam, PullRequestEvent, TeamAutomation } from '@consola/factory-spec';
import {
  AGENT_RUN_FACTORY_DIR,
  readAgentRun,
  SESSION_REPOSITORY_DIR,
} from '@consola/runner-protocol';
import type { AgentRun, Harness } from '@consola/runner-protocol';
import type { CellFailureCode, CloudSession, SessionOrigin } from './cloudSession.js';
import { REQUEST_TEXT_MAX_BYTES, stepRecordOf } from './run.js';
import type { RunStatus, RunWrite, StepStatus, WaitingOn } from './run.js';

/**
 * Agent runs: a software factory led by one agent, an alternative to the steps design. A GitHub event
 * fires an automation of a factory's team, which starts a cloud session nobody types into, whose
 * first agent is the automation's (by default the team's orchestrator). These are the rules the app
 * keeps about one: what it is called, where it came from, and the start it hands the runner.
 */

/** The longest an agent run's title may be, in characters. */
export const AGENT_RUN_TITLE_MAX = 200;

/** A control character: a line break, a tab, an escape. */
const CONTROL = /\p{Cc}+/gu;

/**
 * An agent run's title, which the app gives it and the runner never replaces:
 * `<automation> · <owner/name>#<number> <title>`, on one line, cut to `AGENT_RUN_TITLE_MAX`.
 */
export function agentRunTitle(automation: string, event: PullRequestEvent): string {
  const whole = `${automation} · ${event.repository}#${event.number} ${event.title}`
    .replaceAll(CONTROL, ' ')
    .trim();
  const characters = [...whole];
  if (characters.length <= AGENT_RUN_TITLE_MAX) return whole;
  return `${characters
    .slice(0, AGENT_RUN_TITLE_MAX - 1)
    .join('')
    .trimEnd()}…`;
}

/** Where an agent run came from: the factory, its automation and agent, and the pull request. */
export function agentRunOrigin(
  factory: { id: string; name: string },
  automation: TeamAutomation,
  event: PullRequestEvent,
): SessionOrigin {
  return {
    kind: 'automation',
    factoryId: factory.id,
    factoryName: factory.name,
    automation: automation.name,
    agent: automation.agent,
    item: {
      kind: 'pull_request',
      repository: event.repository,
      number: event.number,
      url: event.url,
      title: event.title,
      headSha: event.headSha,
    },
  };
}

/** The harness an agent run's first agent runs on: its own, or `claude` when it names none. */
export function agentRunHarness(team: AgentTeam, automation: TeamAutomation): Harness {
  return team.agents.find((agent) => agent.name === automation.agent)?.harness ?? 'claude';
}

/**
 * The start the runner is handed for an agent run with id `runId`: factory-spec's plan for the
 * automation on the event, with the pull request's head to check out, read back with the
 * protocol's reader so the app never sends what a runner would refuse. A plan that cannot be
 * made (factory-spec throws when the automation's agent is not in the team) or that the reader
 * refuses is `ok: false`, with the reason, for the log.
 */
export function agentRunStart(
  team: AgentTeam,
  automation: TeamAutomation,
  event: PullRequestEvent,
  runId: string,
): { ok: true; value: AgentRun } | { ok: false; reason: string } {
  let plan: ReturnType<typeof planAgentRun>;
  try {
    plan = planAgentRun(team, automation, event, {
      factoryDir: AGENT_RUN_FACTORY_DIR,
      repositoryDir: SESSION_REPOSITORY_DIR,
      runId,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `the run could not be planned: ${error instanceof Error ? error.message : 'an unexpected error'}`,
    };
  }
  const read = readAgentRun({
    ...plan,
    checkout: { ref: `refs/pull/${event.number}/head`, sha: event.headSha },
  });
  return read.ok
    ? { ok: true, value: read.value }
    : { ok: false, reason: `the protocol refuses the start: ${read.reason}` };
}

/** What the app knows of an agent run's run that its session does not say. */
export type AgentRunFacts = {
  /** The factory version whose files the run started from. */
  readonly factoryVersion: number;
  /** What the run's first agent was sent: the automation's prompt, as planned for the event. */
  readonly text: string;
  /** When the run was recorded first, as an ISO 8601 time. */
  readonly createdAt: string;
};

/** The longest one-line summary of an ended agent run, in characters. */
export const AGENT_RUN_SUMMARY_LINE_MAX = 300;

/** How each failure the app decides reads on a run's page, as its error. */
const FAILURE_WORDS: Record<CellFailureCode, string> = {
  runner_restarted: 'The runner restarted, and the sandbox this run worked in is gone.',
  runner_unreachable: 'The cell could not hand this run to its runner.',
  runner_failed: 'The runner says the run failed, and gave no reason.',
  runner_unavailable: 'No runner was connected for this workspace, so nothing ran.',
  repository_not_offered: 'The runner does not offer this repository, so nothing ran.',
  harness_not_offered: "The runner does not offer the first agent's harness, so nothing ran.",
  agent_run_invalid: 'The run could not be planned from its factory files, so nothing ran.',
};

const ISO = (seconds: number) => new Date(seconds * 1000).toISOString();

/** `text` cut to at most `REQUEST_TEXT_MAX_BYTES` of UTF-8, at a whole character. */
function fitRequestText(text: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= REQUEST_TEXT_MAX_BYTES) return text;
  let kept = '';
  let bytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (bytes + size > REQUEST_TEXT_MAX_BYTES) break;
    kept += character;
    bytes += size;
  }
  return kept;
}

/** The first line of the orchestrator's result that says something, cut to one line of the list. */
function summaryLine(summary: string | undefined): string | null {
  const line = summary
    ?.split(/\r\n|\r|\n/)
    .map((each) => each.replaceAll(CONTROL, ' ').trim())
    .find((each) => each !== '');
  if (line === undefined) return null;
  const characters = [...line];
  return characters.length <= AGENT_RUN_SUMMARY_LINE_MAX
    ? line
    : `${characters
        .slice(0, AGENT_RUN_SUMMARY_LINE_MAX - 1)
        .join('')
        .trimEnd()}…`;
}

/** Where an agent run stands: as a run, what it waits on, and as its one step. */
type Standing = { status: RunStatus; waitingOn: WaitingOn | null; step: StepStatus };

/** Where an agent run stands, by its session and the runner's last report of it. */
function standingOf(session: CloudSession): Standing {
  const state = session.agentRun?.state;
  switch (session.status) {
    case 'starting':
      return { status: 'queued', waitingOn: null, step: 'queued' };
    case 'running':
      if (state === 'waiting') return { status: 'waiting', waitingOn: 'person', step: 'waiting' };
      if (state === 'done') return { status: 'completed', waitingOn: null, step: 'completed' };
      if (state === 'failed') return { status: 'failed', waitingOn: null, step: 'failed' };
      return { status: 'running', waitingOn: null, step: 'running' };
    case 'stopped':
      // The host stops once its run is over and nobody is connected: a stop after a finished run
      // is the run's end, not a cancel.
      if (state === 'done') return { status: 'completed', waitingOn: null, step: 'completed' };
      if (state === 'failed') return { status: 'failed', waitingOn: null, step: 'failed' };
      return { status: 'cancelled', waitingOn: null, step: 'failed' };
    case 'failed':
      return { status: 'failed', waitingOn: null, step: 'failed' };
  }
}

/**
 * An agent run as the Runs pages show it: a **request** (the orchestrator spec, "A request is a
 * run"), since an automation of a team hands its event to an agent (by default the orchestrator) rather
 * than running steps of its own. Its one step is that agent (`orchestrator`), its trigger the
 * event, its item the pull request, its text what the agent was sent, and its conversation the
 * cloud session the agent works in. Its id is the session's. Where it stands follows the session
 * and the runner's last report (`standingOf`); an error is the runner's message or the app's
 * sentence for its own code. Null for a session that is no agent run.
 */
export function agentRunRecord(
  session: CloudSession,
  facts: AgentRunFacts,
  updatedAt: string,
): RunWrite | null {
  const { origin } = session;
  if (origin === null) return null;
  const { status, waitingOn, step } = standingOf(session);
  const ended = status === 'completed' || status === 'failed' || status === 'cancelled';
  const error =
    status === 'failed'
      ? (session.error ??
        (session.errorCode === null ? null : FAILURE_WORDS[session.errorCode]) ??
        'The agent says its run failed.')
      : null;
  const startedAt = session.status === 'starting' ? null : ISO(session.createdAt);
  const finishedAt = session.endedAt === null ? null : ISO(session.endedAt);
  return {
    id: session.id,
    factoryId: origin.factoryId,
    factoryVersion: facts.factoryVersion,
    parent: null,
    automation: null,
    status,
    waitingOn,
    trigger: 'event',
    triggerDetail: origin.item.kind,
    startedBy: null,
    item: {
      url: origin.item.url,
      title: origin.item.title,
      kind: 'pr',
      repo: origin.item.repository,
      number: origin.item.number,
    },
    runner: 'cloud',
    steps: [
      stepRecordOf({
        id: 'orchestrator',
        kind: 'orchestrator',
        status: step,
        attempt: 1,
        agent: origin.agent,
        model: null,
        startedAt,
        finishedAt,
        costUsd: null,
        error,
        skipped: null,
      }),
    ],
    request: {
      text: fitRequestText(facts.text),
      budget: null,
      spent: { usd: 0, runs: 0 },
      question: null,
    },
    conversation: session.id,
    summary: ended ? summaryLine(session.agentRun?.summary) : null,
    error,
    costUsd: null,
    createdAt: facts.createdAt,
    startedAt,
    finishedAt,
    updatedAt,
  };
}
