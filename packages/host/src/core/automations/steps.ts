import {
  type AgentRequirements,
  agentRequirements,
  agentStepLaunch,
  type CommandOutcome,
  type CommandResult,
  commandOutcome,
  endedWithout,
  type ItemSource,
  lastLineOf,
  MAX_ARTIFACT_BYTES,
  maskSecrets,
  type PreparedCommand,
  prepareCommand,
  type RunDefinition,
  reminderPrompt,
  requiredOf,
  stepCap,
  writableOf,
} from '@consola/automation-engine/core';
import {
  type AgentStep,
  CHECKOUT_CHANGES_REF,
  type CommandStep,
  checkOutputs,
  leafSteps,
  parseReadRef,
  type StepPermissions,
  type StepRun,
} from '@consola/factory-spec';
import type {
  AgentStepRequest,
  AgentStepResult,
  CommandStepRequest,
  CommandStepResult,
  OutputTail,
  StepCheckout,
  StepDocument,
} from '../steps/ports.ts';
import type { RunDocuments } from './documents.ts';
import type { RunState } from './runRecord.ts';

/**
 * A step's work, decided from the run as the ring holds it, and what the work's result makes of
 * the step's record. Pure: each turns the engine's own decisions (`agentStepLaunch`,
 * `prepareCommand`, `commandOutcome`, `checkOutputs`, `endedWithout`) into a port's request, or a
 * port's result into the engine's record, so a cloud step is asked, judged and recorded as a
 * desktop step is. Nothing a port returns is trusted: its outputs are checked again against the
 * step's declaration, its documents against what the step may write, and everything it says is
 * masked of the step's tokens.
 */

/** How long an agent step may run: the file has no key for it, so the ring's default. */
export const AGENT_STEP_TIMEOUT_MS = 30 * 60_000;

/** The document a pull request's agent step reads its changes from, which the steps' sandbox prepares. */
export const CHANGES_DOCUMENT = 'changes';

/** The harness a cloud runner runs agent steps on in stage 1. */
const STAGE_ONE_HARNESS = 'claude';

/** An agent's file asks for what a cloud runner does not grant yet: why, in one sentence, else null. */
export function agentRefusal(agent: {
  readonly name: string;
  readonly tools: string;
  readonly harness?: string | undefined;
  readonly mcpServers: readonly unknown[];
  readonly skills: readonly unknown[];
}): string | null {
  if (agent.tools !== 'read-only') {
    return `Its agent \`${agent.name}\` asks for \`tools: ${agent.tools}\`; a cloud runner runs read-only agents for now.`;
  }
  if (agent.harness !== undefined && agent.harness !== STAGE_ONE_HARNESS) {
    return `Its agent \`${agent.name}\` runs on \`${agent.harness}\`; a cloud runner runs agent steps on claude for now.`;
  }
  if (agent.mcpServers.length > 0) {
    return `Its agent \`${agent.name}\` names MCP servers, which a cloud runner does not grant yet.`;
  }
  if (agent.skills.length > 0) {
    return `Its agent \`${agent.name}\` names skills, which a cloud runner does not grant yet.`;
  }
  return null;
}

/**
 * The run's definition as the engine's launch functions read it: the automation at its factory's
 * version, no actions (a cloud runner has the desktop's settings for none), and each step's
 * agent, as its factory parsed it, that a cloud runner can run.
 */
export function runDefinitionOf(state: RunState): RunDefinition {
  const agents: Record<string, AgentRequirements> = {};
  for (const step of leafSteps(state.automation.steps)) {
    if (step.kind !== 'agent' || step.agent === undefined) continue;
    const agent = state.parsed.agents[step.agent];
    if (agent !== undefined && agentRefusal(agent) === null) {
      agents[step.id] = agentRequirements(agent, state.parsed.environments);
    }
  }
  return {
    automation: state.automation,
    version: String(state.factory.version),
    actions: {},
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
  };
}

type Refused = { readonly ok: false; readonly error: string };
const refused = (error: string): Refused => ({ ok: false, error });

function recordOf(state: RunState, stepId: string): StepRun | undefined {
  return (state.engine.steps ?? []).find((record) => record.id === stepId);
}

/** What the prompt calls a pull request's changes, in place of the step that wrote them. */
function changesLabel(checkout: StepCheckout): string {
  const base = checkout.baseRef === null ? 'its base' : checkout.baseRef;
  return `the files pull request #${checkout.pullRequest} changes, and its diff against ${base}`;
}

/** An agent step's request, but for its clone token, which the ring asks the cell for as it starts. */
export type AgentPlan =
  | { readonly ok: true; readonly request: Omit<AgentStepRequest, 'cloneToken'> }
  | Refused;

export function planAgentStep(input: {
  readonly state: RunState;
  readonly source: ItemSource;
  readonly documents: RunDocuments;
  readonly stepId: string;
  readonly checkout: StepCheckout | null;
}): AgentPlan {
  const { state, source, documents, stepId, checkout } = input;
  const step = leafSteps(state.automation.steps).find((candidate) => candidate.id === stepId);
  const record = recordOf(state, stepId);
  if (step?.kind !== 'agent' || record === undefined) {
    return refused(`Its definition has no agent step ${stepId}.`);
  }
  if (step.action !== undefined) {
    return refused(
      `Its \`action: ${step.action}\` names a prompt the desktop keeps in its settings, which a cloud runner does not have: write the step's \`prompt:\` instead.`,
    );
  }
  const agent = step.agent === undefined ? undefined : state.parsed.agents[step.agent];
  if (step.agent !== undefined && agent === undefined) {
    return refused(`Its agent \`${step.agent}\` is not in its factory.`);
  }
  const refusal = agent === undefined ? null : agentRefusal(agent);
  if (refusal !== null) return refused(refusal);

  const definition = runDefinitionOf(state);
  const launch = agentStepLaunch({
    workspaceId: '',
    run: state.engine,
    definition,
    stepId,
    // Where the session runs is the steps' sandbox's, never a folder of this runner's.
    checkout: { cwd: '', scopeId: '' },
    checkoutKind: 'item',
    source,
    polled: undefined,
    previous: undefined,
    folder: documents.folder,
    prepared:
      checkout !== null && checkout.pullRequest !== null
        ? [{ ref: CHANGES_DOCUMENT, label: changesLabel(checkout) }]
        : [],
    // The step tools are all a cloud step's session serves of Consola's.
    consolaTools: [],
  });
  if (!launch.ok) return launch;

  const readable: StepDocument[] = [];
  for (const entry of step.reads) {
    if (entry === CHECKOUT_CHANGES_REF) continue;
    const ref = parseReadRef(entry);
    // An earlier run's documents (`previous.*`): its prompt says there is no earlier run.
    if (ref === null || ref.previous) continue;
    const producer = recordOf(state, ref.step);
    const content =
      producer === undefined ? null : documents.read(ref.step, producer.attempt, ref.name);
    if (content !== null) readable.push({ name: entry, content });
  }
  const maxTurns = stepCap(definition, stepId);
  return {
    ok: true,
    request: {
      runId: state.engine.id,
      stepId,
      attempt: record.attempt,
      harness: STAGE_ONE_HARNESS,
      model: agent?.model ?? null,
      checkout,
      prompt: launch.request.prompt,
      reminder: (missing) =>
        reminderPrompt({ outputs: [...missing.outputs], artifacts: [...missing.artifacts] }),
      outputs: step.outputs,
      requiredArtifacts: requiredOf(step),
      allowedArtifacts: writableOf(step),
      readable,
      policy: 'read-only',
      maxTurns: maxTurns ?? null,
      timeoutMs: AGENT_STEP_TIMEOUT_MS,
    },
  };
}

/** How a step ends, and what is recorded with it in the same write. */
export type StepEnd =
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly error: string };

/** `tail` masked of every form of the step's tokens. */
function maskedTail(tail: OutputTail, secrets: readonly string[]): OutputTail {
  return {
    stdout: maskSecrets(tail.stdout, secrets),
    stderr: maskSecrets(tail.stderr, secrets),
    truncated: tail.truncated,
  };
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * What an agent step's result makes of its record: its documents and outputs kept when they are
 * the step's to write and hold their types, its turns recorded, and its end: the port's failure,
 * else complete only when nothing it declares is missing (`endedWithout`, the desktop's words).
 */
export function agentOutcome(input: {
  readonly step: AgentStep;
  readonly result: AgentStepResult;
  readonly maxTurns: number | null;
  readonly secrets: readonly string[];
}): {
  readonly end: StepEnd;
  readonly changes: Partial<StepRun>;
  readonly documents: readonly StepDocument[];
  readonly tail: OutputTail | null;
} {
  const { step, result, maxTurns, secrets } = input;
  const mask = (text: string) => maskSecrets(text, secrets);
  const writable = writableOf(step);
  const documents: StepDocument[] = [];
  const problems: string[] = [];
  for (const document of result.artifacts) {
    if (!writable.includes(document.name)) {
      problems.push(`\`${mask(document.name).slice(0, 64)}\` is not a document it writes`);
    } else if (utf8Bytes(document.content) > MAX_ARTIFACT_BYTES) {
      problems.push(`${document.name} is over ${MAX_ARTIFACT_BYTES / 1024} KB`);
    } else if (!documents.some((kept) => kept.name === document.name)) {
      documents.push({ name: document.name, content: mask(document.content) });
    }
  }
  const checked = checkOutputs(step.outputs, result.outputs);
  problems.push(...checked.problems.map(mask));

  const deniedTools = [...new Set(result.deniedTools)];
  const turn: NonNullable<StepRun['turn']> = {
    ...(result.costUsd !== null ? { costUsd: result.costUsd } : {}),
    ...(result.turns !== null ? { turns: result.turns } : {}),
    ...(maxTurns !== null ? { maxTurns } : {}),
    ...(deniedTools.length > 0 ? { deniedTools } : {}),
  };
  const changes: Partial<StepRun> = {
    ...(Object.keys(checked.valid).length > 0 ? { outputs: checked.valid } : {}),
    artifacts: documents.map(({ name, content }) => ({ name, bytes: utf8Bytes(content) })),
    reminded: result.reminded,
    ...(Object.keys(turn).length > 0 ? { turn } : {}),
  };
  const tail = result.output === null ? null : maskedTail(result.output, secrets);

  let end: StepEnd;
  if (result.status === 'failed') {
    end = { status: 'failed', error: mask(result.error ?? 'It failed.') };
  } else if (problems.length > 0) {
    end = { status: 'failed', error: `What it left was refused: ${problems.join('; ')}.` };
  } else {
    const without = endedWithout({
      outputs: Object.keys(step.outputs).filter((name) => !Object.hasOwn(checked.valid, name)),
      artifacts: requiredOf(step).filter((name) => !documents.some((kept) => kept.name === name)),
    });
    end = without === null ? { status: 'completed' } : { status: 'failed', error: without };
  }
  return { end, changes, documents, tail };
}

/** A command step's request, but for its tokens, which the ring asks the cell for as it starts. */
export type CommandPlan =
  | {
      readonly ok: true;
      readonly prepared: PreparedCommand;
      readonly request: Omit<CommandStepRequest, 'cloneToken' | 'secretEnv'>;
      /** What its token may do (`permissions:`); null for a step that names none, which gets no token. */
      readonly permissions: StepPermissions | null;
    }
  | Refused;

/** Consola's variables the steps' sandbox sets itself (`$CONSOLA_OUTPUT`), or that only the desktop has. */
const NOT_PASSED = new Set(['CONSOLA_OUTPUT', 'CONSOLA_ITEM_FILE']);

/**
 * A command step's request: its `env:` rendered by the engine's `prepareCommand` from trusted
 * values (a `{{steps.x.y.file}}` value becoming a file the sandbox holds, `fileEnv` naming its
 * path there), and Consola's variables (`CONSOLA_RUN_ID`, `CONSOLA_STEP`,
 * `CONSOLA_CHECKOUT_HEAD`, the commit the run read).
 */
export function planCommandStep(input: {
  readonly state: RunState;
  readonly source: ItemSource;
  readonly documents: RunDocuments;
  readonly stepId: string;
  readonly checkout: StepCheckout | null;
}): CommandPlan {
  const { state, source, documents, stepId, checkout } = input;
  const step = leafSteps(state.automation.steps).find((candidate) => candidate.id === stepId);
  if (step?.kind !== 'run') return refused(`Its definition has no command step ${stepId}.`);
  if (step.secrets !== undefined && step.secrets.length > 0) {
    return refused(
      `It names secrets (${step.secrets.map((name) => `\`${name}\``).join(', ')}), which a cloud runner does not bind yet.`,
    );
  }
  const prepared = prepareCommand({
    run: state.engine,
    definition: runDefinitionOf(state),
    stepId,
    cwd: '',
    workspaceId: '',
    folder: documents.folder,
    source,
    polled: undefined,
    previous: undefined,
  });
  if (!prepared.ok) return prepared;
  const { command } = prepared;

  const env: Record<string, string> = {};
  const fileEnv: Record<string, string> = {};
  const files: { path: string; content: string }[] = [];
  for (const { name, value } of command.values) {
    const document = documents.documentAt(value);
    if (document !== null) {
      if (!files.some((file) => file.path === value))
        files.push({ path: value, content: document });
      fileEnv[name] = value;
      continue;
    }
    if (documents.pathsInside(value).length > 0) {
      return refused(
        `env: ${name} holds a document's file inside other text; on a cloud runner a \`.file\` value is the whole value.`,
      );
    }
    env[name] = value;
  }
  for (const [name, value] of Object.entries(command.variables)) {
    if (!NOT_PASSED.has(name)) env[name] = value;
  }
  return {
    ok: true,
    prepared: command,
    request: {
      runId: state.engine.id,
      stepId,
      attempt: command.attempt,
      checkout,
      command: step.run,
      env,
      files,
      fileEnv,
      timeoutMs: step.timeoutMs,
    },
    permissions: readPermissions(step),
  };
}

/** The GitHub permissions a command step's token may have, as factory-spec parsed them; null when it names none. */
function readPermissions(step: CommandStep): StepPermissions | null {
  return step.permissions !== undefined && Object.keys(step.permissions).length > 0
    ? step.permissions
    : null;
}

/**
 * What a command step's result makes of its record, by the engine's `commandOutcome`: its
 * `$CONSOLA_OUTPUT` lines read as the desktop reads the file (declared, typed, none missing), its
 * stdout kept as `output` when it declares `stdout:` and the whole of it came back, and a failure
 * said in the desktop's words (`exit 1: <last stderr line>`). A command the sandbox could not run
 * at all fails in the port's sentence.
 */
export function commandOutcomeOf(input: {
  readonly documents: RunDocuments;
  readonly prepared: PreparedCommand;
  readonly record: StepRun;
  readonly result: CommandStepResult;
  readonly secrets: readonly string[];
}): CommandOutcome & { readonly tail: OutputTail } {
  const { documents, prepared, record, result, secrets } = input;
  const tail = maskedTail(result.output, secrets);
  if (result.error !== null) {
    return {
      end: { status: 'failed', error: maskSecrets(result.error, secrets) },
      changes: {},
      tail,
    };
  }
  const lines = Object.entries(result.outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  documents.put(prepared.files.output, lines);
  documents.put(prepared.files.stdout, tail.stdout);
  const stderrCut = result.stderrBytes > utf8Bytes(result.output.stderr);
  const lastStderrLine = lastLineOf(tail.stderr, secrets, stderrCut);
  const commandResult: CommandResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: false,
    stopped: false,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    truncated: result.output.truncated,
    ...(lastStderrLine !== undefined ? { lastStderrLine } : {}),
  };
  const outcome = commandOutcome({
    folder: documents.folder,
    command: prepared,
    record,
    result: commandResult,
    secrets,
  });
  return { ...outcome, tail };
}
