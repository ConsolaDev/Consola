/**
 * The factory folder, parsed whole: `factory.yml`, `automations/<name>.yaml`,
 * `agents/<name>.md` and `skills/<name>/`. Every check of each file runs,
 * then the references across files: each step's `agent:` names a valid agent
 * file, each agent's `skills:` a valid skill folder, and no automation name is
 * defined twice. The texts come in already read (a runner's adapter reads the
 * folder), so this does no I/O and every runner parses a folder alike.
 */
import { agentHash, parseAgentFile, type AgentDefinition } from './agents';
import { parseAutomationFile } from './automationFile';
import { formatPath, type FactorySpecIssue } from './issues';
import { AUTOMATION_NAME_PATTERN } from './names';
import { parseFactoryYml } from './parse';
import { isStepsEntry, type Automation } from './schema';
import { parseSkill, type SkillDefinition, type SkillFileEntry } from './skills';

/** The largest text file the folder's reader reads; a larger one is reported as not read. */
export const MAX_FACTORY_TEXT_BYTES = 1024 * 1024;

/** Folders a later slice reads, and the slice: the notice's words. */
export const LATER_FOLDERS: Readonly<Record<string, string>> = {
  environments: 'slice 3 (write steps)',
  connections: 'slice 5 (connections as data)',
  evals: 'slice 8 (evals)',
};

/** What a runner's adapter read from a factory folder. */
export interface FactoryFiles {
  /** `factory.yml`, or `null` when there is none. */
  factoryYml: string | null;
  /** `automations/<name>.yaml`, by `<name>`. */
  automations: Record<string, string>;
  /** `agents/<name>.md`, by `<name>`. */
  agents: Record<string, string>;
  /** `skills/<name>/`, by `<name>`, each entry's path relative to the skill's folder. */
  skills: Record<string, SkillFileEntry[]>;
  /** Paths in the three folders that are none of these. */
  stray: string[];
  /** Which of `LATER_FOLDERS`' keys exist. */
  laterFolders: string[];
  /** Files the adapter did not read: over `MAX_FACTORY_TEXT_BYTES`, or a read that failed. */
  unread: Array<{ path: string; reason: string }>;
}

/** Something the person should know that does not stop the factory applying. */
export interface FactoryNotice {
  message: string;
  file?: string;
  line?: number;
}

export interface FactoryParseResult {
  /** Each with `file`, and `line` within it: `factory.yml`'s first, then the automation files'. */
  automations: Automation[];
  /** The valid agents, hashed with their skills. */
  agents: Record<string, AgentDefinition>;
  /** The valid skills. */
  skills: Record<string, SkillDefinition>;
  /** Each with `file`. */
  issues: FactorySpecIssue[];
  notices: FactoryNotice[];
  /** `factory.yml`, `automations/<n>.yaml`, `agents/<n>.md`, `skills/<n>` and every unread path, as read. */
  present: string[];
  /** Of those, the ones not read whole: a `factory.yml` or automation file that does not parse, and every unread path. */
  unreadable: string[];
}

/** One automation that parsed, and how to point inside its entry. */
interface Candidate {
  automation: Automation;
  file: string;
  /** A path inside the entry, from the root of the file it lives in. */
  pathTo(rest: Array<string | number>): Array<string | number>;
  lineAt(path: Array<string | number>): number | undefined;
}

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const sortedKeys = (record: object) => Object.keys(record).sort();

/** `a`, `a and b`, `a, b and c`. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function strayMessage(path: string): string {
  if (path.startsWith('agents/'))
    return `\`${path}\` is not an agent: agent files are \`agents/<name>.md\`.`;
  if (path.startsWith('automations/'))
    return `\`${path}\` is not an automation: automation files are \`automations/<name>.yaml\`.`;
  if (path.startsWith('skills/'))
    return `\`${path}\` is not a skill: a skill is a folder, \`skills/<name>/SKILL.md\`.`;
  return `\`${path}\` is not an agent, an automation or a skill.`;
}

/**
 * `parse()`, or why it threw: a file's own parser must never stop the folder
 * parsing, so a throw (whatever its cause) becomes that file's issue.
 */
function guarded<T>(parse: () => T): { ok: true; value: T } | { ok: false; reason: string } {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message.split('\n')[0].trim().replace(/\.$/, '') };
  }
}

const couldNotRead = (file: string, reason: string): FactorySpecIssue => ({
  message: `Could not read \`${file}\`: ${reason}.`,
  file,
  path: '',
});

/** Parse a whole factory folder. Never throws: a file whose parser throws is that file's issue. */
export function parseFactory(files: FactoryFiles): FactoryParseResult {
  const issues: FactorySpecIssue[] = [];
  const notices: FactoryNotice[] = [];
  const present: string[] = [];
  const unreadable: string[] = [];
  const unreadPaths = files.unread.map((entry) => entry.path);
  const unreadUnder = (prefix: string) => unreadPaths.some((path) => path.startsWith(prefix));

  // Skills: the valid ones are kept. One with a file the adapter could not read is not valid.
  const skills: Record<string, SkillDefinition> = {};
  for (const name of sortedKeys(files.skills)) {
    present.push(`skills/${name}`);
    const read = guarded(() => parseSkill(name, files.skills[name]));
    if (!read.ok) {
      issues.push(couldNotRead(`skills/${name}`, read.reason));
      continue;
    }
    const parsed = read.value;
    issues.push(...parsed.issues);
    if (parsed.skill && !unreadUnder(`skills/${name}/`)) skills[name] = parsed.skill;
  }
  const skillIsThere = (name: string) => own(files.skills, name) || unreadUnder(`skills/${name}/`);

  // Agents: each skill an agent names must be a valid skill, or the agent is not kept.
  const agents: Record<string, AgentDefinition> = {};
  for (const name of sortedKeys(files.agents)) {
    const file = `agents/${name}.md`;
    present.push(file);
    const read = guarded(() => parseAgentFile(name, files.agents[name]));
    if (!read.ok) {
      issues.push(couldNotRead(file, read.reason));
      continue;
    }
    const parsed = read.value;
    issues.push(...parsed.issues);
    const agent = parsed.agent;
    if (!agent) continue;
    const missing = agent.skills.filter((skill) => !own(skills, skill));
    for (const skill of missing) {
      issues.push({
        message: skillIsThere(skill)
          ? `\`${skill}\` has problems of its own in skills/${skill}/; this agent applies once they are fixed.`
          : `\`${skill}\` is not a skill here: there is no skills/${skill}/SKILL.md.`,
        file,
        path: 'skills',
        ...(agent.lines.skills !== undefined ? { line: agent.lines.skills } : {}),
      });
    }
    if (missing.length > 0) continue;
    const skillHashes: Record<string, string> = {};
    for (const skill of agent.skills) skillHashes[skill] = skills[skill].hash;
    agents[name] = { ...agent, hash: agentHash(agent, skillHashes) };
  }
  const agentIsThere = (name: string) =>
    own(files.agents, name) || unreadPaths.includes(`agents/${name}.md`);

  // Automations: factory.yml's entries, then each automation file's.
  let candidates: Candidate[] = [];
  const ymlRead =
    files.factoryYml === null ? undefined : guarded(() => parseFactoryYml(files.factoryYml!));
  if (ymlRead && !ymlRead.ok) {
    present.push('factory.yml');
    unreadable.push('factory.yml');
    issues.push(couldNotRead('factory.yml', ymlRead.reason));
  }
  const yml = ymlRead?.ok ? ymlRead.value : undefined;
  if (yml) {
    present.push('factory.yml');
    if (yml.unreadable) unreadable.push('factory.yml');
    issues.push(...yml.issues);
    for (const automation of yml.automations) {
      const base = yml.entryPath(automation.name) ?? [];
      candidates.push({
        automation,
        file: 'factory.yml',
        pathTo: (rest) => [...base, ...rest],
        lineAt: yml.lineAt,
      });
    }
  }
  const automationFiles = sortedKeys(files.automations);
  for (const name of automationFiles) {
    const file = `automations/${name}.yaml`;
    present.push(file);
    const read = guarded(() => parseAutomationFile(name, files.automations[name]));
    if (!read.ok) {
      unreadable.push(file);
      issues.push(couldNotRead(file, read.reason));
      continue;
    }
    const parsed = read.value;
    if (parsed.unreadable) unreadable.push(file);
    issues.push(...parsed.issues);
    if (parsed.automation) {
      candidates.push({
        automation: parsed.automation,
        file,
        pathTo: (rest) => rest,
        lineAt: parsed.lineAt,
      });
    }
  }

  // A name defined twice, in factory.yml (loaded or not) and as a file of its own: neither is kept.
  const twice = new Set(
    automationFiles.filter(
      (name) => AUTOMATION_NAME_PATTERN.test(name) && (yml?.entryNames.includes(name) ?? false),
    ),
  );
  for (const name of twice) {
    const entry = yml?.entryPath(name) ?? [];
    const line = yml?.lineAt(entry);
    const message = `\`${name}\` is defined twice: in factory.yml (line ${line}) and in automations/${name}.yaml.`;
    issues.push({
      message,
      file: 'factory.yml',
      path: formatPath([...entry, 'name']),
      ...(line !== undefined ? { line } : {}),
      automation: name,
    });
    issues.push({ message, file: `automations/${name}.yaml`, path: '', line: 1, automation: name });
  }
  candidates = candidates.filter((candidate) => !twice.has(candidate.automation.name));

  // Each step's agent must be a kept agent, or its entry is not kept.
  candidates = candidates.filter((candidate) => {
    const { automation } = candidate;
    if (!isStepsEntry(automation)) return true;
    let kept = true;
    automation.steps.forEach((step, index) => {
      if (step.kind !== 'agent' || step.agent === undefined || own(agents, step.agent)) return;
      kept = false;
      const path = candidate.pathTo(['steps', index, 'agent']);
      const line = candidate.lineAt(path);
      issues.push({
        message: agentIsThere(step.agent)
          ? `\`${step.agent}\` has problems of its own in agents/${step.agent}.md; this step runs once they are fixed.`
          : `\`${step.agent}\` is not an agent here: there is no agents/${step.agent}.md.`,
        file: candidate.file,
        path: formatPath(path),
        ...(line !== undefined ? { line } : {}),
        automation: automation.name,
      });
    });
    return kept;
  });

  // A dry run's agents may name no server: naming one grants all its tools, writes included.
  candidates = candidates.filter((candidate) => {
    const { automation } = candidate;
    if (automation.mode !== 'notify' || !isStepsEntry(automation)) return true;
    const named = new Set<string>();
    const pairs: string[] = [];
    for (const step of automation.steps) {
      if (step.kind !== 'agent' || step.agent === undefined || named.has(step.agent)) continue;
      named.add(step.agent);
      for (const server of agents[step.agent].mcpServers)
        pairs.push(`\`${server.name}\` from \`${step.agent}\`'s servers`);
    }
    if (pairs.length === 0) return true;
    const path = candidate.pathTo(['mode']);
    const line = candidate.lineAt(path);
    issues.push({
      message: `A dry run can't keep a server's tools to reads: use \`confirm\`, or remove ${joinList(pairs)} for this automation.`,
      file: candidate.file,
      path: formatPath(path),
      ...(line !== undefined ? { line } : {}),
      automation: automation.name,
    });
    return false;
  });

  for (const path of files.stray)
    issues.push({ message: strayMessage(path), file: path, path: '' });
  for (const { path, reason } of files.unread) {
    issues.push({ message: `Could not read \`${path}\`: ${reason}.`, file: path, path: '' });
    present.push(path);
    unreadable.push(path);
  }
  for (const folder of files.laterFolders) {
    if (own(LATER_FOLDERS, folder)) {
      notices.push({
        message: `\`${folder}/\` is read from ${LATER_FOLDERS[folder]}; its files have no effect yet.`,
      });
    }
  }

  return {
    automations: candidates.map((candidate) => candidate.automation),
    agents,
    skills,
    issues,
    notices,
    present,
    unreadable,
  };
}

/**
 * A persisted version's texts, by path relative to the folder, as
 * `parseFactory`'s input: `factory.yml`, `automations/<n>.yaml` and
 * `agents/<n>.md`; any other path is ignored. No skills, no strays, no later
 * folders, nothing unread.
 */
export function factoryFilesOf(texts: Readonly<Record<string, string>>): FactoryFiles {
  const files: FactoryFiles = {
    factoryYml: null,
    automations: {},
    agents: {},
    skills: {},
    stray: [],
    laterFolders: [],
    unread: [],
  };
  for (const path of Object.keys(texts)) {
    const automation = /^automations\/([^/]+)\.yaml$/.exec(path);
    const agent = /^agents\/([^/]+)\.md$/.exec(path);
    if (path === 'factory.yml') files.factoryYml = texts[path];
    else if (automation) files.automations[automation[1]] = texts[path];
    else if (agent) files.agents[agent[1]] = texts[path];
  }
  return files;
}
