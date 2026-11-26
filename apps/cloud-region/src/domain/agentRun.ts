import { planAgentRun } from '@consola/factory-spec';
import type { AgentTeam, PullRequestEvent, TeamAutomation } from '@consola/factory-spec';
import {
  AGENT_RUN_FACTORY_DIR,
  readAgentRun,
  SESSION_REPOSITORY_DIR,
} from '@consola/runner-protocol';
import type { AgentRun, Harness } from '@consola/runner-protocol';
import type { SessionOrigin } from './cloudSession.js';

/**
 * Agent runs: Warp's software-factory model, an alternative to the steps design. A GitHub event
 * fires an automation of a factory's team, which starts a cloud session nobody types into, whose
 * first agent is the automation's (by default the team's foreman). These are the rules the cell
 * keeps about one: what it is called, where it came from, and the start it hands the runner.
 */

/** The longest an agent run's title may be, in characters. */
export const AGENT_RUN_TITLE_MAX = 200;

/** A control character: a line break, a tab, an escape. */
const CONTROL = /\p{Cc}+/gu;

/**
 * An agent run's title, which the cell gives it and the runner never replaces:
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
 * protocol's reader so the cell never sends what a runner would refuse. A plan that cannot be
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
