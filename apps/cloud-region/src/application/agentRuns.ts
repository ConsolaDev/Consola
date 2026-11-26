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
  agentRunStart,
  agentRunTitle,
} from '../domain/agentRun.js';
import { CELL_FAILURE_CODES } from '../domain/cloudSession.js';
import type { CellFailureCode, CloudSession } from '../domain/cloudSession.js';
import type { Factory } from '../domain/factory.js';
import { handToRunner } from './cloudSessions.js';
import type { AgentRunPorts } from './ports.js';

/*
 * Agent runs: Warp's software-factory model, beside the steps design. A GitHub `pull_request`
 * event fires the automations of a workspace's factories' agent teams whose triggers match it,
 * and each starts an agent run: a cloud session no person started or types into, whose first
 * agent is the automation's. The cell records it, hands its start to the workspace's runner, and
 * keeps what the runner reports (`applyRunnerUpdate`).
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
  if (code !== null || !offer || !start.ok) return session;
  return handToRunner(ports, session, offer.runnerId, { agentRun: start.value });
}
