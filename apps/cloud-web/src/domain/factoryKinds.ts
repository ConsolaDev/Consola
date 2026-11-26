import { pathsOf, removedPaths } from './factoryDraft';
import type { FactoryDraft } from './factoryDraft';

/**
 * The kinds of file a stored factory holds, as the Definition page makes them: `factory.yml`, an
 * automation, an agent, a skill and a file inside a skill. The person picks a kind and types a
 * name, never a path, so the page never makes a path the format refuses (a stray); and every new
 * file starts from a skeleton that passes the checker, so a new file never turns Save off. The
 * automation's skeleton runs only when someone starts it (`on: manual`).
 *
 * The name rule is a copy of factory-spec's (`AUTOMATION_NAME_PATTERN`), so the page's bundle does
 * not load factory-spec before the checker is wanted; `factoryKinds.test.ts` pins the copy against
 * the checker for every kind a name makes.
 */

/** An automation's, agent's or skill's name: the file's (or the skill folder's) own. */
export const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The kinds a person names, in the order the New menu offers them. */
export type NewKind = 'automation' | 'agent' | 'skill';
export const NEW_KINDS: readonly NewKind[] = ['automation', 'agent', 'skill'];

/** What a path is to the format; null for a file of a folder read later (`evals/`). */
export type FileKind = 'factory' | NewKind | 'skill-file';

/** The longest a file's path may be, in characters: the cell's limit. */
export const PATH_MAX = 256;

const AUTOMATION_PATH = /^automations\/([^/]+)\.yaml$/;
const AGENT_PATH = /^agents\/([^/]+)\.md$/;
const SKILL_PATH = /^skills\/([^/]+)\/(.+)$/;

export function kindOfPath(path: string): FileKind | null {
  if (path === 'factory.yml') return 'factory';
  if (AUTOMATION_PATH.test(path)) return 'automation';
  if (AGENT_PATH.test(path)) return 'agent';
  const skill = SKILL_PATH.exec(path);
  if (skill) return skill[2] === 'SKILL.md' ? 'skill' : 'skill-file';
  return null;
}

/** The skill a path is inside, by its folder's name; null for a path in no skill. */
export function skillOf(path: string): string | null {
  return SKILL_PATH.exec(path)?.[1] ?? null;
}

/** Where a new file of `kind` named `name` goes. A skill is made as its `SKILL.md`. */
export function pathFor(kind: NewKind, name: string): string {
  switch (kind) {
    case 'automation':
      return `automations/${name}.yaml`;
    case 'agent':
      return `agents/${name}.md`;
    case 'skill':
      return `skills/${name}/SKILL.md`;
  }
}

export const FACTORY_YML_SKELETON = `# This factory's own settings. An automation can live here, under
# \`automations:\`, or in a file of its own in automations/.
version: 1
`;

const AUTOMATION_SKELETON = `# Runs when someone starts it on a pull request.
on: manual
applies_to: [pr]
steps:
  - run: echo "Replace this step with what the automation does."
`;

const AGENT_SKELETON = `---
description: What this agent does, in one line.
---

Say what the agent does, step by step.
`;

const skillSkeleton = (name: string) => `---
name: ${name}
description: When to use this skill, in one line.
---

How to do it, step by step.
`;

/** A new file's text: its kind's skeleton, with a skill's name filled in; a skill's file is empty. */
export function skeletonFor(kind: NewKind | 'factory' | 'skill-file', name: string): string {
  switch (kind) {
    case 'factory':
      return FACTORY_YML_SKELETON;
    case 'automation':
      return AUTOMATION_SKELETON;
    case 'agent':
      return AGENT_SKELETON;
    case 'skill':
      return skillSkeleton(name);
    case 'skill-file':
      return '';
  }
}

/**
 * The line a new file's caret starts on, from 1: its body's first line, past the front matter of
 * a Markdown file and its blank lines, or past a YAML file's leading comments.
 */
export function bodyLine(text: string): number {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  let at = 0;
  const fronted = lines[0] === '---';
  if (fronted) {
    const end = lines.indexOf('---', 1);
    at = end === -1 ? 0 : end + 1;
  }
  while (at < lines.length - 1) {
    const line = (lines[at] ?? '').trim();
    if (line !== '' && (fronted || !line.startsWith('#'))) break;
    at++;
  }
  return Math.min(at, Math.max(lines.length - 1, 0)) + 1;
}

/** What a naming field is for: a new file of a kind, or a new name for a file or a skill. */
export type NamingTarget =
  | { type: 'new'; kind: NewKind }
  | { type: 'new-in-skill'; skill: string }
  | { type: 'rename'; path: string }
  | { type: 'rename-skill'; skill: string };

/** What sits either side of the field: `agents/` and `.md`. */
export function namingParts(target: NamingTarget): { before: string; after: string } {
  switch (target.type) {
    case 'new':
      return target.kind === 'skill' ? { before: 'skills/', after: '/' } : partsOf(target.kind);
    case 'new-in-skill':
      return { before: `skills/${target.skill}/`, after: '' };
    case 'rename-skill':
      return { before: 'skills/', after: '/' };
    case 'rename': {
      const kind = kindOfPath(target.path);
      if (kind === 'automation' || kind === 'agent') return partsOf(kind);
      return { before: `skills/${skillOf(target.path) ?? ''}/`, after: '' };
    }
  }
}

function partsOf(kind: 'automation' | 'agent'): { before: string; after: string } {
  return kind === 'automation'
    ? { before: 'automations/', after: '.yaml' }
    : { before: 'agents/', after: '.md' };
}

/** What the field holds as it opens: nothing for a new file, the current name for a rename. */
export function namingStart(target: NamingTarget): string {
  switch (target.type) {
    case 'new':
    case 'new-in-skill':
      return '';
    case 'rename-skill':
      return target.skill;
    case 'rename': {
      const { before, after } = namingParts(target);
      return target.path.slice(before.length, target.path.length - after.length);
    }
  }
}

/** What the draft holds that a name could clash with. */
export type NameFacts = {
  /** Every path in the tree. */
  readonly live: ReadonlySet<string>;
  /** Every path waiting under "Removed on save". */
  readonly removed: ReadonlySet<string>;
  /** The automations `factory.yml` defines, as the latest check read the files. */
  readonly definedAutomations: readonly string[];
};

export function nameFactsOf(draft: FactoryDraft, definedAutomations: readonly string[]): NameFacts {
  return {
    live: new Set(pathsOf(draft)),
    removed: new Set(removedPaths(draft)),
    definedAutomations,
  };
}

/** Why a name cannot be made. */
export type NameProblem =
  /** Nothing typed: Enter cancels. */
  | 'empty'
  /** It breaks the name rule. */
  | 'rule'
  /** A path inside a skill with an empty, `.` or `..` part, a `\` or a control character. */
  | 'path'
  /** A path inside a skill longer than a factory's paths may be. */
  | 'long'
  /** A file the tree holds. */
  | 'taken'
  /** A file waiting under "Removed on save". */
  | 'removed'
  /** An automation `factory.yml` defines. */
  | 'defined';

/**
 * A name typed in a naming field: the path it makes (a skill's folder, with its slash, for a
 * skill's new name), or why it cannot be made, with the path it clashes with. A rename to the
 * file's own name is fine, and does nothing.
 */
export type NameCheck =
  | { ok: true; path: string }
  | { ok: false; problem: NameProblem; path: string | null };

const CONTROL = /\p{Cc}/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function checkNaming(target: NamingTarget, text: string, facts: NameFacts): NameCheck {
  if (text === '') return { ok: false, problem: 'empty', path: null };
  const refused = (problem: NameProblem, path: string | null = null): NameCheck => ({
    ok: false,
    problem,
    path,
  });

  if (target.type === 'new' && target.kind === 'skill') return checkSkill(text, null, facts);
  if (target.type === 'rename-skill') return checkSkill(text, target.skill, facts);

  const own = target.type === 'rename' ? target.path : null;
  const { before, after } = namingParts(target);
  const kind = target.type === 'new' ? target.kind : own ? kindOfPath(own) : 'skill-file';
  if (kind === 'skill-file') {
    if (text.includes('\\') || CONTROL.test(text) || LONE_SURROGATE.test(text)) {
      return refused('path');
    }
    if (text.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      return refused('path');
    }
  } else if (!NAME_RULE.test(text)) {
    return refused('rule');
  }
  const path = before + text + after;
  if (path.length > PATH_MAX) return refused('long');
  if (path === own) return { ok: true, path };
  if (facts.live.has(path)) return refused('taken', path);
  if (facts.removed.has(path)) return refused('removed', path);
  if (kind === 'automation' && facts.definedAutomations.includes(text)) {
    return refused('defined', path);
  }
  return { ok: true, path };
}

/** A skill's name, new (`own` null) or a skill's new one: free only while no path is inside it. */
function checkSkill(text: string, own: string | null, facts: NameFacts): NameCheck {
  if (!NAME_RULE.test(text)) return { ok: false, problem: 'rule', path: null };
  const folder = `skills/${text}/`;
  const made = own === null ? `${folder}SKILL.md` : folder;
  if (text === own) return { ok: true, path: made };
  const inside = (paths: ReadonlySet<string>) => [...paths].some((path) => path.startsWith(folder));
  if (inside(facts.live)) return { ok: false, problem: 'taken', path: folder };
  if (inside(facts.removed)) return { ok: false, problem: 'removed', path: folder };
  return { ok: true, path: made };
}
