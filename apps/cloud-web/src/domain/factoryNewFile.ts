/**
 * A new file's path on a factory's definition, checked as the person types it, by the rules the
 * cell stores a version by, so the editor never makes a file a save would refuse for its path.
 * The cell stays the authority: what it answers on Save still shows in the Problems panel.
 *
 * This is the page's own copy of those rules, not an import. The set's rules (a path inside the
 * folder, how long, how many files, no path twice) are the cell's
 * (`apps/cloud-region/src/domain/factory.ts`: `isFactoryPath`, `setIssues`, `FACTORY_PATH_MAX`,
 * `FACTORY_FILES_MAX`), which no app may import. Where a file goes and how it is named are
 * factory-spec's (`packages/factory-spec/src/factory.ts`: `storedFactoryFiles`, `strayMessage`,
 * `LATER_FOLDERS`; `names.ts`: `AUTOMATION_NAME_PATTERN`; the name sentences of
 * `automationFile.ts`, `agents.ts` and `skills.ts`), which `factoryCheck.ts` imports but this
 * module does not: factory-spec is CommonJS and carries YAML and zod, which the page loads late.
 * `factoryNewFile.test.ts` holds every placement sentence here equal to the parser's.
 *
 * What a file holds is not checked here: an empty agent or automation is a problem the parser
 * finds once the file is there, said in the Problems panel before Save, as any other.
 */

/** The most files a factory holds: the cell's `FACTORY_FILES_MAX`. */
export const FACTORY_FILES_MAX = 500;

/** The longest a file's path may be, in UTF-16 code units: the cell's `FACTORY_PATH_MAX`. */
export const FACTORY_PATH_MAX = 256;

/** A control character: a line break, a tab, an escape. */
const CONTROL = /\p{Cc}/u;

/** A UTF-16 surrogate with no partner, which no UTF-8 text can hold. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** factory-spec's `AUTOMATION_NAME_PATTERN`: an automation's, an agent's and a skill's name. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Where `storedFactoryFiles` puts a file, by its path. */
const STORED_AUTOMATION = /^automations\/([^/]+)\.yaml$/;
const STORED_AGENT = /^agents\/([^/]+)\.md$/;
const STORED_SKILL = /^skills\/([^/]+)\/(.+)$/;

/** factory-spec's `LATER_FOLDERS`: stored, with a notice that their files have no effect yet. */
const LATER_FOLDERS = ['connections', 'evals'];

/** What a new file's path came to. */
export type NewFilePathCheck =
  /** Nothing typed yet: nothing to say. */
  | { kind: 'empty' }
  /** It cannot be added: the sentence says why. */
  | { kind: 'refused'; message: string }
  /** It can: the path as it will be added, and the later slice's folder it sits in, if any. */
  | { kind: 'ok'; path: string; laterFolder: string | null };

/**
 * Whether `typed`, trimmed, can be added beside `paths` (the files the person sees now, those
 * they deleted left out). The cell's order: the set (how many files), then the path's shape, then
 * whether it is there already, then where it goes and what it is named.
 */
export function checkNewFilePath(typed: string, paths: readonly string[]): NewFilePathCheck {
  if (paths.length >= FACTORY_FILES_MAX) {
    return refused(`A factory holds at most ${FACTORY_FILES_MAX} files.`);
  }
  const path = typed.trim();
  if (path === '') return { kind: 'empty' };
  if (path.length > FACTORY_PATH_MAX) {
    return refused(`Keep the path to ${FACTORY_PATH_MAX} characters.`);
  }
  if (!isFactoryPath(path)) {
    return refused(
      `\`${path}\` is not a path inside a factory: name it like \`agents/reviewer.md\`, with no empty, \`.\` or \`..\` part.`,
    );
  }
  if (paths.includes(path)) return refused(`\`${path}\` is already a file in this factory.`);
  const misplaced = placementProblem(path);
  if (misplaced) return refused(misplaced);
  const folder = path.split('/')[0] ?? '';
  const later = path.includes('/') && LATER_FOLDERS.includes(folder) ? folder : null;
  return { kind: 'ok', path, laterFolder: later };
}

const refused = (message: string): NewFilePathCheck => ({ kind: 'refused', message });

/**
 * The cell's `isFactoryPath`, but for its length, which `checkNewFilePath` says on its own:
 * segments joined by `/`, none empty, `.` or `..`, no `\`, no control character and no lone
 * surrogate.
 */
function isFactoryPath(path: string): boolean {
  if (path.includes('\\') || CONTROL.test(path) || LONE_SURROGATE.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * What the parser says of a path, as `storedFactoryFiles` reads it: a file of the factory with a
 * name it refuses, or a stray. Null for a path it takes.
 */
function placementProblem(path: string): string | null {
  if (path === 'factory.yml') return null;
  const automation = STORED_AUTOMATION.exec(path);
  if (automation?.[1]) {
    return NAME.test(automation[1])
      ? null
      : `\`${path}\`: an automation's file name is its name: lowercase letters, digits and dashes, e.g. automations/investigate-alerts.yaml.`;
  }
  const agent = STORED_AGENT.exec(path);
  if (agent?.[1]) {
    return NAME.test(agent[1])
      ? null
      : `\`${path}\`: an agent's file name is its name: lowercase letters, digits and dashes, e.g. agents/investigator.md.`;
  }
  const skill = STORED_SKILL.exec(path);
  if (skill?.[1] && skill[2]) {
    return NAME.test(skill[1])
      ? null
      : `\`skills/${skill[1]}\`: a skill's folder name is its name: lowercase letters, digits and dashes, e.g. skills/incident-triage.`;
  }
  const folder = path.split('/')[0] ?? '';
  if (path.includes('/') && LATER_FOLDERS.includes(folder)) return null;
  return strayMessage(path);
}

/** factory-spec's `strayMessage`, word for word. */
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

/** A common start for a new file, which fills the folder before its name and the ending after. */
export type NewFileStart = {
  readonly id: 'automation' | 'agent';
  readonly prefix: string;
  readonly suffix: string;
};

/** The two starts the new file's field offers: an automation, then an agent. */
export const NEW_FILE_STARTS: readonly NewFileStart[] = [
  { id: 'automation', prefix: 'automations/', suffix: '.yaml' },
  { id: 'agent', prefix: 'agents/', suffix: '.md' },
];

/** An ending a person may have typed after a name, which a start replaces with its own. */
const TYPED_ENDING = /\.(?:ya?ml|md)$/;

/**
 * `typed` with `start` chosen: the start's folder and ending around the name already typed, and
 * where the caret goes, after the name. The name is what sits inside another start
 * (`agents/reviewer.md` keeps `reviewer`), or a bare name without its ending; anything else is
 * no name, and the caret lands between the folder and the ending.
 */
export function withStart(typed: string, start: NewFileStart): { value: string; caret: number } {
  const name = nameIn(typed.trim());
  return {
    value: `${start.prefix}${name}${start.suffix}`,
    caret: start.prefix.length + name.length,
  };
}

function nameIn(typed: string): string {
  for (const start of NEW_FILE_STARTS) {
    const fits =
      typed.length >= start.prefix.length + start.suffix.length &&
      typed.startsWith(start.prefix) &&
      typed.endsWith(start.suffix);
    if (fits) return typed.slice(start.prefix.length, typed.length - start.suffix.length);
  }
  return typed.includes('/') ? '' : typed.replace(TYPED_ENDING, '');
}
