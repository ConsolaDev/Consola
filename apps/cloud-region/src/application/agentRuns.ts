import type { GitHubEventMessage } from '@consola/cloud-contract';
import {
  hasAgentTeam,
  matchPullRequestAutomations,
  parseAgentTeam,
  pullRequestEventOf,
} from '@consola/factory-spec';
import type { AgentTeam, PullRequestEvent, TeamAutomation } from '@consola/factory-spec';
import {
  agentRunHarness,
  agentRunOrigin,
  agentRunRecord,
  agentRunStart,
  agentRunTitle,
} from '../domain/agentRun.js';
import type { AgentRunFacts } from '../domain/agentRun.js';
import { CELL_FAILURE_CODES } from '../domain/cloudSession.js';
import type { CellFailureCode, CloudSession } from '../domain/cloudSession.js';
import type { Factory } from '../domain/factory.js';
import { handToRunner } from './cloudSessions.js';
import type { AgentRunPorts, Clock, CloudSessionStore, RunStore } from './ports.js';
import { recordRun } from './runs.js';

/*
 * Agent runs: a software factory led by one agent, beside the steps design. A GitHub `pull_request`
 * event fires the automations of a workspace's factories' agent teams whose triggers match it,
 * and each starts an agent run: a cloud session no person started or types into, whose first
 * agent is the automation's. The cell records it, hands its start to the workspace's runner, and
 * keeps what the runner reports (`applyRunnerUpdate`).
 *
 * Each agent run is also a run of the Runs pages: a request whose orchestrator is its first agent
 * and whose conversation is its session (`agentRunRecord`). The cell records that run itself, as
 * it starts the session, and again after every change to the session (`keepingRunsInStep`):
 * in this experiment the cell, not a runner, decides that a run starts, so it is the run's writer.
 */

/** The event's name GitHub gives a pull request's webhook. */
const PULL_REQUEST = 'pull_request';

/** What one event's agent runs need to know of it: its workspace and its pull request. */
type Firing = {
  workspaceId: string;
  factory: Factory;
  team: AgentTeam;
  automation: TeamAutomation;
  event: PullRequestEvent;
};

const about = (event: GitHubEventMessage) =>
  `GitHub delivery ${event.deliveryId} (${event.event}) for workspace ${event.workspaceId}`;

/**
 * Starts the agent runs a GitHub event fires, once the cell has recorded it for the first time:
 * for a `pull_request` event, each automation of each of the workspace's factories whose latest
 * files hold an agent team with no issues, whose triggers match it
 * (`matchPullRequestAutomations`), starts one run (`startAgentRun`). Any other event starts
 * nothing. A factory whose team has issues starts nothing, and says so in the log. One run that
 * cannot be recorded never stops the others; it is logged, with ids and names only. Answers the
 * runs as they were recorded. Throws only when the factories cannot be read.
 */
export async function startAgentRunsFor(
  ports: AgentRunPorts,
  message: GitHubEventMessage,
): Promise<CloudSession[]> {
  if (message.event !== PULL_REQUEST) return [];
  const event = pullRequestEventOf(message.payload);
  if (!event) {
    ports.report(`${about(message)} is no pull request the cell reads: it starts nothing.`);
    return [];
  }
  const { workspaceId } = message;
  const started: CloudSession[] = [];
  for (const factory of await ports.factories.list(workspaceId)) {
    const version = await ports.factories.version(workspaceId, factory.id, factory.latestVersion);
    if (!version || !hasAgentTeam(version.files)) continue;
    const { team, issues } = parseAgentTeam(version.files);
    if (issues.length > 0) {
      ports.report(
        `${about(message)}: the team of factory ${factory.id} has ${issues.length} problem(s) in its files, so it starts nothing.`,
      );
      continue;
    }
    for (const automation of matchPullRequestAutomations(team, event)) {
      try {
        started.push(await startAgentRun(ports, { workspaceId, factory, team, automation, event }));
      } catch (error) {
        const why = error instanceof Error ? error.message.split('\n')[0] : 'an unexpected error';
        ports.report(
          `${about(message)}: the automation ${automation.name} of factory ${factory.id} could not start a run: ${why}`,
        );
      }
    }
  }
  return started;
}

/**
 * Starts one agent run: the row is recorded whatever happens, so a person sees that the event
 * arrived and why nothing ran. Its title is the cell's (`agentRunTitle`), its origin the factory,
 * automation and pull request. It needs the workspace's connected runner to offer the event's
 * repository and the first agent's harness (`claude` when it names none), and a start the
 * protocol reads (`agentRunStart`); short of any of them, the row is recorded `failed` with the
 * cell's code for it (`runner_unavailable`, `repository_not_offered`, `harness_not_offered`,
 * `agent_run_invalid`, whose reason is logged), and nothing is sent. Otherwise it is recorded
 * `starting` and handed to the runner, as a person's session is (`handToRunner`).
 */
export async function startAgentRun(ports: AgentRunPorts, firing: Firing): Promise<CloudSession> {
  const { workspaceId, factory, team, automation, event } = firing;
  const id = ports.ids.newId();
  const now = ports.clock.nowSeconds();
  const harness = agentRunHarness(team, automation);
  const offer = ports.runners.connected(workspaceId);
  const wanted = event.repository.toLowerCase();
  const repository = offer?.repositories.find((offered) => offered.toLowerCase() === wanted);

  let code: CellFailureCode | null = null;
  const start = agentRunStart(team, automation, event, id);
  if (!offer) code = CELL_FAILURE_CODES.runnerUnavailable;
  else if (repository === undefined) code = CELL_FAILURE_CODES.repositoryNotOffered;
  else if (!offer.harnesses.includes(harness)) code = CELL_FAILURE_CODES.harnessNotOffered;
  else if (!start.ok) {
    code = CELL_FAILURE_CODES.agentRunInvalid;
    ports.report(
      `The agent run ${id} of automation ${automation.name} (factory ${factory.id}) did not start: ${start.reason}`,
    );
  }

  const session: CloudSession = {
    id,
    workspaceId,
    personId: null,
    repository: repository ?? event.repository,
    harness,
    status: code === null ? 'starting' : 'failed',
    title: agentRunTitle(automation.name, event),
    hostUrl: null,
    error: null,
    errorCode: code,
    runnerId: code === null && offer ? offer.runnerId : null,
    createdAt: now,
    endedAt: code === null ? null : now,
    origin: agentRunOrigin(factory, automation, event),
    agentRun: null,
  };
  await ports.sessions.insert(session);
  await recordAgentRun(ports, session, {
    factoryVersion: factory.latestVersion,
    text: start.ok ? start.value.prompt : automation.prompt,
    createdAt: new Date(now * 1000).toISOString(),
  });
  if (code !== null || !offer || !start.ok) return session;
  return handToRunner(ports, session, offer.runnerId, { agentRun: start.value });
}

/** What keeping an agent run's run needs: the runs, the clock, and the log. */
type RunKeeping = { runs: RunStore; clock: Clock; report: (line: string) => void };

/**
 * Records an agent run's run as its session stands now (`agentRunRecord`). A run the cell cannot
 * record (`recordRun`'s refusal, or a store that fails) is logged, with its id and why, and never
 * stops the session: the session is what runs, and the run only says so.
 */
async function recordAgentRun(
  ports: RunKeeping,
  session: CloudSession,
  facts: AgentRunFacts,
): Promise<void> {
  const record = agentRunRecord(
    session,
    facts,
    new Date(ports.clock.nowSeconds() * 1000).toISOString(),
  );
  if (record === null) return;
  try {
    const answer = await recordRun(ports.runs, session.workspaceId, record);
    if (answer.kind === 'invalid') {
      const fields = answer.problems.map((problem) => problem.field).join(', ');
      ports.report(`The run of agent run ${session.id} was not recorded: ${fields}.`);
    } else if (answer.kind !== 'recorded' && answer.kind !== 'stale') {
      ports.report(`The run of agent run ${session.id} was not recorded: ${answer.kind}.`);
    }
  } catch (error) {
    const why = error instanceof Error ? error.message.split('\n')[0] : 'an unexpected error';
    ports.report(`The run of agent run ${session.id} was not recorded: ${why}`);
  }
}

/**
 * The cloud session store, with each agent run's run kept in step with its session: after every
 * change that lands (`update`'s compare-and-set won), the session is read again and, for an agent
 * run, its run recorded again from what the run already holds (its factory version, its text and
 * when it was made) and the session as it is now. Every writer of a session goes through it (a
 * runner's update, its `hello`, a person's stop, a start handed over), so none can move a session
 * without its run. A run the cell holds no record of is left alone and logged: the record made as
 * the session started is the only one that may create it.
 */
export function keepingRunsInStep(
  sessions: CloudSessionStore,
  ports: RunKeeping,
): CloudSessionStore {
  return {
    ...sessions,
    async update(sessionId, expected, changes) {
      const won = await sessions.update(sessionId, expected, changes);
      if (won) await followSession(sessions, ports, sessionId);
      return won;
    },
  };
}

async function followSession(
  sessions: CloudSessionStore,
  ports: RunKeeping,
  sessionId: string,
): Promise<void> {
  try {
    const session = await sessions.find(sessionId);
    if (session === null || session.origin === null) return;
    const found = await ports.runs.get(session.workspaceId, session.id);
    if (found === null || found.request === null) {
      ports.report(`Agent run ${session.id} changed, but the cell holds no run of it to follow.`);
      return;
    }
    await recordAgentRun(ports, session, {
      factoryVersion: found.run.factory.version,
      text: found.request.text,
      createdAt: found.run.createdAt,
    });
  } catch (error) {
    const why = error instanceof Error ? error.message.split('\n')[0] : 'an unexpected error';
    ports.report(`The run of agent run ${sessionId} was not followed: ${why}`);
  }
}
