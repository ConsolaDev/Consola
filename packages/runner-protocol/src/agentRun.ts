import { isId, isRecord, read, refused } from './read.js';
import type { ReadResult } from './read.js';

/** Where a runner writes an agent run's factory files in its sandbox. */
export const AGENT_RUN_FACTORY_DIR = '/workspace/factory';
/**
 * Where a session's repository is cloned in its sandbox (the start script's folder), and the folder
 * it works in: left empty for a session with no repository.
 */
export const SESSION_REPOSITORY_DIR = '/workspace/repo';

/** The most characters an agent run's `prompt`, or an agent's `instructions`, may hold. */
export const AGENT_RUN_PROMPT_MAX = 262_144;
/** The most characters an agent run's files may hold together (their `content`). */
export const AGENT_RUN_FILES_MAX_BYTES = 1_048_576;
/** The most characters a report's `summary`, or a dispatched agent's, may hold. */
export const AGENT_RUN_SUMMARY_MAX = 16_000;

const DESCRIPTION_MAX = 1000;
const AGENTS_MAX = 16;
const FILES_MAX = 128;
const FILE_PATH_MAX = 300;
const DISPATCHED_MAX = 32;

/** An agent the run's orchestrator may dispatch. `instructions` is its whole standing preamble, composed by the cell. */
export type AgentRunAgent = {
  name: string;
  description: string;
  instructions: string;
  model?: string;
};
/** A factory file the runner writes under AGENT_RUN_FACTORY_DIR: a relative path, and its text. */
export type AgentRunFile = { path: string; content: string };
/** The commit to check out instead of the default branch: a ref to fetch, and the commit it must be. */
export type AgentRunCheckout = { ref: string; sha: string };

/** What starts a session as an agent run: nobody types its first message, and nobody approves its commands. */
export type AgentRun = {
  /** The factory agent that takes the first turn (the orchestrator), by name. */
  agent: string;
  /** The first message, whole: the agent's instructions, the automation's prompt and the event. */
  prompt: string;
  model?: string;
  checkout?: AgentRunCheckout;
  agents: AgentRunAgent[];
  files: AgentRunFile[];
};

export const AGENT_RUN_STATES = ['working', 'waiting', 'done', 'failed'] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];
export const DISPATCHED_AGENT_STATUSES = ['working', 'done', 'failed'] as const;
export type DispatchedAgentStatus = (typeof DISPATCHED_AGENT_STATUSES)[number];
/** One agent the orchestrator dispatched: `id` names its conversation, `agent` its factory name. */
export type DispatchedAgent = {
  id: string;
  agent: string;
  status: DispatchedAgentStatus;
  summary?: string;
};
/** What the runner says of an agent run as it changes. `summary` is the orchestrator's last message. */
export type AgentRunReport = {
  state: AgentRunState;
  summary?: string;
  agents?: DispatchedAgent[];
};

const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CHECKOUT_REF = /^refs\/(pull\/[1-9][0-9]{0,9}\/head|heads\/[A-Za-z0-9._/-]{1,200})$/;
const SHA = /^[0-9a-f]{40}$/;

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

const isAgentName = (value: unknown): value is string =>
  typeof value === 'string' && AGENT_NAME.test(value);

const isModel = (value: unknown): value is string => typeof value === 'string' && MODEL.test(value);

/** Text with something in it, up to `max` characters. */
const isText = (value: unknown, max: number): value is string => isId(value) && value.length <= max;

/** Text that may be empty, up to `max` characters. */
const isTextUpTo = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

/** The first field of `record` that `fields` does not name, if any. */
const unnamedField = (record: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(record).find((key) => !fields.includes(key));

/** Each item of a list, read in turn: the first refusal, named by `what` and the item's place. */
function readEach<T>(
  items: unknown[],
  what: string,
  readItem: (item: unknown) => ReadResult<T>,
): ReadResult<T[]> {
  const values: T[] = [];
  for (const [index, item] of items.entries()) {
    const each = readItem(item);
    if (!each.ok) return refused(`\`${what}[${index}]\`: ${each.reason}`);
    values.push(each.value);
  }
  return read(values);
}

function isControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A relative path: segments joined by `/`, none empty, `.` or `..`, no backslash or control. */
function isRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > FILE_PATH_MAX) {
    return false;
  }
  if (value.includes('\\') || isControl(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isCheckoutRef(value: unknown): value is string {
  return typeof value === 'string' && CHECKOUT_REF.test(value) && !value.split('/').includes('..');
}

const AGENT_FIELDS = ['name', 'description', 'instructions', 'model'] as const;

function readAgent(value: unknown): ReadResult<AgentRunAgent> {
  if (!isRecord(value)) return refused('the agent is not an object');
  const extra = unnamedField(value, AGENT_FIELDS);
  if (extra !== undefined) {
    return refused(`the agent has \`${extra}\`, which the protocol does not name`);
  }
  const { name, description, instructions, model } = value;
  if (!isAgentName(name)) return refused("`name` is not an agent's name");
  if (!isTextUpTo(description, DESCRIPTION_MAX)) {
    return refused(`\`description\` is not text of at most ${DESCRIPTION_MAX} characters`);
  }
  if (!isText(instructions, AGENT_RUN_PROMPT_MAX)) {
    return refused(`\`instructions\` is not text of 1 to ${AGENT_RUN_PROMPT_MAX} characters`);
  }
  const agent: AgentRunAgent = { name, description, instructions };
  if (model !== undefined) {
    if (!isModel(model)) return refused("`model` is not a model's name");
    agent.model = model;
  }
  return read(agent);
}

const FILE_FIELDS = ['path', 'content'] as const;

function readFile(value: unknown): ReadResult<AgentRunFile> {
  if (!isRecord(value)) return refused('the file is not an object');
  const extra = unnamedField(value, FILE_FIELDS);
  if (extra !== undefined) {
    return refused(`the file has \`${extra}\`, which the protocol does not name`);
  }
  const { path, content } = value;
  if (!isRelativePath(path)) return refused('`path` is not a relative path');
  if (typeof content !== 'string') return refused('`content` is not text');
  return read({ path, content });
}

const CHECKOUT_FIELDS = ['ref', 'sha'] as const;

function readCheckout(value: unknown): ReadResult<AgentRunCheckout> {
  if (!isRecord(value)) return refused('`checkout` is not an object');
  const missing = CHECKOUT_FIELDS.find((field) => !Object.hasOwn(value, field));
  if (missing !== undefined) return refused(`\`checkout\` has no \`${missing}\``);
  const extra = unnamedField(value, CHECKOUT_FIELDS);
  if (extra !== undefined) {
    return refused(`\`checkout\` has \`${extra}\`, which the protocol does not name`);
  }
  const { ref, sha } = value;
  if (!isCheckoutRef(ref)) return refused('`checkout.ref` is not a pull request or branch ref');
  if (typeof sha !== 'string' || !SHA.test(sha)) return refused('`checkout.sha` is not a commit');
  return read({ ref, sha });
}

const RUN_FIELDS = ['agent', 'prompt', 'model', 'checkout', 'agents', 'files'] as const;
const RUN_REQUIRED = ['agent', 'prompt', 'agents', 'files'] as const;

/**
 * Reads what starts a session as an agent run. It refuses a field the protocol does not name, and
 * a reason names the field, never what it held.
 */
export function readAgentRun(value: unknown): ReadResult<AgentRun> {
  if (!isRecord(value)) return refused('the agent run is not an object');
  const missing = RUN_REQUIRED.find((field) => !Object.hasOwn(value, field));
  if (missing !== undefined) return refused(`the agent run has no \`${missing}\``);
  const extra = unnamedField(value, RUN_FIELDS);
  if (extra !== undefined) {
    return refused(`the agent run has \`${extra}\`, which the protocol does not name`);
  }
  const { agent, prompt, model, checkout } = value;
  if (!isAgentName(agent)) return refused("`agent` is not an agent's name");
  if (!isText(prompt, AGENT_RUN_PROMPT_MAX)) {
    return refused(`\`prompt\` is not text of 1 to ${AGENT_RUN_PROMPT_MAX} characters`);
  }

  if (!Array.isArray(value.agents)) return refused('`agents` is not a list');
  if (value.agents.length > AGENTS_MAX) return refused(`\`agents\` holds more than ${AGENTS_MAX}`);
  const agents = readEach(value.agents, 'agents', readAgent);
  if (!agents.ok) return agents;
  const names = new Set(agents.value.map((each) => each.name));
  if (names.size !== agents.value.length) return refused('`agents` names an agent twice');

  if (!Array.isArray(value.files)) return refused('`files` is not a list');
  if (value.files.length > FILES_MAX) return refused(`\`files\` holds more than ${FILES_MAX}`);
  const files = readEach(value.files, 'files', readFile);
  if (!files.ok) return files;
  const paths = new Set(files.value.map((each) => each.path));
  if (paths.size !== files.value.length) return refused('`files` names a path twice');
  const size = files.value.reduce((total, each) => total + each.content.length, 0);
  if (size > AGENT_RUN_FILES_MAX_BYTES) {
    return refused(`\`files\` hold more than ${AGENT_RUN_FILES_MAX_BYTES} characters together`);
  }

  const run: AgentRun = { agent, prompt, agents: agents.value, files: files.value };
  if (model !== undefined) {
    if (!isModel(model)) return refused("`model` is not a model's name");
    run.model = model;
  }
  if (checkout !== undefined) {
    const checked = readCheckout(checkout);
    if (!checked.ok) return checked;
    run.checkout = checked.value;
  }
  return read(run);
}

const DISPATCHED_FIELDS = ['id', 'agent', 'status', 'summary'] as const;

function readDispatched(value: unknown): ReadResult<DispatchedAgent> {
  if (!isRecord(value)) return refused('the agent is not an object');
  const extra = unnamedField(value, DISPATCHED_FIELDS);
  if (extra !== undefined) {
    return refused(`the agent has \`${extra}\`, which the protocol does not name`);
  }
  const { id, agent, status, summary } = value;
  if (!isId(id)) return refused("`id` is not a conversation's id");
  if (!isAgentName(agent)) return refused("`agent` is not an agent's name");
  if (!isOneOf(DISPATCHED_AGENT_STATUSES, status)) {
    return refused("`status` is not a dispatched agent's status");
  }
  const dispatched: DispatchedAgent = { id, agent, status };
  if (summary !== undefined) {
    if (!isTextUpTo(summary, AGENT_RUN_SUMMARY_MAX)) {
      return refused(`\`summary\` is not text of at most ${AGENT_RUN_SUMMARY_MAX} characters`);
    }
    dispatched.summary = summary;
  }
  return read(dispatched);
}

const REPORT_FIELDS = ['state', 'summary', 'agents'] as const;

/** Reads what a runner says of an agent run, as strictly as `readAgentRun`. */
export function readAgentRunReport(value: unknown): ReadResult<AgentRunReport> {
  if (!isRecord(value)) return refused('the report is not an object');
  const extra = unnamedField(value, REPORT_FIELDS);
  if (extra !== undefined) {
    return refused(`the report has \`${extra}\`, which the protocol does not name`);
  }
  const { state, summary, agents } = value;
  if (!isOneOf(AGENT_RUN_STATES, state)) return refused("`state` is not an agent run's state");
  const report: AgentRunReport = { state };
  if (summary !== undefined) {
    if (!isTextUpTo(summary, AGENT_RUN_SUMMARY_MAX)) {
      return refused(`\`summary\` is not text of at most ${AGENT_RUN_SUMMARY_MAX} characters`);
    }
    report.summary = summary;
  }
  if (agents !== undefined) {
    if (!Array.isArray(agents)) return refused('`agents` is not a list');
    if (agents.length > DISPATCHED_MAX) {
      return refused(`\`agents\` holds more than ${DISPATCHED_MAX}`);
    }
    const dispatched = readEach(agents, 'agents', readDispatched);
    if (!dispatched.ok) return dispatched;
    report.agents = dispatched.value;
  }
  return read(report);
}
