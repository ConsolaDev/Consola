/**
 * The factory folder, parsed whole: `factory.yml`, `automations/<name>.yaml`,
 * `agents/<name>.md`, `skills/<name>/` and `environments/<name>.yaml`. Every check of each file runs,
 * then the references across files: each step's `agent:` names a valid agent
 * file, each call's `uses:` a valid server of `factory.yml`'s (or `consola`),
 * each agent's `skills:` a valid skill folder, and no automation name is
 * defined twice. The texts come in already read (a runner's adapter reads the
 * folder), so this does no I/O and every runner parses a folder alike.
 */
import { agentHash, parseAgentFile } from './agents';
import type { AgentDefinition } from './agents';
import { parseEnvironmentFile } from './environments';
import type { EnvironmentDefinition } from './environments';
import { parseAutomationFile } from './automationFile';
import { usesNotices } from './callArguments';
import { formatPath } from './issues';
import type { FactorySpecIssue } from './issues';
import { AUTOMATION_NAME_PATTERN } from './names';
import { parseFactoryYml } from './parse';
import { isRunOwnedCheckout } from './flow';
import { isStepsEntry } from './schema';
import type { Automation } from './schema';
import type { McpServerDefinition } from './servers';
import { parseSkill } from './skills';
import type { SkillDefinition, SkillFileEntry } from './skills';
import { flatSteps, leafSteps } from './steps';

/** The largest text file the folder's reader reads; a larger one is reported as not read. */
export const MAX_FACTORY_TEXT_BYTES = 1024 * 1024;

/** Folders a later slice reads, and when: the notice's words, `` `<folder>/` is read <phrase>; … ``. */
export const LATER_FOLDERS: Readonly<Record<string, string>> = {
  connections: 'once connection manifests arrive',
  evals: 'from slice 8 (evals)',
};

/** What editors and the OS leave beside a file, by suffix: a backup (`x.md~`, `x.bak`), a merge's or a patch's (`x.orig`, `x.rej`). */
const LEFTOVER_SUFFIXES = ['~', '.bak', '.orig', '.rej'];
/** Files an OS writes into any folder it shows (Windows's; macOS's `.DS_Store` is a dotfile). */
const OS_FILES = ['Thumbs.db', 'desktop.ini'];

/**
 * A name a folder's reader passes over, so it is neither a file of the
 * factory nor a stray: a dotfile (Vim's swap `.x.md.swp`, Emacs's lock
 * `.#x.md`, `.DS_Store`, the reader's own temporary files), Emacs's autosave
 * `#x.md#`, a leftover by its suffix, or an OS's own file. So an editor's
 * backup beside a file never stops the folder applying; any other stray still
 * does. Every runner's adapter passes over the same names.
 */
export function isIgnoredFileName(name: string): boolean {
  if (name.startsWith('.') || OS_FILES.includes(name)) return true;
  if (name.length > 1 && name.startsWith('#') && name.endsWith('#')) return true;
  const lower = name.toLowerCase();
  return LEFTOVER_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

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
  /**
   * `environments/<name>.yaml`, by `<name>` (slice 3-B). Optional: an
   * adapter or a persisted version from before environments has none, read
   * as none.
   */
  environments?: Record<string, string>;
  /** Paths in the three folders that are none of these, but for the names `isIgnoredFileName` passes over. */
  stray: string[];
  /** Which of `LATER_FOLDERS`' keys exist. */
  laterFolders: string[];
  /** Files the adapter did not read: over `MAX_FACTORY_TEXT_BYTES`, or a read that failed. */
  unread: Array<{ path: string; reason: string }>;
  /**
   * Files, or one of the three folders (`agents/`, with its `/`), whose real
   * path leaves the folder's real path: never read, as a factory folder can
   * hold other people's files and a link could pull any of the person's into
   * an agent's prompt. A link that stays inside the folder is read through.
   */
  outside: string[];
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
  /** The valid environments, by name (slice 3-B). */
  environments: Record<string, EnvironmentDefinition>;
  /** Each with `file`. */
  issues: FactorySpecIssue[];
  notices: FactoryNotice[];
  /**
   * `factory.yml`, `automations/<n>.yaml`, `agents/<n>.md`, `skills/<n>` and
   * every unread or outside path, as read: what is there, valid or not. A
   * runner tells a file with problems from one that is not there by it (the
   * desktop's save does, for a step's agent).
   */
  present: string[];
  /** Of those, the ones not read whole: a `factory.yml` or automation file that does not parse, and every unread or outside path. */
  unreadable: string[];
  /** `factory.yml`'s valid MCP servers, by name: the ones a `uses:` step may call. */
  servers: Record<string, McpServerDefinition>;
  /** Names under `factory.yml`'s `mcpServers:` with problems of their own. */
  brokenServers: string[];
  /** `factory.yml`'s `repos:` (slice 3-B): the repositories a run-owned checkout may name. None without a readable factory.yml. */
  repos: string[];
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
  if (path.startsWith('environments/'))
    return `\`${path}\` is not an environment: environment files are \`environments/<name>.yaml\`.`;
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
  // A file or folder that links outside is not read either: as unread, nothing in it is told apart from the failure.
  const unreadPaths = [...files.unread.map((entry) => entry.path), ...files.outside];
  const unreadUnder = (prefix: string) => unreadPaths.some((path) => path.startsWith(prefix));
  const coveredBy = (path: string) =>
    unreadPaths.some(
      (unread) => unread === path || (unread.endsWith('/') && path.startsWith(unread)),
    );

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

  // Environments (slice 3-B): the valid ones are kept, for the write agents that name them.
  const environments: Record<string, EnvironmentDefinition> = {};
  for (const name of sortedKeys(files.environments ?? {})) {
    const file = `environments/${name}.yaml`;
    present.push(file);
    const read = guarded(() => parseEnvironmentFile(name, files.environments![name]));
    if (!read.ok) {
      issues.push(couldNotRead(file, read.reason));
      continue;
    }
    issues.push(...read.value.issues);
    if (read.value.environment) environments[name] = read.value.environment;
  }

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
      const there = skillIsThere(skill);
      issues.push({
        message: there
          ? `\`${skill}\` has problems of its own in skills/${skill}/; this agent applies once they are fixed.`
          : `\`${skill}\` is not a skill here: there is no skills/${skill}/SKILL.md.`,
        file,
        path: 'skills',
        ...(agent.lines.skills !== undefined ? { line: agent.lines.skills } : {}),
        ...(there ? { cause: `skills/${skill}/` } : {}),
      });
    }
    if (missing.length > 0) continue;
    // A write agent's environment must be a valid one, or the agent is not kept (slice 3-B).
    if (agent.environment !== undefined && !own(environments, agent.environment)) {
      const env = agent.environment;
      const there = own(files.environments ?? {}, env) || coveredBy(`environments/${env}.yaml`);
      issues.push({
        message: there
          ? `\`${env}\` has problems of its own in environments/${env}.yaml; this agent applies once they are fixed.`
          : `\`${env}\` is not an environment here: there is no environments/${env}.yaml.`,
        file,
        path: 'environment',
        ...(agent.lines.environment !== undefined ? { line: agent.lines.environment } : {}),
        ...(there ? { cause: `environments/${env}.yaml` } : {}),
      });
      continue;
    }
    const skillHashes: Record<string, string> = {};
    for (const skill of agent.skills) skillHashes[skill] = skills[skill].hash;
    agents[name] = { ...agent, hash: agentHash(agent, skillHashes) };
  }
  const agentIsThere = (name: string) => own(files.agents, name) || coveredBy(`agents/${name}.md`);

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
    for (const { message, path } of yml.serverNotices) {
      const line = yml.lineAt(path);
      notices.push({ message, file: 'factory.yml', ...(line !== undefined ? { line } : {}) });
    }
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

  // A run-owned checkout names one of factory.yml's `repos:`, or its entry is not kept (slice 3-B).
  const repos = yml?.repos ?? [];
  const listed = new Set(repos.map((repo) => repo.toLowerCase()));
  candidates = candidates.filter((candidate) => {
    const { checkout } = candidate.automation;
    if (!isRunOwnedCheckout(checkout) || listed.has(checkout.repo.toLowerCase())) return true;
    const path = candidate.pathTo(['checkout', 'repo']);
    const line = candidate.lineAt(path);
    issues.push({
      message: `\`${checkout.repo}\` is not in \`repos:\` in factory.yml.`,
      file: candidate.file,
      path: formatPath(path),
      ...(line !== undefined ? { line } : {}),
      automation: candidate.automation.name,
    });
    return false;
  });

  // Each step's agent must be a kept agent, or its entry is not kept.
  candidates = candidates.filter((candidate) => {
    const { automation } = candidate;
    if (!isStepsEntry(automation)) return true;
    let kept = true;
    // A loop's steps too, each at its own line (`steps[i].steps[j].agent`).
    flatSteps(automation.steps).forEach(({ step, path: at }) => {
      if (step.kind !== 'agent' || step.agent === undefined || own(agents, step.agent)) return;
      kept = false;
      const path = candidate.pathTo(['steps', ...at, 'agent']);
      const line = candidate.lineAt(path);
      const there = agentIsThere(step.agent);
      issues.push({
        message: there
          ? `\`${step.agent}\` has problems of its own in agents/${step.agent}.md; this step runs once they are fixed.`
          : `\`${step.agent}\` is not an agent here: there is no agents/${step.agent}.md.`,
        file: candidate.file,
        path: formatPath(path),
        ...(line !== undefined ? { line } : {}),
        automation: automation.name,
        ...(there ? { cause: `agents/${step.agent}.md` } : {}),
      });
    });
    return kept;
  });

  // Each call's server must be one factory.yml defines, valid, or its entry is not kept.
  const servers = yml?.servers ?? {};
  const brokenServers = yml?.brokenServers ?? [];
  candidates = candidates.filter((candidate) => {
    const { automation } = candidate;
    if (!isStepsEntry(automation)) return true;
    let kept = true;
    // A loop's calls too, each at its own line.
    flatSteps(automation.steps).forEach(({ step, path: at }) => {
      if (step.kind !== 'uses' || step.server === 'consola' || own(servers, step.server)) return;
      kept = false;
      const path = candidate.pathTo(['steps', ...at, 'uses']);
      const line = candidate.lineAt(path);
      const broken = brokenServers.includes(step.server);
      issues.push({
        message: broken
          ? `\`${step.server}\` has problems of its own in factory.yml's \`mcpServers:\`; this step runs once they are fixed.`
          : `\`${step.server}\` is not a server here: factory.yml's \`mcpServers:\` has none of that name.`,
        file: candidate.file,
        path: formatPath(path),
        ...(line !== undefined ? { line } : {}),
        automation: automation.name,
        ...(broken ? { cause: 'factory.yml' } : {}),
      });
    });
    return kept;
  });

  // Two namespaces: an agent's servers are its harness's, whatever factory.yml defines.
  const factoryServerNames = [...Object.keys(servers), ...brokenServers];
  for (const name of sortedKeys(agents)) {
    const agent = agents[name];
    // An agent that names servers always names its harness (`parseAgentFile`).
    if (agent.harness === undefined) continue;
    for (const server of agent.mcpServers) {
      if (!factoryServerNames.includes(server.name)) continue;
      notices.push({
        message: `\`${server.name}\` is also a server in factory.yml; this agent gets \`${agent.harness}\`'s \`${server.name}\`, because agents use their harness's servers.`,
        file: `agents/${name}.md`,
        ...(agent.lines.mcpServers !== undefined ? { line: agent.lines.mcpServers } : {}),
      });
    }
  }

  // A write agent changes code only on a branch its run cuts (invariant 9): its entry owns its checkout (slice 3-B).
  candidates = candidates.filter((candidate) => {
    const { automation } = candidate;
    if (!isStepsEntry(automation) || isRunOwnedCheckout(automation.checkout)) return true;
    let kept = true;
    flatSteps(automation.steps).forEach(({ step, path: at }) => {
      if (step.kind !== 'agent' || step.agent === undefined) return;
      if (agents[step.agent].tools === 'read-only') return;
      kept = false;
      const path = candidate.pathTo(['steps', ...at, 'agent']);
      const line = candidate.lineAt(path);
      issues.push({
        message:
          'A write agent changes code only on a branch the run cuts from one of `repos:` (invariant 9). Add `checkout: { repo: …, branch: … }`.',
        file: candidate.file,
        path: formatPath(path),
        ...(line !== undefined ? { line } : {}),
        automation: automation.name,
      });
    });
    return kept;
  });

  // A path artifact is a file the step leaves in the checkout: only an agent that writes leaves one (slice 3-B).
  candidates = candidates.filter((candidate) => {
    const { automation } = candidate;
    if (!isStepsEntry(automation)) return true;
    let kept = true;
    flatSteps(automation.steps).forEach(({ step, path: at }) => {
      if (step.kind !== 'agent' || step.pathArtifacts === undefined) return;
      // A step that names no agent runs on the workspace's default harness, read-only.
      if (step.agent !== undefined && agents[step.agent].tools !== 'read-only') return;
      kept = false;
      const path = candidate.pathTo(['steps', ...at, 'artifacts']);
      const line = candidate.lineAt(path);
      issues.push({
        message: `A read-only agent writes no files; \`${step.pathArtifacts[0].name}\` with a \`path:\` needs an \`edit\` or \`write\` agent.`,
        file: candidate.file,
        path: formatPath(path),
        ...(line !== undefined ? { line } : {}),
        automation: automation.name,
      });
    });
    return kept;
  });

  // Only what cannot have acted retries by itself (slice 3, Call 8): an agent naming a server may have posted,
  // and a write agent on `host` may have done anything the person can (slice 3-B).
  candidates = candidates.filter((candidate) => {
    const { automation } = candidate;
    if (!isStepsEntry(automation)) return true;
    let kept = true;
    flatSteps(automation.steps).forEach(({ step, path: at }) => {
      if (step.kind !== 'agent' || step.agent === undefined || (step.onFailure?.retry ?? 0) === 0)
        return;
      const agent = agents[step.agent];
      const onHost =
        agent.tools === 'write' &&
        agent.environment !== undefined &&
        environments[agent.environment].isolation === 'host';
      if (agent.mcpServers.length === 0 && !onHost) return;
      kept = false;
      const path = candidate.pathTo(['steps', ...at, 'on_failure']);
      const line = candidate.lineAt(path);
      issues.push({
        message:
          agent.mcpServers.length > 0
            ? `\`${step.id}\`'s agent names an MCP server, which may post or change things, so it never retries by itself; a person retries it from the run page.`
            : `\`${step.id}\`'s agent writes and runs commands on \`host\`, so it never retries by itself; a person retries it from the run page.`,
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
    for (const step of leafSteps(automation.steps)) {
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

  // A call's argument a tool may run or open, fed text someone else wrote: said, never refused.
  for (const candidate of candidates) {
    for (const { message, path } of usesNotices(candidate.automation)) {
      const line = candidate.lineAt(candidate.pathTo(path));
      notices.push({ message, file: candidate.file, ...(line !== undefined ? { line } : {}) });
    }
  }

  for (const path of files.stray)
    issues.push({ message: strayMessage(path), file: path, path: '' });
  for (const { path, reason } of files.unread) {
    issues.push({ message: `Could not read \`${path}\`: ${reason}.`, file: path, path: '' });
    present.push(path);
    unreadable.push(path);
  }
  for (const path of files.outside) {
    issues.push({
      message: `\`${path}\` links outside the factory folder; Consola reads only files inside it.`,
      file: path,
      path: '',
    });
    present.push(path);
    unreadable.push(path);
  }
  for (const folder of files.laterFolders) {
    if (own(LATER_FOLDERS, folder)) {
      notices.push({
        message: `\`${folder}/\` is read ${LATER_FOLDERS[folder]}; its files have no effect yet.`,
      });
    }
  }

  return {
    automations: candidates.map((candidate) => candidate.automation),
    agents,
    skills,
    environments,
    issues,
    notices,
    present,
    unreadable,
    servers,
    brokenServers,
    repos,
  };
}

/**
 * A persisted version's texts, by path relative to the folder, and its skill
 * files, by skill name, each by its path inside the skill's folder, as
 * `parseFactory`'s input: `factory.yml`, `automations/<n>.yaml`,
 * `agents/<n>.md` and `environments/<n>.yaml`; any other text path is ignored. No strays, no later
 * folders, nothing unread or outside; no skills when none are given.
 */
export function factoryFilesOf(
  texts: Readonly<Record<string, string>>,
  skills?: Readonly<Record<string, ReadonlyArray<{ path: string; bytes: Uint8Array }>>>,
): FactoryFiles {
  const files: FactoryFiles = {
    factoryYml: null,
    automations: {},
    agents: {},
    skills: {},
    stray: [],
    laterFolders: [],
    unread: [],
    outside: [],
  };
  for (const path of Object.keys(texts)) {
    const automation = /^automations\/([^/]+)\.yaml$/.exec(path);
    const agent = /^agents\/([^/]+)\.md$/.exec(path);
    const environment = /^environments\/([^/]+)\.yaml$/.exec(path);
    if (path === 'factory.yml') files.factoryYml = texts[path];
    else if (automation) files.automations[automation[1]] = texts[path];
    else if (agent) files.agents[agent[1]] = texts[path];
    else if (environment) {
      if (files.environments === undefined) files.environments = {};
      files.environments[environment[1]] = texts[path];
    }
  }
  for (const name of Object.keys(skills ?? {}))
    files.skills[name] = skills![name].map((entry) => ({ path: entry.path, bytes: entry.bytes }));
  return files;
}
