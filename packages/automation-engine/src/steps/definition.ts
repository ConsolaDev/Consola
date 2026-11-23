import type {
  AgentDefinition,
  ArgumentTrust,
  CallArgument,
  EnvironmentDefinition,
  McpServerDefinition,
  Step,
  StepRun,
  StepsAutomation,
} from '@consola/factory-spec';
import type { CheckoutKind } from '../ports';
import type { ServerFacts } from '../servers/serverFacts';
import type { WriteBlocks } from '../views';

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
  /** A write agent's `tools:` (slice 3-B); absent, the agent is read-only. */
  tools?: 'edit' | 'write';
  /** A write agent's environment, as the version covers it; absent on a read-only agent. */
  environment?: RunEnvironment;
}

/** `environments/<name>.yaml` as a run's definition keeps it: what a write agent's launch holds it to. */
export interface RunEnvironment {
  name: string;
  isolation: 'host' | 'sandbox';
  network: string[];
  env: string[];
  /** `environmentHash`: what the entry's version covers of it. */
  hash: string;
}

/** An environment as a run's definition keeps it, each list its own copy. */
export function runEnvironment(environment: EnvironmentDefinition): RunEnvironment {
  return {
    name: environment.name,
    isolation: environment.isolation,
    network: [...environment.network],
    env: [...environment.env],
    hash: environment.hash,
  };
}

/**
 * An agent file's requirements: its `harness:` as `harnessId`, the rest as
 * written, each absent key absent. A write agent also carries its `tools`
 * and the environment it names, from `environments` (slice 3-B); a
 * read-only agent's requirements are what they were before write agents.
 */
export function agentRequirements(
  agent: AgentDefinition,
  environments?: Readonly<Record<string, EnvironmentDefinition>>,
): AgentRequirements {
  const environment =
    agent.environment !== undefined &&
    environments !== undefined &&
    Object.prototype.hasOwnProperty.call(environments, agent.environment)
      ? environments[agent.environment]
      : undefined;
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
    ...(agent.tools !== 'read-only' ? { tools: agent.tools } : {}),
    ...(agent.tools !== 'read-only' && environment
      ? { environment: runEnvironment(environment) }
      : {}),
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

/** A skill's `SKILL.md` as text, from its files; empty when it has none. */
export function skillMarkdown(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): string {
  const file = files.find((entry) => entry.path === 'SKILL.md');
  return file ? new TextDecoder().decode(file.bytes) : '';
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
  /** By name, every factory server a `uses:` step names, as approved; absent when none does. */
  servers?: Record<string, McpServerDefinition>;
  /** By step id, every `uses:` step's call as its card and its detail show it; absent when there is none. */
  calls?: Record<string, CallView>;
}

/** One `uses:` step's call, as the card and the step's detail show it: what it calls, and what each argument carries. */
export interface CallView {
  /** `<server>#<tool>` as written. */
  ref: string;
  server: string;
  tool: string;
  arguments: CallArgument[];
  /** A destructive Consola tool: it acts on what is true when it runs. */
  destructive?: true;
  /** `dry_run: run`. */
  alsoInDryRun?: true;
  /** A factory server's facts for the card; absent for `consola`. */
  facts?: ServerFacts;
}

/**
 * A run's definition as main hands it to the approval card: the snapshot,
 * and its flow lines (`describeFlow`) computed when read, never written to
 * the run folder.
 */
export type RunDefinitionView = RunDefinition & {
  flow: string[];
  /** What its write agents can change, read, reach and run (`describeWrites`, slice 3-B Task 21); absent when nothing writes. */
  writes?: WriteBlocks;
};

/**
 * What a `steps:` run will do, kept on its run as `result`: which steps, and
 * the item or scope it is about. Light, so history's cap never blanks an
 * approval; what each step says is in the run folder's definition.
 */
export interface StepsRunPreview {
  kind: 'steps-run';
  /** Record order: a loop's row (`repeat`), then its steps, each with `loop`, its loop's id. */
  steps: Array<{ id: string; kind: StepRun['kind']; loop?: string }>;
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
  /** The secrets it was given, by name, and where each was bound when it ran: never a value. */
  secrets?: Array<{ name: string; bound?: string }>;
}

/** One argument of a call, as `call.json` keeps it: its name, what the file says, what it rendered to, and its trust. */
export interface RenderedArgument {
  name: string;
  template: unknown;
  value: unknown;
  trust: ArgumentTrust;
}

/** `call.json`: what was (or would have been) sent, every string masked. */
export interface CallFile {
  server: string;
  /** How the tool was reached: "started `…` on this Mac", "called <url>", "Consola's own tool, in process". */
  reached: string;
  tool: string;
  arguments: RenderedArgument[];
  /** A dry run's: what it would have sent. */
  wouldHave?: true;
}

/** `result.json`: what came back, masked; cut at 1 MB. */
export interface CallResultFile {
  isError: boolean;
  bytes: number;
  /** A Consola tool's summary. */
  summary?: string;
  /** What came back, whole when it fits. */
  result?: unknown;
  /** The first 1 MB of its serialised text when it does not. */
  cut?: string;
}

/** One step's latest attempt, as the run folder holds it. Tails are the last 64 KB. */
export interface StepDetail {
  runId: string;
  step: Step;
  /** `previous` lists the earlier attempts. */
  record: StepRun;
  /** An agent step's agent, as its run's definition holds it: its servers and skills among them. */
  agent?: AgentRequirements;
  /**
   * Each skill its agent names, in its order, by its `SKILL.md` as the run's
   * own copy holds it, when that copy is the one its definition records: what
   * the approval card shows the person accepting it (review M4). Absent for
   * an agent with no skills, and when `skillsProblem` says why not.
   */
  skillTexts?: Array<{ name: string; text: string }>;
  /** Why the run's copy of its skills cannot be shown: unreadable, or not the one its definition records. */
  skillsProblem?: string;
  command?: CommandFile;
  stdout?: LogTail;
  stderr?: LogTail;
  /** A call's `call.json`, `result.json` and its server's stderr (`server.log`). */
  call?: CallFile;
  result?: CallResultFile;
  serverLog?: LogTail;
  /**
   * What a write step's failed attempt changed, kept as its `changes.patch`
   * (slice 3-B): the latest attempt's that holds one, its last
   * `MAX_ARTIFACT_BYTES`. Absent when none does.
   */
  changes?: LogTail & { attempt: number };
  /** Its path artifacts (slice 3-B), each path rendered for the run's item, as the run page titles them. Absent when it has none. */
  paths?: Array<{ name: string; path: string }>;
}
