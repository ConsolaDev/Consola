/**
 * `secrets:` — the names of the secrets a command needs. The file names a
 * secret; where its value lives is the runner's binding, never the file's, so
 * nothing here sees a value. A name follows `env:`'s rules, since its value
 * reaches the command as the environment variable of that name, and a few
 * more: Consola's own and the harness's names, and gh's identity, which a
 * command takes from the workspace's bound account.
 *
 * Imports `envNames.ts` and `template.ts`, never `steps.ts`, which imports
 * this file.
 */
import {
  ENV_NAME_PATTERN,
  isRefusedEnvName,
  REFUSED_ENV_NAMES,
  REFUSED_ENV_PREFIXES,
} from './envNames';
import { secretPathProblem } from './template';

export const MAX_SECRET_NAME_LENGTH = 64;
export const MAX_SECRETS_PER_PLACE = 20;

/** Why an agent step and an agent file take no `secrets:` (the spec's words). */
export const AGENT_SECRETS_REASON =
  'A secret given to an agent can reach its model, its transcript and its pane. Give it to the command or server that needs it.';

/** Why an entry takes no `secrets:`. */
export const ENTRY_SECRETS_REASON = '`secrets:` goes on the step that needs it.';

/** The full sentence for `{{secrets.<name>}}`; `name` absent reads as NAME. */
export function secretTemplateReason(name?: string): string {
  const problem = secretPathProblem(name || 'NAME');
  return `${problem[0].toUpperCase()}${problem.slice(1)}.`;
}

/** gh's identity: a command acts as the workspace's bound account (decision 37). */
const GH_IDENTITY_NAMES: readonly string[] = ['GH_TOKEN', 'GH_HOST'];
const GH_IDENTITY =
  "Commands act as the workspace's bound GitHub account, whose token Consola puts in `GH_TOKEN` (decision 37). To act as another account, bind it to the workspace.";

const PATTERN = 'Use uppercase letters, digits and underscores, e.g. PAGERDUTY_TOKEN.';

/** `env:`'s refused names and prefixes, as a secret's refusal lists them. */
const REFUSED_NAMES_LIST = `${REFUSED_ENV_NAMES.join(', ')}, and every name matching ${REFUSED_ENV_PREFIXES.map((prefix) => `${prefix}*`).join(', ')}`;

/** Why `name` cannot be a command's secret, or null. Checked in `env:`'s order, then the secrets' own. */
export function secretNameProblem(name: string): string | null {
  if (name.startsWith('CONSOLA_'))
    return "`CONSOLA_` is Consola's own namespace; pick another name.";
  if (!ENV_NAME_PATTERN.test(name)) return PATTERN;
  if (name.length > MAX_SECRET_NAME_LENGTH)
    return `A secret's name is at most ${MAX_SECRET_NAME_LENGTH} characters.`;
  if (GH_IDENTITY_NAMES.includes(name)) return GH_IDENTITY;
  if (name === 'CLAUDE_CONFIG_DIR')
    return "`CLAUDE_CONFIG_DIR` is the harness's own; a secret can't set it.";
  if (isRefusedEnvName(name))
    return `\`${name}\` is refused: a secret's name follows \`env:\`'s rules, and ${REFUSED_NAMES_LIST}, make a program run a value.`;
  return null;
}

/**
 * A command step's or a check's `secrets:` as written: the names in order,
 * `[]` for an empty list, null once anything was reported. `envNames`: that
 * step's `env:` names, which a secret may not repeat.
 */
export function parseSecretNames(
  raw: unknown,
  fail: (message: string, path?: Array<string | number>) => void,
  envNames: readonly string[] = [],
): string[] | null {
  if (!Array.isArray(raw)) {
    fail('Expected `secrets` to be a list of names, e.g. `secrets: [PAGERDUTY_TOKEN]`.');
    return null;
  }
  if (raw.length > MAX_SECRETS_PER_PLACE) {
    fail(`\`secrets:\` names at most ${MAX_SECRETS_PER_PLACE} secrets.`);
    return null;
  }
  const names: string[] = [];
  let ok = true;
  raw.forEach((name: unknown, index) => {
    let problem: string | null;
    if (typeof name !== 'string') problem = PATTERN;
    else if (names.includes(name)) problem = `\`${name}\` is listed twice in \`secrets:\`.`;
    else if (envNames.includes(name))
      problem = `\`${name}\` is in both \`env:\` and \`secrets:\`; a value comes from one place.`;
    else problem = secretNameProblem(name);
    if (problem === null) names.push(name as string);
    else {
      ok = false;
      fail(problem, [index]);
    }
  });
  return ok ? names : null;
}
