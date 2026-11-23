import {
  automationVersion,
  isStepsEntry,
  leafSteps,
  stepsResolvedBody,
  type AgentDefinition,
  type Automation,
  type EnvironmentDefinition,
  type FactoryFiles,
  type FactoryNotice,
  type FactoryParseResult,
  type FactorySpecIssue,
} from '@consola/factory-spec';
import type { AgentHarnessAnswer, AgentHarnessQuery, AppliedSkill, CheckoutKind } from '../ports';
import { entryCheckoutKind } from '../steps/checkout';

/*
 * What of a factory folder applies, decided from its parse alone, and what
 * the person is told when it does not. Pure: the service reads the folder,
 * asks the host and keeps the applied version; this only decides.
 */

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/** The agents an entry's steps name, each once, in step order. */
function agentNamesOf(automation: Automation): string[] {
  if (!isStepsEntry(automation)) return [];
  const names: string[] = [];
  for (const step of leafSteps(automation.steps)) {
    if (step.kind === 'agent' && step.agent !== undefined && !names.includes(step.agent))
      names.push(step.agent);
  }
  return names;
}

/**
 * By name, the hash of each environment an entry's agents name (slice 3-B):
 * what its version covers of `environments/`, beside the agents' hashes. An
 * agent or environment the maps lack adds nothing.
 */
export function entryEnvironmentHashes(
  automation: Automation,
  agents: Readonly<Record<string, AgentDefinition>>,
  environments: Readonly<Record<string, EnvironmentDefinition>> = {},
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const name of agentNamesOf(automation)) {
    const environment = own(agents, name) ? agents[name].environment : undefined;
    if (environment !== undefined && own(environments, environment))
      hashes[environment] = environments[environment].hash;
  }
  return hashes;
}

/**
 * The version as the files alone decide it: what "changed" compares between
 * the latest read and the applied version. Action bodies, which live in
 * settings, are left out, so a settings edit is never a changed file; a
 * schedule-only edit is no change either, as `automationVersion` decides.
 * The environments its agents name are in it as they are in the resolved
 * version (slice 3-B), so an environment edit is a changed file.
 */
export function fileVersion(
  automation: Automation,
  agents: Readonly<Record<string, AgentDefinition>>,
  environments?: Readonly<Record<string, EnvironmentDefinition>>,
): string {
  const hashes: Record<string, string> = {};
  for (const name of agentNamesOf(automation))
    if (own(agents, name)) hashes[name] = agents[name].hash;
  return automationVersion(
    automation,
    stepsResolvedBody({}, hashes, entryEnvironmentHashes(automation, agents, environments)),
  );
}

/**
 * What the engine asks the host of an agent: its harness (absent, the
 * default), its model, its servers and skills, and the kind of checkout its
 * entry's runs work in, which decides what a server may start. A write agent
 * also says its tools and its environment, from `environments` (slice 3-B).
 */
export function agentQuery(
  agent: AgentDefinition,
  checkout: CheckoutKind,
  environments?: Readonly<Record<string, EnvironmentDefinition>>,
): AgentHarnessQuery {
  const environment =
    agent.environment !== undefined && environments && own(environments, agent.environment)
      ? environments[agent.environment]
      : undefined;
  return {
    ...(agent.harness !== undefined ? { harnessId: agent.harness } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    mcpServers: agent.mcpServers.map((server) => ({
      name: server.name,
      ...(server.tools !== undefined ? { tools: [...server.tools] } : {}),
    })),
    skills: [...agent.skills],
    checkout,
    ...(agent.tools !== 'read-only' ? { tools: agent.tools } : {}),
    ...(agent.tools !== 'read-only' && environment
      ? {
          environment: {
            name: environment.name,
            isolation: environment.isolation,
            network: [...environment.network],
            env: [...environment.env],
          },
        }
      : {}),
  };
}

/**
 * What the host says of each agent an entry's steps name, each agent asked
 * once, with the entry's checkout kind. `problems`: the first of its
 * answer's (`agentProblem`, then a refused server, then the harness's own),
 * in the engine's words, a refused server at the agent file's `mcpServers:`
 * line and the rest at its `harness:` line (each its first line when there
 * is none); they block a changed entry and stop any. An agent with no
 * problem may wait (`waits`: its harness's CLI is being asked which servers
 * it has, which blocks only a changed entry) or stop (`stops`: it could not
 * be asked, which stops the entry and never the folder), each at its
 * `mcpServers:` line. `warnings`, never blocking: the model's at `model:`,
 * then each server's at `mcpServers:`.
 */
export function agentIssues(
  automation: Automation,
  agents: Readonly<Record<string, AgentDefinition>>,
  ask: (agent: AgentDefinition, checkout: CheckoutKind) => AgentHarnessAnswer,
): {
  problems: FactorySpecIssue[];
  waits: FactorySpecIssue[];
  stops: FactorySpecIssue[];
  warnings: FactoryNotice[];
} {
  const problems: FactorySpecIssue[] = [];
  const waits: FactorySpecIssue[] = [];
  const stops: FactorySpecIssue[] = [];
  const warnings: FactoryNotice[] = [];
  const checkout = entryCheckoutKind(automation);
  for (const name of agentNamesOf(automation)) {
    if (!own(agents, name)) continue;
    const agent = agents[name];
    const file = `agents/${name}.md`;
    const answer = ask(agent, checkout);
    const at = (key: 'harness' | 'mcpServers', message: string): FactorySpecIssue => ({
      message,
      file,
      line: agent.lines[key] ?? 1,
      path: key,
      automation: automation.name,
    });
    const problem = answer.agentProblem
      ? at('harness', `${file}: ${answer.agentProblem}`)
      : answer.serversProblem
        ? at('mcpServers', `${file}: ${answer.serversProblem}`)
        : answer.problem
          ? at(
              'harness',
              `${answer.name} can’t run read-only automation sessions: ${answer.problem.replace(/\.$/, '')}`,
            )
          : answer.stepProblem
            ? at('harness', `${answer.name} can’t run automation steps: ${answer.stepProblem}`)
            : null;
    if (problem) problems.push(problem);
    else if (answer.serversPending)
      waits.push(at('mcpServers', `${file}: ${answer.serversPending}`));
    else if (answer.serversUnknown)
      stops.push(at('mcpServers', `${file}: ${answer.serversUnknown}`));
    if (answer.warning) {
      warnings.push({
        message: answer.warning,
        file,
        ...(agent.lines.model !== undefined ? { line: agent.lines.model } : {}),
      });
    }
    for (const warning of answer.serverWarnings ?? []) {
      warnings.push({
        message: warning,
        file,
        ...(agent.lines.mcpServers !== undefined ? { line: agent.lines.mcpServers } : {}),
      });
    }
  }
  return { problems, waits, stops, warnings };
}

export type ApplyDecision =
  /** No clean apply yet, and this read is not clean: its entries apply one by one. */
  | { kind: 'first-start' }
  /** The read applies, as a unit. */
  | { kind: 'applies' }
  /**
   * The read does not apply: the applied version keeps running, but for the
   * entries this read removes. `blocking` is why it does not apply;
   * `waiting`, present only when it holds any, what it waits for (a changed
   * entry's server check under way), which is no problem.
   */
  | {
      kind: 'keeps';
      removed: string[];
      blocking: FactorySpecIssue[];
      waiting?: FactorySpecIssue[];
    };

/** `path` is one the read could not read whole, or lies inside a folder it could not list. */
function notReadWhole(read: FactoryParseResult, path: string): boolean {
  return read.unreadable.some(
    (unreadable) =>
      unreadable === path || (unreadable.endsWith('/') && path.startsWith(unreadable)),
  );
}

/**
 * The applied entries this read removes: in neither the read's entries nor
 * any read issue's `automation`, and their home read whole without them.
 * A `factory.yml` entry is removed when `factory.yml` parsed without it, or
 * is gone; an entry in its own file when that file is gone (a file that is
 * there always names its entry, in the read's entries or an issue). One in a
 * file that does not parse, or was not read, is not removed: its absence
 * cannot be told apart from the failure. Computed from this read alone,
 * never carried from an earlier one, so a file missing for one read runs
 * again at the next.
 */
function removedAt(read: FactoryParseResult, applied: FactoryParseResult): string[] {
  const named = new Set<string>(read.automations.map((automation) => automation.name));
  for (const issue of read.issues) if (issue.automation !== undefined) named.add(issue.automation);
  return applied.automations
    .filter(
      (automation) =>
        !named.has(automation.name) && !notReadWhole(read, automation.file ?? 'factory.yml'),
    )
    .map((automation) => automation.name);
}

/**
 * Whether a factory folder's latest read applies.
 *
 * With no clean applied version (none, or one a first start persisted), every
 * entry counts as changed: a read with no issue and no host problem for any
 * entry applies (and from then on the unit rule holds); any other is a first
 * start, its entries applying one by one. With a clean applied version, the
 * read applies when it has no issue and no host problem for an entry whose
 * version changed (an unchanged entry's host problem is its own, not the
 * folder's); otherwise the applied version keeps running, less what this
 * read removes. `problemsOf` and `waitsOf` are asked only of changed
 * entries; a wait holds the read back as a problem does, but is kept apart
 * from `blocking`, since nothing is wrong yet.
 */
export function decideApply(input: {
  read: FactoryParseResult;
  applied: { parse: FactoryParseResult; clean: boolean } | null;
  problemsOf(automation: Automation): FactorySpecIssue[];
  /** Changed entries' waits: they keep the folder from applying, but are not problems. */
  waitsOf?(automation: Automation): FactorySpecIssue[];
}): ApplyDecision {
  const { read, applied, problemsOf, waitsOf } = input;
  const blocking: FactorySpecIssue[] = [...read.issues];
  const waiting: FactorySpecIssue[] = [];
  const ask = (automation: Automation) => {
    blocking.push(...problemsOf(automation));
    if (waitsOf) waiting.push(...waitsOf(automation));
  };
  if (!applied?.clean) {
    for (const automation of read.automations) ask(automation);
    return blocking.length === 0 && waiting.length === 0
      ? { kind: 'applies' }
      : { kind: 'first-start' };
  }
  const appliedVersions = new Map<string, string>();
  for (const automation of applied.parse.automations)
    appliedVersions.set(
      automation.name,
      fileVersion(automation, applied.parse.agents, applied.parse.environments),
    );
  for (const automation of read.automations) {
    if (
      appliedVersions.get(automation.name) ===
      fileVersion(automation, read.agents, read.environments)
    )
      continue;
    ask(automation);
  }
  if (blocking.length === 0 && waiting.length === 0) return { kind: 'applies' };
  return {
    kind: 'keeps',
    removed: removedAt(read, applied.parse),
    blocking,
    ...(waiting.length > 0 ? { waiting } : {}),
  };
}

/**
 * The texts a version persists: every text read (environment files
 * included, slice 3-B), or, given `only` (the entries a first start
 * applied), the texts those entries use: `factory.yml` whole when one of
 * them lives there, each one's own automation file, every agent file they
 * name and the environment file each of those agents names.
 */
export function appliedTexts(
  files: FactoryFiles,
  read: FactoryParseResult,
  only?: readonly Automation[],
): Record<string, string> {
  const texts: Record<string, string> = {};
  if (!only) {
    if (files.factoryYml !== null) texts['factory.yml'] = files.factoryYml;
    for (const name of Object.keys(files.automations))
      texts[`automations/${name}.yaml`] = files.automations[name];
    for (const name of Object.keys(files.agents)) texts[`agents/${name}.md`] = files.agents[name];
    const environments = files.environments ?? {};
    for (const name of Object.keys(environments))
      texts[`environments/${name}.yaml`] = environments[name];
    return texts;
  }
  for (const automation of only) {
    const home = automation.file ?? 'factory.yml';
    if (home === 'factory.yml') {
      if (files.factoryYml !== null) texts['factory.yml'] = files.factoryYml;
    } else {
      const name = home.slice('automations/'.length, -'.yaml'.length);
      if (own(files.automations, name)) texts[home] = files.automations[name];
    }
    for (const agent of agentNamesOf(automation)) {
      if (own(read.agents, agent) && own(files.agents, agent))
        texts[`agents/${agent}.md`] = files.agents[agent];
      const environment = own(read.agents, agent) ? read.agents[agent].environment : undefined;
      if (environment !== undefined && own(files.environments ?? {}, environment))
        texts[`environments/${environment}.yaml`] = files.environments![environment];
    }
  }
  return texts;
}

/**
 * The skills a version persists beside its texts: every skill the read
 * holds, or, given `only` (the entries a first start applied), the skills of
 * the valid agents those entries name. Each its own copy of the file list.
 */
export function appliedSkills(
  read: FactoryParseResult,
  only?: readonly Automation[],
): Record<string, AppliedSkill> {
  const names = new Set<string>();
  if (!only) for (const name of Object.keys(read.skills)) names.add(name);
  else
    for (const automation of only)
      for (const agent of agentNamesOf(automation))
        if (own(read.agents, agent))
          for (const skill of read.agents[agent].skills) names.add(skill);
  const skills: Record<string, AppliedSkill> = {};
  // Every skill a valid agent names is a valid skill of the read (`parseFactory` keeps no other agent).
  for (const name of [...names].sort()) {
    const skill = read.skills[name];
    skills[name] = { hash: skill.hash, files: skill.files.map((file) => ({ ...file })) };
  }
  return skills;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const twoDigits = (value: number) => String(value).padStart(2, '0');

/** When a version applied, in local time: `10:42` on the day of `now`, else `22 Nov 10:42`. */
export function describeAppliedAt(appliedAt: string, now: Date): string {
  const at = new Date(appliedAt);
  const time = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay ? time : `${at.getDate()} ${MONTHS[at.getMonth()]} ${time}`;
}

/** `a`, `a and b`, `a, b and c`. */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The files the banner names: the first three, then how many more. */
function describeFiles(files: readonly string[]): string {
  if (files.length <= 3) return joinList(files);
  const more = files.length - 3;
  return `${files.slice(0, 3).join(', ')} and ${more} more ${more === 1 ? 'file' : 'files'}`;
}

/** The files issues are in, each once, in order. */
function filesOf(issues: readonly FactorySpecIssue[]): string[] {
  const files: string[] = [];
  for (const issue of issues)
    if (issue.file !== undefined && !files.includes(issue.file)) files.push(issue.file);
  return files;
}

/**
 * The banner's sentence while the folder does not apply. It counts and names
 * only the problems in the files that have them: one that only shows a
 * file's problems through (`cause`, a step naming a broken agent) is in the
 * list, never in the count, so one mistake is one problem in one file. With
 * no problem, only server checks under way, it says what it is checking.
 */
export function standingMessage(
  decision: Extract<ApplyDecision, { kind: 'keeps' }>,
  appliedAt: string,
  now: Date,
): string {
  const keeps = `The version from ${describeAppliedAt(appliedAt, now)} keeps running.`;
  const { removed } = decision;
  const names = joinList(removed.map((name) => `\`${name}\``));
  const wasRemoved = `${names} ${removed.length === 1 ? 'was' : 'were'} removed.`;
  if (decision.blocking.length === 0 && decision.waiting && decision.waiting.length > 0) {
    const files = filesOf(decision.waiting);
    const answer = files.length === 1 ? 'once its harness answers' : 'once their harnesses answer';
    const checking = `Checking the MCP servers in ${describeFiles(files)}`;
    if (removed.length === 0) return `${checking}; your changes apply ${answer}. ${keeps}`;
    return `${wasRemoved} ${checking}; the rest of your changes apply ${answer}. ${keeps}`;
  }
  const own = decision.blocking.filter((issue) => issue.cause === undefined);
  // Every problem shows another through only if their files were left out: count them all then.
  const counted = own.length > 0 ? own : decision.blocking;
  const count = counted.length;
  const problems = `${count} ${count === 1 ? 'problem' : 'problems'} in ${describeFiles(filesOf(counted))}`;
  if (removed.length === 0) return `Your changes didn't apply: ${problems}. ${keeps}`;
  return `${wasRemoved} The rest of your changes didn't apply: ${problems}. ${keeps}`;
}
