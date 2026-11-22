import {
  flatSteps,
  isStepsEntry,
  leafSteps,
  type AgentDefinition,
  type Automation,
  type RepeatStep,
  type Step,
  type StepEntry,
  type StepsAutomation,
} from '@consola/factory-spec';
import { clipText } from './steps/commandIO';
import type { AutomationView } from './views';

/** The most of a command's first line a step's summary shows. */
const COMMAND_SUMMARY_CHARS = 80;

const actionRuns = (name: string) => `${name} action`;

/**
 * What an entry runs, in words: "Review action", "Prompt", "Tool:
 * cleanup_stale_sessions", "Steps: review → publish" (a loop's steps in
 * line, as the run takes them).
 */
export function describeRun(automation: Automation): string {
  if (isStepsEntry(automation))
    return `Steps: ${leafSteps(automation.steps)
      .map((step) => step.id)
      .join(' → ')}`;
  const { run } = automation;
  if (run.kind === 'tool') return `Tool: ${run.tool}`;
  return run.kind === 'action' ? actionRuns(run.name) : 'Prompt';
}

/**
 * Whether a dry run of these steps starts anything: an agent step (read-only
 * agents run in a dry run) or a `dry_run: run` command, a loop's included.
 */
export function dryRunStarts(entries: readonly StepEntry[]): boolean {
  return leafSteps(entries).some(
    (step) => step.kind === 'agent' || (step.kind === 'run' && step.dryRun === 'run'),
  );
}

/** `1 time`, `3 times`. */
const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`;

/** An id in backticks, as the card's lines name steps. */
const quoted = (id: string) => `\`${id}\``;

/** `` `a` ``, `` `a` and `b` ``, `` `a`, `b` and `c` ``. */
function idsInWords(ids: readonly string[]): string {
  const words = ids.map(quoted);
  return words.length < 2
    ? words.join('')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const EXHAUSTED_WORDS = { fail: 'fails', continue: 'goes on', gate: 'asks you' } as const;

/**
 * How a run of this entry flows, as the approval and Allow cards say it
 * (Call 13), in this order: each loop, each gate, each command inside a
 * loop (how often it may run), each declared retry (a step's, then the
 * entry's; "Nothing retries by itself." when none is above 0), the budget.
 * The budget is the number as the file writes it (`$5`), never the
 * run-time `usdWords` (`$5.00`). Inside a loop a gate asks, and a step's
 * retries count, once per round; an entry that starts again begins its
 * loops again, so `max` bounds each start (3-A code review M7).
 */
export function describeFlow(automation: StepsAutomation): string[] {
  const entries = automation.steps;
  const loops = entries.filter((step): step is RepeatStep => step.kind === 'repeat');
  const leaves = leafSteps(entries);
  const inLoop = new Set(loops.flatMap((loop) => loop.steps.map((step) => step.id)));
  const eachRound = (id: string) => (inLoop.has(id) ? ' each round' : '');
  const loopLines = loops.map(
    (loop) =>
      `Repeats ${idsInWords(loop.steps.map((step) => step.id))} up to ${times(loop.max)} until ${quoted(loop.until)}; then ${EXHAUSTED_WORDS[describeLoop(loop).exhausted ?? 'fail']}.`,
  );
  const gateLines = leaves
    .filter((step) => step.kind === 'gate')
    .map((step) => `Stops for you at ${quoted(step.id)}${eachRound(step.id)}.`);
  const commandLines = loops.flatMap((loop) =>
    loop.steps
      .filter((step) => step.kind === 'run')
      .map((step) => `${quoted(step.id)} runs once per round (up to ${times(loop.max)}).`),
  );
  const retryLines = leaves.flatMap((step) => {
    const retry = step.kind === 'gate' ? 0 : (step.onFailure?.retry ?? 0);
    return retry > 0
      ? [`${quoted(step.id)} retries by itself up to ${times(retry)}${eachRound(step.id)}.`]
      : [];
  });
  const entryRetry = automation.onFailure?.retry ?? 0;
  if (entryRetry > 0)
    retryLines.push(
      `The whole run starts again by itself up to ${times(entryRetry)}, only if nothing in it acted${loops.length > 0 ? ', its loops from round 1' : ''}.`,
    );
  return [
    ...loopLines,
    ...gateLines,
    ...commandLines,
    ...(retryLines.length > 0 ? retryLines : ['Nothing retries by itself.']),
    automation.budget ? `Budget: $${String(automation.budget.usd)} at most (est.).` : 'No budget.',
  ];
}

/** A tool run in-process, or agent sessions; an entry of commands only runs no agent, so it reads as a tool. */
export function describeKind(automation: Automation): AutomationView['kind'] {
  if (isStepsEntry(automation))
    return leafSteps(automation.steps).some((step) => step.kind === 'agent') ? 'agent' : 'tool';
  return automation.run.kind === 'tool' ? 'tool' : 'agent';
}

/** An agent as a step's node names it: "investigator · claude-work · opus", its harness and model when it sets them. */
function agentWords(
  name: string,
  agent: Pick<AgentDefinition, 'harness' | 'model'> | undefined,
): string {
  return [name, agent?.harness, agent?.model].filter((part) => part !== undefined).join(' · ');
}

/** By name, what a step's node says of its agent: its harness and model, its servers and skills. */
type StepAgents = Readonly<
  Record<
    string,
    Pick<AgentDefinition, 'harness' | 'model'> &
      Partial<Pick<AgentDefinition, 'mcpServers' | 'skills'>>
  >
>;

/**
 * Each step as the automation page draws it, in record order (a loop's row,
 * then its steps, each with `loop`): "Prompt", "Review action", an
 * agent-only step's agent, the command's first line, or a gate's question
 * (with its question and choices again, as written). A step that names an
 * agent also gives its agent's words and file; `agents` (by name) gives each
 * one's harness and model, and its servers and skills when it names any
 * (the node's third line); an agent it lacks is named alone.
 */
export function describeSteps(
  entries: readonly StepEntry[],
  agents?: StepAgents,
): NonNullable<AutomationView['steps']> {
  return flatSteps(entries).map(({ step, block }) =>
    step.kind === 'repeat'
      ? describeLoop(step)
      : { ...describeLeaf(step, agents), ...(block ? { loop: block.id } : {}) },
  );
}

/** A loop's own row: its bound, its condition and how it ends; its steps follow it, each with `loop`. */
function describeLoop(step: RepeatStep): NonNullable<AutomationView['steps']>[number] {
  return {
    id: step.id,
    kind: 'repeat',
    ...(step.if !== undefined ? { if: step.if } : {}),
    summary: `up to ${step.max} rounds · until ${step.until.replace(/\bsteps\./g, '')}`,
    max: step.max,
    until: step.until,
    exhausted:
      step.onExhausted === undefined || step.onExhausted === 'fail'
        ? 'fail'
        : step.onExhausted === 'continue'
          ? 'continue'
          : 'gate',
  };
}

function describeLeaf(
  step: Step,
  agents: StepAgents | undefined,
): NonNullable<AutomationView['steps']>[number] {
  if (step.kind === 'gate') {
    return {
      id: step.id,
      kind: step.kind,
      ...(step.if !== undefined ? { if: step.if } : {}),
      summary: step.ask,
      ask: step.ask,
      ...(step.choices ? { choices: [...step.choices] } : {}),
    };
  }
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
    ...(step.kind === 'run' && step.dryRun === 'run' ? { dryRun: true as const } : {}),
    summary:
      step.kind === 'run'
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
