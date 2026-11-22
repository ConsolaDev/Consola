import {
  automationVersion,
  isStepsEntry,
  stepsResolvedBody,
  type AgentDefinition,
  type Automation,
  type FactoryFiles,
  type FactoryNotice,
  type FactoryParseResult,
  type FactorySpecIssue,
} from '@consola/factory-spec';
import type { AgentHarnessAnswer, AgentHarnessQuery } from '../ports';

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
  for (const step of automation.steps) {
    if (step.kind === 'agent' && step.agent !== undefined && !names.includes(step.agent))
      names.push(step.agent);
  }
  return names;
}

/**
 * The version as the files alone decide it: what "changed" compares between
 * the latest read and the applied version. Action bodies, which live in
 * settings, are left out, so a settings edit is never a changed file; a
 * schedule-only edit is no change either, as `automationVersion` decides.
 */
export function fileVersion(
  automation: Automation,
  agents: Readonly<Record<string, AgentDefinition>>,
): string {
  const hashes: Record<string, string> = {};
  for (const name of agentNamesOf(automation))
    if (own(agents, name)) hashes[name] = agents[name].hash;
  return automationVersion(automation, stepsResolvedBody({}, hashes));
}

/** What the engine asks the host of an agent: its harness (absent, the default), its model, its servers and skills. */
export function agentQuery(agent: AgentDefinition): AgentHarnessQuery {
  return {
    ...(agent.harness !== undefined ? { harnessId: agent.harness } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    mcpServers: agent.mcpServers.map((server) => ({
      name: server.name,
      ...(server.tools !== undefined ? { tools: [...server.tools] } : {}),
    })),
    skills: [...agent.skills],
  };
}

/**
 * What the host says of each agent an entry's steps name, each agent asked
 * once: the first of its answer's problems, in the engine's words, at the
 * agent file's `harness:` line (its first line when there is none), and its
 * warning as a notice at its `model:` line.
 */
export function agentIssues(
  automation: Automation,
  agents: Readonly<Record<string, AgentDefinition>>,
  ask: (agent: AgentDefinition) => AgentHarnessAnswer,
): { problems: FactorySpecIssue[]; warnings: FactoryNotice[] } {
  const problems: FactorySpecIssue[] = [];
  const warnings: FactoryNotice[] = [];
  for (const name of agentNamesOf(automation)) {
    if (!own(agents, name)) continue;
    const agent = agents[name];
    const file = `agents/${name}.md`;
    const answer = ask(agent);
    const message = answer.agentProblem
      ? `${file}: ${answer.agentProblem}`
      : answer.problem
        ? `${answer.name} can’t run read-only automation sessions: ${answer.problem.replace(/\.$/, '')}`
        : answer.stepProblem
          ? `${answer.name} can’t run automation steps: ${answer.stepProblem}`
          : null;
    if (message !== null) {
      problems.push({
        message,
        file,
        line: agent.lines.harness ?? 1,
        path: 'harness',
        automation: automation.name,
      });
    }
    if (answer.warning) {
      warnings.push({
        message: answer.warning,
        file,
        ...(agent.lines.model !== undefined ? { line: agent.lines.model } : {}),
      });
    }
  }
  return { problems, warnings };
}

export type ApplyDecision =
  /** No clean apply yet, and this read is not clean: its entries apply one by one. */
  | { kind: 'first-start' }
  /** The read applies, as a unit. */
  | { kind: 'applies' }
  /**
   * The read does not apply: the applied version keeps running, but for the
   * entries this read removes. `blocking` is why it does not apply.
   */
  | { kind: 'keeps'; removed: string[]; blocking: FactorySpecIssue[] };

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
 * read removes. `problemsOf` is asked only of changed entries.
 */
export function decideApply(input: {
  read: FactoryParseResult;
  applied: { parse: FactoryParseResult; clean: boolean } | null;
  problemsOf(automation: Automation): FactorySpecIssue[];
}): ApplyDecision {
  const { read, applied, problemsOf } = input;
  const blocking: FactorySpecIssue[] = [...read.issues];
  if (!applied?.clean) {
    for (const automation of read.automations) blocking.push(...problemsOf(automation));
    return blocking.length === 0 ? { kind: 'applies' } : { kind: 'first-start' };
  }
  const appliedVersions = new Map<string, string>();
  for (const automation of applied.parse.automations)
    appliedVersions.set(automation.name, fileVersion(automation, applied.parse.agents));
  for (const automation of read.automations) {
    if (appliedVersions.get(automation.name) === fileVersion(automation, read.agents)) continue;
    blocking.push(...problemsOf(automation));
  }
  if (blocking.length === 0) return { kind: 'applies' };
  return { kind: 'keeps', removed: removedAt(read, applied.parse), blocking };
}

/**
 * The texts a version persists: every text read, or, given `only` (the
 * entries a first start applied), the texts those entries use: `factory.yml`
 * whole when one of them lives there, each one's own automation file, and
 * every agent file they name.
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
    }
  }
  return texts;
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

/**
 * The banner's sentence while the folder does not apply. It counts and names
 * only the problems in the files that have them: one that only shows a
 * file's problems through (`cause`, a step naming a broken agent) is in the
 * list, never in the count, so one mistake is one problem in one file.
 */
export function standingMessage(
  decision: Extract<ApplyDecision, { kind: 'keeps' }>,
  appliedAt: string,
  now: Date,
): string {
  const own = decision.blocking.filter((issue) => issue.cause === undefined);
  // Every problem shows another through only if their files were left out: count them all then.
  const counted = own.length > 0 ? own : decision.blocking;
  const files: string[] = [];
  for (const issue of counted)
    if (issue.file !== undefined && !files.includes(issue.file)) files.push(issue.file);
  const count = counted.length;
  const problems = `${count} ${count === 1 ? 'problem' : 'problems'} in ${describeFiles(files)}`;
  const keeps = `The version from ${describeAppliedAt(appliedAt, now)} keeps running.`;
  const { removed } = decision;
  if (removed.length === 0) return `Your changes didn't apply: ${problems}. ${keeps}`;
  const names = joinList(removed.map((name) => `\`${name}\``));
  return `${names} ${removed.length === 1 ? 'was' : 'were'} removed. The rest of your changes didn't apply: ${problems}. ${keeps}`;
}
