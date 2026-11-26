import { flatSteps, isRunOwnedCheckout, isStepsEntry, leafSteps } from '@consola/factory-spec';
import type {
  AgentDefinition,
  Automation,
  RepeatStep,
  Step,
  StepEntry,
  StepsAutomation,
} from '@consola/factory-spec';
import { clipText } from './steps/commandIO';
import type { AgentRequirements } from './steps/definition';
import type { AutomationView, WriteBlocks } from './views';

/** The most of a command's first line a step's summary shows. */
const COMMAND_SUMMARY_CHARS = 80;

const actionRuns = (name: string) => `${name} action`;

/**
 * What an entry runs, in words: "Review action", "Prompt", "Tool:
 * cleanup_stale_sessions", "Steps: review → publish" (a loop's steps in
 * line, as the run takes them).
 */
export function describeRun(automation: Automation): string {
  if (isStepsEntry(automation)) {
    return `Steps: ${leafSteps(automation.steps)
      .map((step) => step.id)
      .join(' → ')}`;
  }
  const { run } = automation;
  if (run.kind === 'tool') return `Tool: ${run.tool}`;
  return run.kind === 'action' ? actionRuns(run.name) : 'Prompt';
}

/** What a dry run reads of an entry's agents, by name: whether each writes, and where. */
type DryRunAgents = Readonly<
  Record<
    string,
    { tools?: 'read-only' | 'edit' | 'write'; environment?: string | { name: string } }
  >
>;

/** Whether a step's agent writes (`edit` or `write`, slice 3-B): a dry run reports it instead of running it. */
function writes(step: StepEntry, agents: DryRunAgents | undefined): boolean {
  if (step.kind !== 'agent' || step.agent === undefined || agents === undefined) return false;
  const tools = Object.prototype.hasOwnProperty.call(agents, step.agent)
    ? agents[step.agent].tools
    : undefined;
  return tools === 'edit' || tools === 'write';
}

/**
 * Whether a dry run of these steps starts anything: an agent step whose
 * agent is read-only (read-only agents run in a dry run; one that writes is
 * reported, slice 3-B) or a `dry_run: run` command or call, a loop's included.
 * `agents`, by name, says which write; without it none does.
 */
export function dryRunStarts(entries: readonly StepEntry[], agents?: DryRunAgents): boolean {
  return leafSteps(entries).some(
    (step) =>
      (step.kind === 'agent' && !writes(step, agents)) ||
      ((step.kind === 'run' || step.kind === 'uses') && step.dryRun === 'run'),
  );
}

/**
 * What a dry run reports for a step it does not run because its agent
 * writes (slice 3-B): `Would have run <agent> in <environment>`. Null for any
 * other step, which a dry run runs or reports as before.
 */
export function dryRunReports(step: StepEntry, agents: DryRunAgents): string | null {
  if (step.kind !== 'agent' || !writes(step, agents)) return null;
  const { environment } = agents[step.agent!];
  const where = typeof environment === 'string' ? environment : environment?.name;
  return `Would have run ${step.agent} in ${where ?? 'its environment'}`;
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
  if (entryRetry > 0) {
    retryLines.push(
      `The whole run starts again by itself up to ${times(entryRetry)}, only if nothing in it acted${loops.length > 0 ? ', its loops from round 1' : ''}.`,
    );
  }
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
  if (isStepsEntry(automation)) {
    return leafSteps(automation.steps).some((step) => step.kind === 'agent') ? 'agent' : 'tool';
  }
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

/**
 * The steps as `describeSteps` drew them, each write agent's step with the
 * isolation its environment holds it to, from a run definition's agents by
 * step id (slice 3-B Task 22: its node's chip). No agents, no change.
 */
export function withWriteIsolation(
  described: NonNullable<AutomationView['steps']>,
  agents: Readonly<Record<string, AgentRequirements>> | undefined,
): NonNullable<AutomationView['steps']> {
  if (agents === undefined) return described;
  return described.map((step) => {
    const agent = Object.prototype.hasOwnProperty.call(agents, step.id)
      ? agents[step.id]
      : undefined;
    const isolation = agent?.tools !== undefined ? agent.environment?.isolation : undefined;
    return isolation !== undefined ? { ...step, writes: isolation } : step;
  });
}

/**
 * An entry's own checkout as its pipeline's checkout node draws it (slice
 * 3-B Task 22): the repository, and the branch as the card names it.
 * Undefined for an entry without `checkout: { repo, branch }`.
 */
export function describeOwnCheckout(
  automation: StepsAutomation,
): { repo: string; branch: string } | undefined {
  const own = automation.checkout;
  return isRunOwnedCheckout(own) ? { repo: own.repo, branch: branchWords(own.branch) } : undefined;
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

/** What the card's containment sentences rest on (slice 3-B, the canary's verdicts as the host has them). */
export interface WriteVersions {
  /** The Claude version every stop row of the canary passed on (`SANDBOX_CHECKED_ON_CLAUDE`); null when none. */
  checkedOn: string | null;
  /** By agent name, the version of Claude its harness runs here now, when known (its harness's answer, `AgentHarnessAnswer.cliVersion`). */
  running: Readonly<Record<string, string>>;
  /** Canary row 30's outside half: the file tools change only the checkout with the sandbox off (`HOST_EDIT_CHECKED`). */
  hostEditChecked: boolean;
  /** Canary row 44 (or 45): the file tools read only the checkout (`FILE_TOOLS_DENY_CHECKED`, by `--restricted`). */
  fileToolsChecked: boolean;
  /** Canary row 50: the file tools read nothing through a link inside the checkout that leads out of it (`FILE_TOOLS_LINKS_CHECKED`). */
  fileToolLinksChecked: boolean;
}

/** A branch template as the card names it: each placeholder as the part it stands for. */
function branchWords(template: string): string {
  return template
    .replace(/\{\{\s*item\.key\s*\}\}/g, '<ticket>')
    .replace(/\{\{\s*item\.number\s*\}\}/g, '<number>')
    .replace(/\{\{\s*run\.id\s*\}\}/g, '<run>');
}

const joined = (names: readonly string[]) => names.join(', ');

/**
 * What the keychain holds (the 3-B code review's F1): the deny list keeps
 * the shell from credential *files*, but on a Mac Git's osxkeychain helper,
 * `gh` and Claude keep their sign-ins as keychain items, which the shell can
 * ask for (`KEYCHAIN_SENTENCE`).
 */
export const KEYCHAIN_SIGN_INS_SENTENCE =
  'Your keychain is another matter: Git, `gh` and Claude usually keep their sign-ins there.';
/** The keychain, as canary row 49 found it (`KEYCHAIN_SERVICE_BLOCKED = false`): the sandbox does not hold it. */
export const KEYCHAIN_SENTENCE =
  'Its shell can ask macOS for your keychain items through `security` (macOS may or may not ask you first).';
/**
 * Until canary row 50 passes (the 3-B code review's F6): whether the file
 * tools, held to the checkout by `--restricted`, read through a link inside
 * it that leads out of it was never observed. Consola refuses to commit such
 * a link (`node/runCheckout.ts`), so it reaches no later step; the same
 * step's file tools are what this sentence is about.
 */
export const FILE_TOOL_LINKS_HEDGE =
  'Whether its file tools follow a link out of the checkout is not yet checked.';
/** The conductor's ruling on canary row 37: the CLI refuses `.git/config` and `.git/hooks` in every folder its shell writes. */
export const GIT_CLONE_SENTENCE = '`git clone` and `git init` do not work in its shell.';
/** The conductor's ruling on canary row 39: no attention hooks under the sandbox. */
export const NO_LIVE_ATTENTION_SENTENCE =
  'Consola shows no live attention for it while it runs: the sandbox keeps its hooks out.';

/** One write agent's head line: what it is, where it runs, and (sandboxed) on which Claude its sandbox was checked. */
function writeHead(agent: AgentRequirements, versions: WriteVersions): string {
  const environment = agent.environment;
  const harness = agent.harnessId ?? 'default harness';
  const does = agent.tools === 'write' ? 'writes files and runs commands' : 'writes files';
  const bracket =
    agent.tools === 'edit'
      ? 'no shell; its files are confined by --restricted'
      : environment?.isolation === 'sandbox'
        ? 'sandbox, enforced on this Mac'
        : 'host, a convention';
  const head = `${agent.name} · ${harness} · ${agent.model ?? 'default model'} · ${does} · environment ${environment?.name ?? 'none'} (${bracket})`;
  if (agent.tools !== 'write' || environment?.isolation !== 'sandbox') return head;
  if (versions.checkedOn === null) return `${head} · not yet checked on any Claude version`;
  const running = Object.prototype.hasOwnProperty.call(versions.running, agent.name)
    ? versions.running[agent.name]
    : undefined;
  if (running === undefined) {
    return `${head} · checked on Claude ${versions.checkedOn}; this Mac's version is not known`;
  }
  return running === versions.checkedOn
    ? `${head} · checked on Claude ${versions.checkedOn}`
    : `${head} · checked on Claude ${versions.checkedOn}; this Mac runs ${running}`;
}

/**
 * What one write agent can change, read, reach and run, in the containment
 * table's words as the canary left them on its checked version (plan
 * *What sandbox contains*; the canary's rows 30, 31, 34, 36, 37, 39, 44, 46,
 * 49). Every file tool runs under `--restricted`, which keeps it to the
 * checkout for writes and reads alike (rows 30, 31, 44: the CLI names
 * `--restricted` as the reason); the sandbox wraps the shell only, and does
 * not keep it from the keychain service (row 49).
 */
function writeSentences(
  agent: AgentRequirements,
  checkout: { repo: string; branch: string } | undefined,
  versions: WriteVersions,
): string[] {
  const environment = agent.environment;
  const connectors =
    agent.mcpServers.length > 0 ? joined(agent.mcpServers.map((s) => s.name)) : 'none';
  const sandbox = environment?.isolation === 'sandbox';
  // Said only where the file tools were checked at all: otherwise their sentence already says not.
  const linkHedge =
    versions.fileToolsChecked && !versions.fileToolLinksChecked ? [FILE_TOOL_LINKS_HEDGE] : [];
  if (agent.tools === 'write' && !sandbox) {
    return [
      'Has a shell with your logins, your network and your files: it can change anything you can. Blocking `git push` and `gh` is a convention it can go around.',
    ];
  }
  if (agent.tools === 'edit') {
    const changes =
      sandbox || versions.hostEditChecked
        ? "Changes files only in this run's checkout (no shell)."
        : "Changes files in this run's checkout (no shell); that it can change nothing else is not yet checked on host.";
    const reads = !versions.fileToolsChecked
      ? 'What its file tools can read outside the checkout was not checked'
      : sandbox
        ? "Its file tools read only this run's checkout"
        : "Its file tools read only this run's checkout, by the same `--restricted` (seen with the sandbox on)";
    return [
      [
        `${changes} ${reads}, and what it reads can end up in the branch a later step pushes.`,
        ...linkHedge,
        `Its connectors: ${connectors}.`,
      ].join(' '),
    ];
  }
  const where = checkout
    ? `this run's checkout of ${checkout.repo}, on \`${branchWords(checkout.branch)}\``
    : "this run's checkout";
  const network = environment?.network ?? [];
  const reach = network.length > 0 ? `only ${joined(network)}` : 'no network';
  const env = environment?.env ?? [];
  const gets =
    env.length > 0
      ? `Gets ${joined(env)} from your environment and no token Consola holds.`
      : 'Gets nothing from your environment and no token Consola holds.';
  const fileTools = versions.fileToolsChecked
    ? "; its file tools read only this run's checkout"
    : '; its file tools were not checked against that list';
  const sendsTo =
    network.length > 0
      ? 'to the hosts above, to its connectors, or into the branch a later step pushes'
      : 'to its connectors or into the branch a later step pushes';
  return [
    [
      `Can change files only in ${where}, and in the temporary folder all your sandboxed Claude shells share.`,
      `Can reach ${reach} from its shell; its connectors: ${connectors}.`,
      gets,
      // Only what the deny list holds (`denyReadList`): files, never the keychain's items (F1).
      `Its shell cannot read the credential files in your home folder (SSH, cloud, \`gh\`, npm, Git's), your harnesses' profiles, each agent CLI's default profile or Consola's data${fileTools}.`,
      ...linkHedge,
      KEYCHAIN_SIGN_INS_SENTENCE,
      KEYCHAIN_SENTENCE,
      `Its shell can read other files on this Mac, and send them ${sendsTo}.`,
      GIT_CLONE_SENTENCE,
      NO_LIVE_ATTENTION_SENTENCE,
    ].join(' '),
  ];
}

/**
 * What an entry writes, for its approval card (slice 3-B, spec *Isolation,
 * honestly › What the approval card says*; plan Task 21): its own
 * checkout's sentence, a block per write agent (in step order, each once),
 * a line per command that runs after a write step (in record order, a
 * command in a loop with a write step counting from its first round, since
 * a later round runs it after that step), and what passes from the
 * person's environment to its sandboxed agents. `agents` by name. Absent
 * for an entry with no write agent and no checkout of its own.
 */
export function describeWrites(
  automation: StepsAutomation,
  agents: Readonly<Record<string, AgentRequirements>>,
  versions: WriteVersions,
): WriteBlocks | undefined {
  const own = isRunOwnedCheckout(automation.checkout) ? automation.checkout : undefined;
  const writerOf = (step: StepEntry): AgentRequirements | undefined => {
    if (step.kind !== 'agent' || step.agent === undefined) return undefined;
    if (!Object.prototype.hasOwnProperty.call(agents, step.agent)) return undefined;
    const agent = agents[step.agent];
    return agent.tools === 'edit' || agent.tools === 'write' ? agent : undefined;
  };
  const writers: AgentRequirements[] = [];
  for (const step of leafSteps(automation.steps)) {
    const writer = writerOf(step);
    if (writer && !writers.some((known) => known.name === writer.name)) writers.push(writer);
  }
  if (writers.length === 0 && !own) return undefined;

  const commands: string[] = [];
  let lastWriter: string | undefined;
  for (const { step } of flatSteps(automation.steps)) {
    if (step.kind === 'repeat') {
      // A later round runs the loop's every step after its write step.
      const inLoop = step.steps.map(writerOf).filter((agent) => agent !== undefined);
      if (lastWriter === undefined && inLoop.length > 0) lastWriter = inLoop[0].name;
      continue;
    }
    const writer = writerOf(step);
    if (writer) lastWriter = writer.name;
    else if (step.kind === 'run' && lastWriter !== undefined) {
      commands.push(
        `\`${step.id}\` · on host, after ${lastWriter}: runs code an agent changed, as you, with your logins.`,
      );
    }
  }

  const sandboxed = writers.filter(
    (agent) => agent.tools === 'write' && agent.environment?.isolation === 'sandbox',
  );
  const names = [...new Set(sandboxed.flatMap((agent) => agent.environment?.env ?? []))];
  const checkout = own
    ? `Cuts \`${branchWords(own.branch)}\` from ${own.repo}'s ${own.from !== undefined ? `branch \`${own.from}\`` : 'default branch'}, in a checkout of its own. Nothing else is written.`
    : undefined;
  return {
    ...(checkout ? { checkout } : {}),
    agents: writers.map((agent) => ({
      agent: agent.name,
      head: writeHead(agent, versions),
      sentences: writeSentences(agent, own, versions),
    })),
    commands,
    ...(sandboxed.length > 0
      ? {
          variables:
            names.length > 0
              ? `Passes from your environment: ${joined(names)}.`
              : 'Passes nothing from your environment.',
        }
      : {}),
  };
}
