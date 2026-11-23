import {
  isStepsEntry,
  type AgentDefinition,
  type Automation,
  type Step,
} from '@consola/factory-spec';
import { clipText } from './steps/commandIO';
import type { AutomationView } from './views';

/** The most of a command's first line a step's summary shows. */
const COMMAND_SUMMARY_CHARS = 80;

const actionRuns = (name: string) => `${name} action`;

/** What an entry runs, in words: "Review action", "Prompt", "Tool: cleanup_stale_sessions", "Steps: review → publish". */
export function describeRun(automation: Automation): string {
  if (isStepsEntry(automation))
    return `Steps: ${automation.steps.map((step) => step.id).join(' → ')}`;
  const { run } = automation;
  if (run.kind === 'tool') return `Tool: ${run.tool}`;
  return run.kind === 'action' ? actionRuns(run.name) : 'Prompt';
}

/** A tool run in-process, or agent sessions; an entry of commands only runs no agent, so it reads as a tool. */
export function describeKind(automation: Automation): AutomationView['kind'] {
  if (isStepsEntry(automation))
    return automation.steps.some((step) => step.kind === 'agent') ? 'agent' : 'tool';
  return automation.run.kind === 'tool' ? 'tool' : 'agent';
}

/** An agent as a step's node names it: "investigator · claude-work · opus", its harness and model when it sets them. */
function agentWords(
  name: string,
  agent: Pick<AgentDefinition, 'harness' | 'model'> | undefined,
): string {
  return [name, agent?.harness, agent?.model].filter((part) => part !== undefined).join(' · ');
}

/**
 * Each step as the automation page draws it: "Prompt", "Review action", an
 * agent-only step's agent, or the command's first line. A step that names an
 * agent also gives its agent's words and file; `agents` (by name) gives each
 * one's harness and model, and its servers and skills when it names any
 * (the node's third line); an agent it lacks is named alone.
 */
export function describeSteps(
  steps: Step[],
  agents?: Readonly<
    Record<
      string,
      Pick<AgentDefinition, 'harness' | 'model'> &
        Partial<Pick<AgentDefinition, 'mcpServers' | 'skills'>>
    >
  >,
): NonNullable<AutomationView['steps']> {
  return steps.map((step) => {
    const known =
      step.kind === 'agent' &&
      step.agent !== undefined &&
      agents &&
      Object.prototype.hasOwnProperty.call(agents, step.agent)
        ? agents[step.agent]
        : undefined;
    const agent =
      step.kind === 'agent' && step.agent !== undefined
        ? {
            words: agentWords(step.agent, known),
            file: `agents/${step.agent}.md`,
            servers: known?.mcpServers?.map((server) => ({
              name: server.name,
              ...(server.tools !== undefined ? { tools: [...server.tools] } : {}),
            })),
            skills: known?.skills ? [...known.skills] : undefined,
          }
        : undefined;
    return {
      id: step.id,
      kind: step.kind,
      ...(step.if !== undefined ? { if: step.if } : {}),
      ...((step.kind === 'run' || step.kind === 'uses') && step.dryRun === 'run'
        ? { dryRun: true as const }
        : {}),
      summary:
        step.kind === 'uses'
          ? step.uses
          : step.kind === 'run'
            ? commandSummary(step.run)
            : step.action !== undefined
              ? actionRuns(step.action)
              : step.prompt === undefined && agent
                ? agent.words
                : 'Prompt',
      ...(agent ? { agent: agent.words, agentFile: agent.file } : {}),
      ...(agent?.servers && agent.servers.length > 0 ? { servers: agent.servers } : {}),
      ...(agent?.skills && agent.skills.length > 0 ? { skills: agent.skills } : {}),
    };
  });
}

function commandSummary(command: string): string {
  const line = command
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text !== '');
  return clipText(line ?? '', COMMAND_SUMMARY_CHARS);
}

/** A poll's interval, in words and as written: `{ words: '90 minutes', short: '90m' }`, `{ words: '2 hours', short: '2h' }`. */
export function describeEvery(ms: number): { words: string; short: string } {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return { words: `${hours} ${hours === 1 ? 'hour' : 'hours'}`, short: `${hours}h` };
  }
  return { words: `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`, short: `${minutes}m` };
}

/** An event trigger that did not resolve, said as written. */
export function describeTriggerAsWritten(automation: Automation): string {
  const { trigger } = automation;
  if (trigger.kind === 'event') return `${trigger.connection}: ${trigger.events.join(', ')}`;
  if (trigger.kind === 'poll') return `poll: every ${describeEvery(trigger.everyMs).short}`;
  return trigger.kind === 'manual' ? 'manual' : trigger.cron;
}
