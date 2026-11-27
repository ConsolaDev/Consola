/**
 * Reading a factory's agent team from its files:
 *
 *   agents/<name>/agent.md              frontmatter + the agent's instructions
 *   automations/<name>/automation.md    frontmatter (triggers, target agent) + the starting prompt
 *   skills/<name>/SKILL.md              optional frontmatter + the skill; every other file of
 *                                       skills/<name>/ belongs to it
 *
 * Any other file is not this module's: a factory may also hold the steps design's files
 * (`agents/<name>.md`, `automations/<name>.yaml`, `factory.yml`). The team takes one thing from
 * `factory.yml`, its `repos:`, read as the steps design reads it (`factoryRepositories`), whose
 * problems are the steps design's parser's to report. Pure: no I/O.
 */
import { stringify } from 'yaml';
import { factoryRepositories, isIgnoredFileName } from '../factory';
import { readFrontmatter, splitFrontmatter } from '../frontmatter';
import type {
  AgentTeam,
  AgentType,
  ListFilter,
  TeamAgent,
  TeamAutomation,
  TeamFile,
  TeamIssue,
  TeamSkill,
  TeamTrigger,
  TeamTriggerFilter,
} from './types';

/** An agent's, an automation's or a skill's name: its folder's. */
export const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const AGENT_TYPES: readonly AgentType[] = [
  'CUSTOM',
  'ORCHESTRATOR',
  'TRIAGE',
  'SPEC',
  'IMPLEMENT',
  'REVIEW',
  'VERIFY',
];
const AGENT_KEYS = ['description', 'agentType', 'workerRole', 'model', 'harness', 'spawnableBy'];
const AUTOMATION_KEYS = ['enabled', 'agent', 'worker', 'triggers'];
const TRIGGER_KEYS = ['provider', 'event', 'filter'];
const FILTER_KEYS = ['repos', 'base_branches', 'labels', 'authors', 'skip_bots'];
const LIST_FILTER_KEYS = ['in', 'not_in'];
const SKIP_BOTS = ['all', 'self', 'none'] as const;

const BAD_NAME =
  'is not a name: lowercase letters, digits, `-` and `_`, starting with a letter or a digit, at most 63 characters.';

type Tree = 'agents' | 'automations' | 'skills';
const OWN_FILE: Readonly<Record<Exclude<Tree, 'skills'>, string>> = {
  agents: 'agent.md',
  automations: 'automation.md',
};

/** Where a path sits in the three trees, or undefined when it is not in one. */
function placeOf(path: string): { tree: Tree; name: string; rest: string } | undefined {
  const parts = path.split('/');
  // `agents/<name>.md` and `automations/<name>.yaml` are the steps design's, not a tree's.
  if (parts.length < 3) return undefined;
  const [tree, name, ...rest] = parts;
  if (tree !== 'agents' && tree !== 'automations' && tree !== 'skills') return undefined;
  if (rest.some((part) => part === '') || isIgnoredFileName(rest[rest.length - 1])) {
    return undefined;
  }
  return { tree, name, rest: rest.join('/') };
}

/**
 * True when the set holds an `agents/<name>/agent.md` or an `automations/<name>/automation.md`.
 * A `skills/<name>/` folder alone does not count: the steps design keeps its skills there too.
 */
export function hasAgentTeam(files: readonly TeamFile[]): boolean {
  return files.some((file) => {
    const place = placeOf(file.path);
    return place !== undefined && place.tree !== 'skills' && place.rest === OWN_FILE[place.tree];
  });
}

/**
 * Each parsed agent's own file, so a run's sandbox gets it byte for byte. A team built by hand
 * has none; `agentFileOf` writes one from the agent's fields then.
 */
const agentFiles = new WeakMap<TeamAgent, TeamFile>();

export function agentFileOf(agent: TeamAgent): TeamFile {
  const kept = agentFiles.get(agent);
  if (kept) return kept;
  const front: Record<string, unknown> = {
    description: agent.description,
    agentType: agent.agentType,
  };
  if (agent.model !== undefined) front.model = agent.model;
  if (agent.harness !== undefined) front.harness = agent.harness;
  if (agent.spawnableBy !== undefined) front.spawnableBy = agent.spawnableBy;
  return {
    path: `agents/${agent.name}/agent.md`,
    content: `---\n${stringify(front)}---\n${agent.instructions}\n`,
  };
}

type Frontmatter = { data: Record<string, unknown>; body: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const has = (data: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(data, key);

/** A file's frontmatter as a mapping and its body, or undefined after recording why not. */
function readParts(file: TeamFile, problem: (message: string) => void): Frontmatter | undefined {
  const split = splitFrontmatter(file.content);
  if (split.kind === 'unclosed') {
    problem('The frontmatter ends with a line of `---`.');
    return undefined;
  }
  if (split.kind === 'none') return { data: {}, body: split.body };
  const read = readFrontmatter(split.yaml, split.firstLine);
  if (!read.ok) {
    for (const error of read.errors) problem(`Line ${error.line}: ${error.message}`);
    return undefined;
  }
  if (read.value === null || read.value === undefined) return { data: {}, body: split.body };
  if (!isRecord(read.value)) {
    problem('The frontmatter is a mapping of keys, e.g. `description: Reviews pull requests`.');
    return undefined;
  }
  return { data: read.value, body: split.body };
}

function unknownKeys(
  data: Record<string, unknown>,
  known: readonly string[],
  where: string,
  problem: (message: string) => void,
): void {
  for (const key of Object.keys(data)) {
    if (!known.includes(key)) {
      problem(
        `Unknown key \`${key}\` in ${where}: it takes ${known.map((k) => `\`${k}\``).join(', ')}.`,
      );
    }
  }
}

/** One of two alias keys: the value, or a problem when both are given. */
function aliased(
  data: Record<string, unknown>,
  key: string,
  alias: string,
  problem: (message: string) => void,
): unknown {
  if (has(data, key) && has(data, alias)) {
    problem(`\`${key}\` and \`${alias}\` are one setting: give only one.`);
    return undefined;
  }
  return has(data, key) ? data[key] : data[alias];
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

type ParsedAgent = { agent: TeamAgent; file: TeamFile; ok: boolean };

function parseAgent(name: string, file: TeamFile, problem: (message: string) => void) {
  let ok = true;
  const fail = (message: string) => {
    ok = false;
    problem(message);
  };
  const parts = readParts(file, fail);
  if (!parts) return undefined;
  const { data, body } = parts;
  unknownKeys(data, AGENT_KEYS, 'an agent.md', fail);

  const agent: TeamAgent = {
    name,
    description: '',
    agentType: 'CUSTOM',
    instructions: body.trim(),
  };
  if (has(data, 'description')) {
    if (typeof data.description === 'string') agent.description = data.description.trim();
    else fail('Expected `description` to be text.');
  }
  const type = aliased(data, 'agentType', 'workerRole', fail);
  if (type !== undefined) {
    const upper = typeof type === 'string' ? type.trim().toUpperCase() : '';
    const read = upper === 'MAIN' ? 'ORCHESTRATOR' : AGENT_TYPES.find((known) => known === upper);
    if (read) agent.agentType = read;
    else {
      fail(
        `Expected \`agentType\` to be one of ${AGENT_TYPES.join(', ')} (or MAIN, an orchestrator).`,
      );
    }
  }
  if (has(data, 'model')) {
    if (nonEmptyString(data.model) && !/[\r\n]/.test(data.model)) agent.model = data.model;
    else fail('Expected `model` to be a model id on one line, e.g. `claude-sonnet-5-5`.');
  }
  if (has(data, 'harness')) {
    if (data.harness === 'claude' || data.harness === 'codex') agent.harness = data.harness;
    else fail('Expected `harness` to be `claude` or `codex`.');
  }
  if (has(data, 'spawnableBy')) {
    const list = data.spawnableBy;
    if (Array.isArray(list) && list.every((item) => typeof item === 'string')) {
      const bad = list.filter((item) => !TEAM_NAME_PATTERN.test(item));
      if (bad.length > 0) fail(`\`spawnableBy\` names \`${bad[0]}\`, which ${BAD_NAME}`);
      else agent.spawnableBy = [...list];
    } else {
      fail('Expected `spawnableBy` to be a list of agent names, e.g. `[orchestrator]`, or `[]`.');
    }
  }
  if (agent.instructions === '') {
    fail("An agent.md's body is the agent's instructions; it is empty.");
  }
  return { agent, file, ok } satisfies ParsedAgent;
}

/** A filter's list: a plain list (or one value) is `in`, a mapping takes `in` and `not_in`. */
function listFilterOf(
  value: unknown,
  key: string,
  problem: (message: string) => void,
): ListFilter | undefined {
  const strings = (list: unknown, at: string): string[] | undefined => {
    if (list === null || list === undefined) return [];
    if (typeof list === 'string') return [list];
    if (Array.isArray(list) && list.every((item) => typeof item === 'string')) return list;
    problem(`Expected \`${at}\` to be a list of text values.`);
    return undefined;
  };
  let read: ListFilter;
  if (isRecord(value)) {
    unknownKeys(value, LIST_FILTER_KEYS, `\`filter.${key}\``, problem);
    const included = strings(value.in, `filter.${key}.in`);
    const excluded = strings(value.not_in, `filter.${key}.not_in`);
    if (!included || !excluded) return undefined;
    read = { in: included, not_in: excluded };
  } else {
    const included = strings(value, `filter.${key}`);
    if (!included) return undefined;
    read = { in: included };
  }
  const filter: ListFilter = {};
  if (read.in && read.in.length > 0) filter.in = read.in;
  if (read.not_in && read.not_in.length > 0) filter.not_in = read.not_in;
  return filter.in || filter.not_in ? filter : undefined;
}

function filterOf(value: unknown, problem: (message: string) => void): TeamTriggerFilter {
  const filter: TeamTriggerFilter = {};
  if (value === null || value === undefined) return filter;
  if (!isRecord(value)) {
    problem("Expected a trigger's `filter` to be a mapping, e.g. `repos: [owner/name]`.");
    return filter;
  }
  unknownKeys(value, FILTER_KEYS, "a trigger's `filter`", problem);
  for (const key of ['repos', 'base_branches', 'labels', 'authors'] as const) {
    if (!has(value, key)) continue;
    const list = listFilterOf(value[key], key, problem);
    if (list) filter[key] = list;
  }
  if (has(value, 'skip_bots')) {
    const skip = SKIP_BOTS.find((known) => known === value.skip_bots);
    if (skip) filter.skip_bots = skip;
    else problem('Expected `filter.skip_bots` to be `all`, `self` or `none`.');
  }
  return filter;
}

function triggersOf(value: unknown, problem: (message: string) => void): TeamTrigger[] {
  if (!Array.isArray(value) || value.length === 0) {
    problem(
      'An automation needs `triggers:`, a list such as `- provider: github` / `  event: pull_request_opened`.',
    );
    return [];
  }
  const triggers: TeamTrigger[] = [];
  value.forEach((item, index) => {
    const at = `\`triggers[${index}]\``;
    if (!isRecord(item)) {
      problem(`Expected ${at} to be a mapping with \`provider\` and \`event\`.`);
      return;
    }
    unknownKeys(item, TRIGGER_KEYS, at, problem);
    if (!nonEmptyString(item.provider) || !nonEmptyString(item.event)) {
      problem(
        `Expected ${at} to name its \`provider\` and its \`event\`, e.g. \`github\` and \`pull_request_opened\`.`,
      );
      return;
    }
    triggers.push({
      provider: item.provider.trim(),
      event: item.event.trim(),
      filter: filterOf(item.filter, problem),
    });
  });
  return triggers;
}

type ParsedAutomation = { automation: TeamAutomation; target: string | undefined };

function parseAutomation(name: string, file: TeamFile, problem: (message: string) => void) {
  const parts = readParts(file, problem);
  if (!parts) return undefined;
  const { data, body } = parts;
  unknownKeys(data, AUTOMATION_KEYS, 'an automation.md', problem);
  let enabled = true;
  if (has(data, 'enabled')) {
    if (typeof data.enabled === 'boolean') enabled = data.enabled;
    else problem('Expected `enabled` to be `true` or `false`.');
  }
  const target = aliased(data, 'agent', 'worker', problem);
  if (target !== undefined && !nonEmptyString(target)) {
    problem("Expected `agent` to be an agent's name: its folder in agents/.");
  }
  const automation: TeamAutomation = {
    name,
    enabled,
    agent: '',
    triggers: triggersOf(data.triggers, problem),
    prompt: body.trim(),
  };
  return {
    automation,
    target: typeof target === 'string' ? target.trim() : undefined,
  } satisfies ParsedAutomation;
}

const byPath = (a: TeamFile, b: TeamFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The team the files describe, and every problem with them. A file with a problem is left out
 * of the team (an automation naming such an agent is a problem too), so an automation in the
 * team can run as written. Files are read in path order; the team's lists keep that order.
 * `repositories` is `factory.yml`'s `repos:` (`factoryRepositories`): a problem there is not one
 * of the team's issues, as `parseFactory` reports it. Never throws.
 */
export function parseAgentTeam(files: readonly TeamFile[]): {
  team: AgentTeam;
  issues: TeamIssue[];
} {
  const issues: TeamIssue[] = [];
  const problemIn = (file: string) => (message: string) => issues.push({ file, message });

  const seen = new Set<string>();
  const agentFilesByName = new Map<string, TeamFile>();
  const automationFiles = new Map<string, TeamFile>();
  const skillFiles = new Map<string, TeamFile[]>();
  for (const file of [...files].sort(byPath)) {
    const place = placeOf(file.path);
    if (!place) continue;
    if (seen.has(file.path)) {
      problemIn(file.path)('This path appears twice in the factory; the first is read.');
      continue;
    }
    seen.add(file.path);
    if (!TEAM_NAME_PATTERN.test(place.name)) {
      problemIn(file.path)(`\`${place.name}\` ${BAD_NAME}`);
      continue;
    }
    if (place.tree === 'skills') {
      skillFiles.set(place.name, [...(skillFiles.get(place.name) ?? []), file]);
    } else if (place.rest === OWN_FILE[place.tree]) {
      (place.tree === 'agents' ? agentFilesByName : automationFiles).set(place.name, file);
    }
  }

  const parsedAgents: ParsedAgent[] = [];
  for (const [name, file] of agentFilesByName) {
    const parsed = parseAgent(name, file, problemIn(file.path));
    if (parsed) parsedAgents.push(parsed);
  }
  const allAgentNames = new Set(agentFilesByName.keys());
  for (const parsed of parsedAgents) {
    const unknown = parsed.agent.spawnableBy?.filter((name) => !allAgentNames.has(name)) ?? [];
    if (unknown.length > 0) {
      parsed.ok = false;
      problemIn(parsed.file.path)(
        `\`spawnableBy\` names \`${unknown[0]}\`, which is not an agent in this factory (agents/${unknown[0]}/agent.md).`,
      );
    }
  }
  let orchestrator: TeamAgent | undefined;
  for (const parsed of parsedAgents) {
    if (parsed.agent.agentType !== 'ORCHESTRATOR') continue;
    if (!orchestrator) orchestrator = parsed.agent;
    else {
      parsed.ok = false;
      problemIn(parsed.file.path)(
        `A factory has at most one orchestrator, and \`${orchestrator.name}\` is one already.`,
      );
    }
  }
  if (orchestrator && !parsedAgents.some((parsed) => parsed.ok && parsed.agent === orchestrator)) {
    orchestrator = undefined;
  }
  const agents: TeamAgent[] = [];
  for (const parsed of parsedAgents) {
    if (!parsed.ok) continue;
    agentFiles.set(parsed.agent, parsed.file);
    agents.push(parsed.agent);
  }
  const readyAgents = new Set(agents.map((agent) => agent.name));

  const automations: TeamAutomation[] = [];
  for (const [name, file] of automationFiles) {
    const before = issues.length;
    const problem = problemIn(file.path);
    const parsed = parseAutomation(name, file, problem);
    if (!parsed) continue;
    const target = parsed.target ?? orchestrator?.name;
    if (target === undefined) {
      problem(
        'It names no `agent:`, and the factory has no orchestrator (an agent with `agentType: ORCHESTRATOR`) to take it.',
      );
    } else if (!allAgentNames.has(target)) {
      problem(
        `\`agent\` names \`${target}\`, which is not an agent in this factory (agents/${target}/agent.md).`,
      );
    } else if (!readyAgents.has(target)) {
      problem(`Its agent \`${target}\` has problems of its own (agents/${target}/agent.md).`);
    }
    if (issues.length > before || target === undefined) continue;
    automations.push({ ...parsed.automation, agent: target });
  }

  const skills: TeamSkill[] = [];
  for (const [name, own] of skillFiles) {
    const path = `skills/${name}/SKILL.md`;
    const main = own.find((file) => file.path === path);
    const problem = problemIn(main?.path ?? `skills/${name}/`);
    if (!main) {
      problem(`A skill's folder holds its \`SKILL.md\`; skills/${name}/ has none.`);
      continue;
    }
    const parts = readParts(main, problem);
    if (!parts) continue;
    const { data } = parts;
    if (has(data, 'name') && data.name !== name) {
      problem(`\`name:\` says \`${String(data.name)}\`, but the skill's folder is \`${name}\`.`);
      continue;
    }
    if (has(data, 'description') && typeof data.description !== 'string') {
      problem('Expected `description` to be text.');
      continue;
    }
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    skills.push({
      name,
      description,
      files: own.map((file) => ({ path: file.path, content: file.content })),
    });
  }

  return {
    team: {
      agents,
      automations,
      skills,
      ...(orchestrator ? { orchestrator } : {}),
      repositories: factoryRepositories(files),
    },
    issues,
  };
}
