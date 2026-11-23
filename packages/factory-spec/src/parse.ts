import { LineCounter, parseDocument } from 'yaml';
import {
  closestNode,
  formatPath,
  linesAt,
  nodeAt,
  toIssue,
  type FactorySpecIssue,
  type LineRange,
} from './issues';
import { automationSchema, fileSchema, isStepsEntry, type Automation } from './schema';
import { flatSteps } from './steps';
import { documentValue } from './yamlValue';

export type { FactorySpecIssue };

export interface FactorySpecParseResult {
  automations: Automation[];
  issues: FactorySpecIssue[];
}

/** `factory.yml` read as part of its folder. Internal: `parseFactory` and `parseFactorySpec` use it. */
export interface FactoryYmlResult extends FactorySpecParseResult {
  /** The YAML does not parse, or its envelope fails: nothing in the file was read. */
  unreadable: boolean;
  /** The 1-based line of the node at `path`, or of its nearest ancestor that has one. */
  lineAt(path: Array<string | number>): number | undefined;
  /** The lines the node at `path` is written on; undefined when there is no node there. */
  rangeAt(path: Array<string | number>): LineRange | undefined;
  /**
   * Where the entry with this name is in the file, `['automations', <index>]`:
   * the one that loaded, else the first that has the name and failed.
   */
  entryPath(name: string): Array<string | number> | undefined;
  /** Every name an entry gives itself, loaded or not, once each, in file order. */
  entryNames: string[];
  /** `repos:`, the repositories the factory may write (slice 3-B), as written; none when absent or the file is unreadable. */
  repos: string[];
}

const FILE = 'factory.yml';

/**
 * `factory.yml` as the folder reads it: today's rules, with steps that name an
 * agent kept (`parseFactory` resolves them against `agents/`) and every
 * automation and issue carrying `file: 'factory.yml'`.
 *
 * Never throws. Each automation is validated on its own, so one bad entry
 * reports an issue while its siblings still load. A problem with the file as
 * a whole — YAML syntax, a missing `version` — loads nothing: half-reading a
 * file whose shape is unknown could run something the person did not write.
 */
export function parseFactoryYml(text: string): FactoryYmlResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const lineOf = (offset: number | undefined) =>
    offset === undefined ? undefined : lineCounter.linePos(offset).line;
  const lineAt = (path: Array<string | number>) => lineOf(closestNode(doc, path)?.range?.[0]);
  const indexes = new Map<string, number>();
  const named = new Map<string, number>();
  const result = (
    automations: Automation[],
    issues: FactorySpecIssue[],
    unreadable: boolean,
    repos: string[] = [],
  ): FactoryYmlResult => ({
    automations,
    issues: issues.map((issue) => ({ ...issue, file: FILE })),
    unreadable,
    lineAt,
    rangeAt: (path) => linesAt(doc, lineOf, path),
    entryPath: (name) => {
      const index = indexes.get(name) ?? named.get(name);
      return index === undefined ? undefined : ['automations', index];
    },
    entryNames: [...named.keys()],
    repos,
  });

  if (doc.errors.length > 0) {
    return result(
      [],
      doc.errors.map((error) => ({
        message: firstLine(error.message),
        path: '',
        line: error.linePos?.[0]?.line ?? lineOf(error.pos?.[0]),
      })),
      true,
    );
  }

  const value = documentValue(doc);
  if (!value.ok) return result([], [{ message: value.message, path: '', line: 1 }], true);
  const root: unknown = value.value;
  // An empty (or comments-only) file is a valid "no automations yet".
  if (root === null || root === undefined) return result([], [], false);

  const envelope = fileSchema.safeParse(root);
  if (!envelope.success) {
    return result(
      [],
      envelope.error.issues.map((issue) => toIssue(issue, [], doc, lineOf)),
      true,
    );
  }

  const schema = automationSchema();
  const automations: Automation[] = [];
  const issues: FactorySpecIssue[] = [];

  envelope.data.automations.forEach((raw, index) => {
    const base: Array<string | number> = ['automations', index];
    const name = readableName(raw);
    if (name !== undefined && !named.has(name)) named.set(name, index);
    const line = lineOf(nodeAt(doc, base)?.range?.[0]);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          ...toIssue(issue, base, doc, lineOf),
          ...(name ? { automation: name } : {}),
        });
      }
      return;
    }
    if (indexes.has(parsed.data.name)) {
      issues.push({
        message: `Duplicate automation name "${parsed.data.name}"; names must be unique.`,
        path: formatPath([...base, 'name']),
        line: lineOf(nodeAt(doc, [...base, 'name'])?.range?.[0]) ?? line,
        automation: parsed.data.name,
      });
      return;
    }
    indexes.set(parsed.data.name, index);
    automations.push({ ...parsed.data, ...(line ? { line } : {}), file: FILE });
  });

  return result(automations, issues, false, envelope.data.repos ?? []);
}

/**
 * Parse and validate one factory.yml on its own, as every caller did before
 * the factory was a folder, and with exactly the shape it returned then: no
 * `file` on anything it returns.
 *
 * Read without its folder, a step's `agent:` cannot be resolved, so an entry
 * with such a step is left out with one issue per step; everything else is
 * `parseFactoryYml`'s.
 */
export function parseFactorySpec(text: string): FactorySpecParseResult {
  const read = parseFactoryYml(text);
  const automations: Automation[] = [];
  const issues = read.issues.map(withoutFile);
  for (const automation of read.automations) {
    // A loop's steps too, each at its own line (`steps[i].steps[j].agent`).
    const agentSteps = isStepsEntry(automation)
      ? flatSteps(automation.steps).flatMap(({ step, path }) =>
          step.kind === 'agent' && step.agent !== undefined ? [{ agent: step.agent, path }] : [],
        )
      : [];
    if (agentSteps.length === 0) {
      automations.push(withoutFile(automation));
      continue;
    }
    const base = read.entryPath(automation.name) ?? [];
    for (const { agent, path: at } of agentSteps) {
      const path = [...base, 'steps', ...at, 'agent'];
      const line = read.lineAt(path);
      issues.push({
        message: `\`agent: ${agent}\` names agents/${agent}.md, and this factory.yml is read without its folder.`,
        path: formatPath(path),
        ...(line ? { line } : {}),
        automation: automation.name,
      });
    }
  }
  return { automations, issues };
}

function withoutFile<T extends { file?: string }>(value: T): T {
  const copy = { ...value };
  delete copy.file;
  return copy;
}

function readableName(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object' && 'name' in raw) {
    const name = (raw as { name: unknown }).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return undefined;
}

function firstLine(message: string): string {
  return message.split('\n')[0].trim();
}
