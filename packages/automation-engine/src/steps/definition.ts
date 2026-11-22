import type { AgentDefinition, Step, StepRun, StepsAutomation } from '@consola/factory-spec';
import type { CheckoutKind } from '../ports';

/**
 * What a step's agent requires, as its run's definition keeps it: the agent
 * file as it was approved, so a retry or a restart runs that agent and no
 * later edit of it. Requirements, not grants: what a server lets the step
 * call is the host's to compile when it launches.
 */
export interface AgentRequirements {
  name: string;
  /** `agentHash`: what the entry's version covers of it. */
  hash: string;
  /** The file's `description:`: what the approval card shows beside the body. */
  description?: string;
  /** The file's `harness:`; absent, the workspace's default, read at launch. */
  harnessId?: string;
  model?: string;
  /** Its turns' cap; a step's own `max_turns` beats it (`stepCap`). */
  maxTurns?: number;
  /** Its instructions, exactly as written. */
  body: string;
  /**
   * As the file names them, each narrowed to `tools` when it is. A whole
   * server's `knownTools`: its tools as its harness's CLI listed them when
   * the entry resolved (`withKnownTools`), what the approval card names;
   * absent when unknown, and never part of what the launch asks for.
   */
  mcpServers: Array<{ name: string; tools?: string[]; knownTools?: string[] }>;
  skills: string[];
}

/** An agent file's requirements: its `harness:` as `harnessId`, the rest as written, each absent key absent. */
export function agentRequirements(agent: AgentDefinition): AgentRequirements {
  return {
    name: agent.name,
    hash: agent.hash,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    ...(agent.harness !== undefined ? { harnessId: agent.harness } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
    body: agent.body,
    mcpServers: agent.mcpServers.map((server) => ({
      name: server.name,
      ...(server.tools !== undefined ? { tools: [...server.tools] } : {}),
    })),
    skills: [...agent.skills],
  };
}

/**
 * The agent's requirements with each whole server's `knownTools`, from the
 * host's answer the entry resolved against (`AgentHarnessAnswer.knownTools`).
 * A narrowed server is shown by its own tools and gains none; a server the
 * answer lists no tools for gains no key.
 */
export function withKnownTools(
  agent: AgentRequirements,
  known: Readonly<Record<string, readonly string[]>> | undefined,
): AgentRequirements {
  if (known === undefined) return agent;
  return {
    ...agent,
    mcpServers: agent.mcpServers.map((server) => {
      if (server.tools !== undefined || !Object.prototype.hasOwnProperty.call(known, server.name))
        return server;
      return { ...server, knownTools: [...known[server.name]] };
    }),
  };
}

/** What a steps run executes: the entry as it was approved, with every action a step names. */
export interface RunDefinition {
  automation: StepsAutomation;
  version: string;
  /**
   * By step id. `appliesTo` is kept only when the run's items may be of a
   * type the action does not apply to (a poll's with `item:`, whose check
   * says which only when it runs): a step on one of those fails.
   */
  actions: Record<
    string,
    { name: string; body: string; groupId?: string; appliesTo?: Array<'pr' | 'issue'> }
  >;
  /** By step id, each step that names an agent; absent when no step does. */
  agents?: Record<string, AgentRequirements>;
  /**
   * The entry's checkout kind as it fired (`entryCheckoutKind`): one witness
   * of the run's (`runCheckoutKind`). Absent in a definition written before 2-C.
   */
  checkout?: CheckoutKind;
  /** Its runs carry an item, text other people wrote (`entryReadsItems`); absent when not. */
  readsItems?: true;
  /** `skillHash` by name of every skill a step's agent names, as the run's copy must hold it; absent when none does. */
  skills?: Record<string, string>;
}

/**
 * What a `steps:` run will do, kept on its run as `result`: which steps, and
 * the item or scope it is about. Light, so history's cap never blanks an
 * approval; what each step says is in the run folder's definition.
 */
export interface StepsRunPreview {
  kind: 'steps-run';
  steps: Array<{ id: string; kind: 'agent' | 'run' }>;
  /** The item an event run is about. Title and author are the author's own text. */
  item?: { url: string; title: string; author: string; label: string };
  /** A scheduled run's scope. */
  scope?: string;
  /**
   * The seen record its item fired under (its `definition`), for a run its
   * source fired: when Consola turns the run away because its automation
   * changed, the item is given back to that record only, never to one that
   * re-baselined since (Call 12).
   */
  firedUnder?: string;
}

/** The most one artifact (and a step's `output`) may hold. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;

/** The end of a log, as stored: masked and stripped of escapes when written, so it is passed on untouched. */
export interface LogTail {
  text: string;
  /** The whole file's size. */
  bytes: number;
  /** The tail is shorter than the file. The file's own 1 MB cap is `record.command.truncated` (and `stdoutBytes`/`stderrBytes`). */
  truncated: boolean;
}

/** `command.json`: where a command ran, what it ran, and each `env:` value as its file wrote it and as it rendered. */
export interface CommandFile {
  cwd: string;
  command: string;
  env: Array<{ name: string; template: string; value: string }>;
}

/** One step's latest attempt, as the run folder holds it. Tails are the last 64 KB. */
export interface StepDetail {
  runId: string;
  step: Step;
  /** `previous` lists the earlier attempts. */
  record: StepRun;
  /** An agent step's agent, as its run's definition holds it: its servers and skills among them. */
  agent?: AgentRequirements;
  command?: CommandFile;
  stdout?: LogTail;
  stderr?: LogTail;
}
