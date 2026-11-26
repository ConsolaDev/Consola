/**
 * `agents/<name>.md`: what an agent file says, its refusals and its hash.
 *
 * An agent file is a requirement list every driver compiles (which harness,
 * which model, which servers and skills), not a file handed to one CLI: its
 * frontmatter is this schema, never a CLI's own subagent format. Its body is
 * the agent's standing instructions, written by the person, part of the
 * approved version.
 */
import { sha256Hex } from './sha256';
import { readFrontmatter, splitFrontmatter } from './frontmatter';
import type { FactorySpecIssue } from './issues';
import { stableStringify } from './run';
import { AUTOMATION_NAME_PATTERN } from './schema';
import { AGENT_SECRETS_REASON } from './secrets';
import { MAX_TURNS_LIMIT } from './steps';
import { hasTemplateBraces } from './template';

/** A harness's id: `apps/desktop/src/shared/harness.ts`' pattern, copied (this package imports nothing from apps/). */
export const HARNESS_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** A server's own, unprefixed tool name. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_AGENT_SERVERS = 20;
export const MAX_AGENT_SKILLS = 20;
export const MAX_AGENT_BODY_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 200;
/**
 * A model selector as one argument after `--model`: no whitespace or control
 * characters, and not starting with `-`, which a CLI would read as a flag.
 */
const MODEL_PATTERN = /^(?!-)[^\s\p{Cc}]{1,200}$/u;

export interface AgentServer {
  name: string;
  /** The tools it is narrowed to; absent, every tool the server has. */
  tools?: string[];
}

export interface ParsedAgent {
  name: string;
  description?: string;
  harness?: string;
  model?: string;
  /**
   * What it may change (slice 3-B): `read-only` reads and calls its servers;
   * `edit` also changes files in its run's checkout, with no shell; `write`
   * also runs commands there. Absent in the file: `read-only`.
   */
  tools: AgentTools;
  /** `environments/<name>`'s name: where a write agent works. Present only on an `edit` or `write` agent. */
  environment?: string;
  mcpServers: AgentServer[];
  skills: string[];
  maxTurns?: number;
  /** The text after the frontmatter, exactly as written. */
  body: string;
  /** 1-based file lines of the keys a later check points at. */
  lines: Partial<
    Record<'harness' | 'model' | 'tools' | 'environment' | 'mcpServers' | 'skills', number>
  >;
}

/** An agent file's `tools:`. */
export type AgentTools = 'read-only' | 'edit' | 'write';
const AGENT_TOOLS: ReadonlySet<AgentTools> = new Set<AgentTools>(['read-only', 'edit', 'write']);

export interface AgentDefinition extends ParsedAgent {
  /** `agentHash` of it, with the hashes of the skills it names. */
  hash: string;
}

const AGENT_KEYS = new Set([
  'description',
  'harness',
  'model',
  'tools',
  'environment',
  'mcpServers',
  'skills',
  'max_turns',
]);
const COMPILED =
  "Consola compiles an agent's permissions from `tools`, `mcpServers` and `skills`; it takes no others.";
const REFUSED_AGENT_KEYS: Readonly<Record<string, string>> = {
  secrets: AGENT_SECRETS_REASON,
  hooks: COMPILED,
  permissionMode: COMPILED,
  'allowed-tools': COMPILED,
  allowedTools: COMPILED,
  name: "The file's name is the agent's name: remove `name:`, or rename the file.",
};

const MESSAGES = {
  tools: '`tools:` is `read-only`, `edit` or `write`.',
  needsEnvironment:
    'A write agent must name its environment (invariant 9); add `environment: <name>`.',
  readOnlyEnvironment:
    'A read-only agent has no shell, so an environment would contain nothing; remove it.',
  environment:
    'Expected `environment` to be the name of a file in environments/, without `.yaml`: lowercase letters, digits and dashes, e.g. `environment: sandboxed`.',
  description: `Expected \`description\` to be one line of at most ${MAX_DESCRIPTION_CHARS} characters.`,
  harness:
    "Expected `harness` to be a harness's id, as Settings › Harnesses shows it: letters, digits, `_` and `-`.",
  model:
    "Expected `model` to be a model the harness's CLI takes, e.g. `opus`, `haiku` or a full model id.",
  servers:
    'Expected `mcpServers` to be a list of server names, each optionally narrowed to its tools: `- notion` or `- grafana: [query_logs]`.',
  tooManyServers: `An agent names at most ${MAX_AGENT_SERVERS} servers.`,
  toolName:
    "A tool name is the server's own: letters, digits, `_`, `.` and `-`, at most 64 characters.",
  skills: 'Expected `skills` to be a list of folder names in skills/, e.g. `[incident-triage]`.',
  tooManySkills: `An agent names at most ${MAX_AGENT_SKILLS} skills.`,
  maxTurns: `Expected \`max_turns\` to be a whole number from 1 to ${MAX_TURNS_LIMIT}.`,
  needsHarness:
    'An agent that names servers or skills names its harness too: add `harness: <id>`, the harness whose CLI has them.',
  unclosed: "An agent file's frontmatter ends with a line of `---`.",
  notAMapping: 'The frontmatter is a mapping of keys, e.g. `model: opus`.',
  braces:
    "An agent's instructions are the same for every step that uses it: put item values in the step's `prompt:`.",
  emptyBody:
    'An agent file needs its instructions after the frontmatter: at least one line that is not blank.',
  bigBody: "An agent's instructions are at most 64 KB.",
} as const;

const listedTwice = (name: string) => `\`${name}\` is listed twice.`;
/** Letters, numbers, punctuation, symbols and the plain space: what shows as itself on one line. */
const VISIBLE_TEXT = /^[\p{L}\p{N}\p{P}\p{S} ]*$/u;
/** Letters and a symbol that show nothing: the Hangul fillers, the halfwidth one, the blank Braille pattern. */
const INVISIBLE_FILLER = /[\u115F\u1160\u3164\uFFA0\u2800]/u;

/**
 * Text an agent file shows on a card (its description, a server's name, its
 * model) is visible text, compared NFC: anything else can make it read as
 * other text, or break a line Consola shows, and from slice 6 these can be
 * other people's (a name that looks like `notion` could be another server).
 * An allow-list, so what it refuses is everything else: format characters
 * (bidi overrides, zero-width spaces and joiners), line and paragraph
 * separators, combining marks left over once composed and variation
 * selectors, spaces other than the plain one, and the invisible fillers.
 */
const isVisibleText = (text: string): boolean =>
  VISIBLE_TEXT.test(text) && !INVISIBLE_FILLER.test(text);
const visibleTextOnly = (what: string) =>
  `${what} is visible text: letters, numbers, punctuation, symbols and plain spaces, with no line or paragraph separators, combining marks, invisible fillers or format characters, which make text read as something else.`;
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A server's name as its CLI reports it (`notion`, `claude.ai Coralogix`),
 * already NFC: text on one line, no surrounding space. Visible text only is
 * checked apart, with its own words (`isVisibleText`).
 */
const isServerName = (name: unknown): name is string =>
  typeof name === 'string' && name !== '' && name.trim() === name && !/\p{Cc}/u.test(name);
const nfc = (value: unknown): unknown =>
  typeof value === 'string' ? value.normalize('NFC') : value;

/** The servers, or why they are refused. */
function readServers(value: unknown): AgentServer[] | string {
  if (!Array.isArray(value)) return MESSAGES.servers;
  if (value.length > MAX_AGENT_SERVERS) return MESSAGES.tooManyServers;
  const servers: AgentServer[] = [];
  for (const item of value as unknown[]) {
    // NFC before any check, comparison or hash: two spellings of one name are one name.
    const raw = isRecord(item) && Object.keys(item).length === 1 ? Object.keys(item)[0] : item;
    const given = nfc(raw);
    if (isServerName(given) && !isVisibleText(given)) return visibleTextOnly('A server name');
    let server: AgentServer;
    if (typeof item === 'string' && isServerName(given)) server = { name: given };
    else if (isRecord(item) && Object.keys(item).length === 1) {
      const [key] = Object.keys(item);
      const name = key.normalize('NFC');
      const listed = item[key];
      if (!isServerName(name) || !Array.isArray(listed) || listed.length === 0) {
        return MESSAGES.servers;
      }
      const tools: string[] = [];
      for (const tool of listed) {
        if (typeof tool !== 'string' || !TOOL_NAME_PATTERN.test(tool)) return MESSAGES.toolName;
        if (tools.includes(tool)) return listedTwice(tool);
        tools.push(tool);
      }
      server = { name, tools };
    } else return MESSAGES.servers;
    if (servers.some((earlier) => earlier.name === server.name)) return listedTwice(server.name);
    servers.push(server);
  }
  return servers;
}

/** The skills' folder names, or why they are refused. */
function readSkills(value: unknown): string[] | string {
  if (!Array.isArray(value)) return MESSAGES.skills;
  if (value.length > MAX_AGENT_SKILLS) return MESSAGES.tooManySkills;
  const skills: string[] = [];
  for (const name of value) {
    if (typeof name !== 'string' || !AUTOMATION_NAME_PATTERN.test(name)) return MESSAGES.skills;
    if (skills.includes(name)) return listedTwice(name);
    skills.push(name);
  }
  return skills;
}

/**
 * Validate one agent file. `fileName` is its name without `.md`, which is the
 * agent's name. A file whose first line is not `---` is all body, every key at
 * its default. `agent` is present only when there are no issues; every issue
 * has `file` (`agents/<fileName>.md`), `path` (the key, or `''` for the body
 * or the file) and a `line`. Each key reports at most one problem.
 */
export function parseAgentFile(
  fileName: string,
  text: string,
): { agent?: ParsedAgent; issues: FactorySpecIssue[] } {
  const file = `agents/${fileName}.md`;
  if (!AUTOMATION_NAME_PATTERN.test(fileName)) {
    return {
      issues: [
        {
          file,
          path: '',
          line: 1,
          message: `\`${file}\`: an agent's file name is its name: lowercase letters, digits and dashes, e.g. agents/investigator.md.`,
        },
      ],
    };
  }
  const issues: FactorySpecIssue[] = [];
  const issue = (message: string, path: string, line: number) =>
    issues.push({ file, path, line, message });

  const split = splitFrontmatter(text);
  if (split.kind === 'unclosed') {
    issue(MESSAGES.unclosed, '', 1);
    return { issues };
  }

  let front: Record<string, unknown> = {};
  let lineOf: (key: string) => number = () => 1;
  if (split.kind === 'ok') {
    const read = readFrontmatter(split.yaml, split.firstLine);
    if (!read.ok) {
      for (const error of read.errors) issue(error.message, '', error.line);
    } else if (read.value !== null && read.value !== undefined && !isRecord(read.value)) {
      issue(MESSAGES.notAMapping, '', split.firstLine);
    } else {
      front = read.value ?? {};
      lineOf = (key) => read.lineOf(key) ?? split.firstLine;
    }
  }
  const has = (key: string) => own(front, key);

  for (const key of Object.keys(front)) {
    if (own(REFUSED_AGENT_KEYS, key)) issue(REFUSED_AGENT_KEYS[key], key, lineOf(key));
    else if (!AGENT_KEYS.has(key)) {
      issue(`Unrecognized key in an agent file: \`${key}\`.`, key, lineOf(key));
    }
  }

  let tools: AgentTools = 'read-only';
  if (has('tools')) {
    if (AGENT_TOOLS.has(front.tools as AgentTools)) tools = front.tools as AgentTools;
    else issue(MESSAGES.tools, 'tools', lineOf('tools'));
  }

  // A write agent says where it works (invariant 9); a read-only one has no shell to contain.
  let environment: string | undefined;
  if (has('environment')) {
    if (typeof front.environment !== 'string' || !AUTOMATION_NAME_PATTERN.test(front.environment)) {
      issue(MESSAGES.environment, 'environment', lineOf('environment'));
    } else if (tools === 'read-only' && (!has('tools') || front.tools === 'read-only')) {
      issue(MESSAGES.readOnlyEnvironment, 'environment', lineOf('environment'));
    } else environment = front.environment;
  } else if (tools !== 'read-only') issue(MESSAGES.needsEnvironment, 'tools', lineOf('tools'));

  let description: string | undefined;
  if (has('description')) {
    const given = nfc(front.description);
    if (
      typeof given === 'string' &&
      given.trim() !== '' &&
      !/[\r\n]/.test(given) &&
      !isVisibleText(given)
    ) {
      issue(visibleTextOnly('`description`'), 'description', lineOf('description'));
    } else if (
      typeof given === 'string' &&
      given.trim() !== '' &&
      !/[\r\n]/.test(given) &&
      Array.from(given).length <= MAX_DESCRIPTION_CHARS
    ) {
      description = given;
    } else issue(MESSAGES.description, 'description', lineOf('description'));
  }

  let harness: string | undefined;
  if (has('harness')) {
    if (typeof front.harness === 'string' && HARNESS_ID_PATTERN.test(front.harness)) {
      harness = front.harness;
    } else issue(MESSAGES.harness, 'harness', lineOf('harness'));
  }

  let model: string | undefined;
  if (has('model')) {
    if (typeof front.model !== 'string' || !MODEL_PATTERN.test(front.model)) {
      issue(MESSAGES.model, 'model', lineOf('model'));
    } else if (!isVisibleText(front.model)) {
      issue(visibleTextOnly('`model`'), 'model', lineOf('model'));
    } else model = front.model;
  }

  let mcpServers: AgentServer[] = [];
  if (has('mcpServers')) {
    const read = readServers(front.mcpServers);
    if (typeof read === 'string') issue(read, 'mcpServers', lineOf('mcpServers'));
    else mcpServers = read;
  }

  let skills: string[] = [];
  if (has('skills')) {
    const read = readSkills(front.skills);
    if (typeof read === 'string') issue(read, 'skills', lineOf('skills'));
    else skills = read;
  }

  // Server names resolve in one harness's CLI, and its id is in the version, so an accepted
  // version cannot move to another profile when the workspace's default changes.
  if (!has('harness') && (mcpServers.length > 0 || skills.length > 0)) {
    const key = mcpServers.length > 0 ? 'mcpServers' : 'skills';
    issue(MESSAGES.needsHarness, key, lineOf(key));
  }

  let maxTurns: number | undefined;
  if (has('max_turns')) {
    const given = front.max_turns;
    if (
      typeof given === 'number' &&
      Number.isInteger(given) &&
      given >= 1 &&
      given <= MAX_TURNS_LIMIT
    ) {
      maxTurns = given;
    } else issue(MESSAGES.maxTurns, 'max_turns', lineOf('max_turns'));
  }

  const body = split.body;
  const bodyLine = split.kind === 'ok' ? split.bodyLine : 1;
  if (!/\S/.test(body)) issue(MESSAGES.emptyBody, '', bodyLine);
  if (new TextEncoder().encode(body).length > MAX_AGENT_BODY_BYTES) {
    issue(MESSAGES.bigBody, '', bodyLine);
  }
  if (hasTemplateBraces(body)) issue(MESSAGES.braces, '', bodyLine);

  if (issues.length > 0) return { issues };
  const lines: ParsedAgent['lines'] = {};
  for (const key of ['harness', 'model', 'mcpServers', 'skills'] as const) {
    if (has(key)) lines[key] = lineOf(key);
  }
  // Only a write agent's: a read-only agent parses to what it did before write agents (contract 14).
  if (tools !== 'read-only') {
    lines.tools = lineOf('tools');
    lines.environment = lineOf('environment');
  }
  return {
    agent: {
      name: fileName,
      ...(description !== undefined ? { description } : {}),
      ...(harness !== undefined ? { harness } : {}),
      ...(model !== undefined ? { model } : {}),
      tools,
      ...(environment !== undefined ? { environment } : {}),
      mcpServers,
      skills,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      body,
      lines,
    },
    issues,
  };
}

/**
 * `sha256(stableStringify({ frontmatter, body, skills }))`, full hex: the
 * frontmatter as parsed and normalised (each absent key absent, `tools`
 * `read-only` when not written), the body exactly, and the hash of every skill the agent
 * names. So one byte in the body, a key, a server or its narrowing, or a named
 * skill's file changes it; a skill it does not name does not. A later parser
 * of this format must add nothing to the normalised frontmatter, or every
 * entry that uses an agent asks again.
 */
export function agentHash(
  agent: ParsedAgent,
  skillHashes: Readonly<Record<string, string>>,
): string {
  const skills: Record<string, string> = {};
  for (const name of agent.skills) {
    if (own(skillHashes, name)) skills[name] = skillHashes[name];
  }
  const canonical = stableStringify({
    frontmatter: {
      description: agent.description,
      harness: agent.harness,
      model: agent.model,
      tools: agent.tools,
      // Absent on a read-only agent, so its hash is what it was before write agents (slice 3-B).
      environment: agent.environment,
      mcpServers: agent.mcpServers,
      skills: agent.skills,
      max_turns: agent.maxTurns,
    },
    body: agent.body,
    skills,
  });
  return sha256Hex(canonical);
}
