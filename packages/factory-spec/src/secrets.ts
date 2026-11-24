/**
 * `secrets:` — the names of the secrets a command or a factory server needs.
 * The file names a secret; where its value lives is the runner's binding,
 * never the file's, so nothing here sees a value. A name follows `env:`'s
 * rules, since its value reaches the command (or a stdio server) as the
 * environment variable of that name, and a few more: Consola's own and the
 * harness's names, and gh's identity, which a command takes from the
 * workspace's bound account (a server never gets that token).
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
import type { Automation } from './schema';
import type { McpServerDefinition } from './servers';
import type { CommandStep, StepEntry, UsesStep } from './steps';
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

/**
 * gh's identity: a command acts as the workspace's bound account (decision
 * 37). gh also reads `GITHUB_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` when its own
 * are unset (a workspace with no bound account), so those are refused too
 * (review M2); `GH_ENTERPRISE_TOKEN` already is, by `env:`'s `GH_` prefix.
 */
const GH_IDENTITY_NAMES: ReadonlySet<string> = new Set<string>([
  'GH_TOKEN',
  'GH_HOST',
  'GITHUB_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]);
const GH_IDENTITY =
  "Commands act as the workspace's bound GitHub account, whose token Consola puts in `GH_TOKEN` (decision 37). To act as another account, bind it to the workspace.";

const PATTERN = 'Use uppercase letters, digits and underscores, e.g. PAGERDUTY_TOKEN.';

/** `env:`'s refused names and prefixes, as a secret's refusal lists them. */
const REFUSED_NAMES_LIST = `${REFUSED_ENV_NAMES.join(', ')}, and every name matching ${REFUSED_ENV_PREFIXES.map((prefix) => `${prefix}*`).join(', ')}`;

/** Where a secret's value goes: a command's environment, or a factory server's (its environment or its headers). */
export type SecretPlace = 'command' | 'server';

/**
 * Why `name` cannot be a secret in `place`, or null. Checked in `env:`'s order, then the secrets' own. gh's
 * identity is a command's only: a server never gets the bound account's token, so it has none to override.
 */
export function secretNameProblem(name: string, place: SecretPlace = 'command'): string | null {
  if (name.startsWith('CONSOLA_'))
    return "`CONSOLA_` is Consola's own namespace; pick another name.";
  if (!ENV_NAME_PATTERN.test(name)) return PATTERN;
  if (name.length > MAX_SECRET_NAME_LENGTH)
    return `A secret's name is at most ${MAX_SECRET_NAME_LENGTH} characters.`;
  if (place === 'command' && GH_IDENTITY_NAMES.has(name)) return GH_IDENTITY;
  if (name === 'CLAUDE_CONFIG_DIR')
    return "`CLAUDE_CONFIG_DIR` is the harness's own; a secret can't set it.";
  if (isRefusedEnvName(name))
    return `\`${name}\` is refused: a secret's name follows \`env:\`'s rules, and ${REFUSED_NAMES_LIST}, make a program run a value.`;
  return null;
}

/**
 * A command step's, a check's or a server's `secrets:` as written: the names
 * in order, `[]` for an empty list, null once anything was reported.
 * `envNames`: that step's or server's `env:` names, which a secret may not
 * repeat; `place`: where the values go (`secretNameProblem`).
 */
export function parseSecretNames(
  raw: unknown,
  fail: (message: string, path?: Array<string | number>) => void,
  envNames: readonly string[] = [],
  place: SecretPlace = 'command',
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
    else problem = secretNameProblem(name, place);
    if (problem === null) names.push(name as string);
    else {
      ok = false;
      fail(problem, [index]);
    }
  });
  return ok ? names : null;
}

/** One place an entry names a secret: a command step's, a call's server's, or its poll's check command's. */
export interface SecretUse {
  name: string;
  automation: string;
  step?: string;
  check?: true;
  /** A call's server: the value goes to it, not to a command. */
  server?: { name: string; transport: 'stdio' | 'http' };
}

type Servers = Readonly<Record<string, McpServerDefinition>>;

/** The entry's command steps and calls. On `main` an entry's steps are flat; slice 3's nested steps walk `leafSteps` here. */
function commandsAndCalls(automation: Automation): Array<CommandStep | UsesStep> {
  // Every leaf, a loop's steps included: `leafSteps`' walk, written here, since `steps.ts` imports this file.
  const entries: readonly StepEntry[] = automation.steps ?? [];
  return entries
    .flatMap((step) => (step.kind === 'repeat' ? step.steps : [step]))
    .filter((step): step is CommandStep | UsesStep => step.kind === 'run' || step.kind === 'uses');
}

/** The factory server a call names, when `servers` defines it (`consola` and an unknown name: none). */
function serverOf(step: UsesStep, servers: Servers | undefined): McpServerDefinition | undefined {
  return servers && Object.prototype.hasOwnProperty.call(servers, step.server)
    ? servers[step.server]
    : undefined;
}

/**
 * Every place an entry names a secret, in file order: each command step's and each call's server's (only
 * with the factory's `servers`), then its check's.
 */
export function secretUsesOf(automation: Automation, servers?: Servers): SecretUse[] {
  const uses: SecretUse[] = [];
  for (const step of commandsAndCalls(automation)) {
    if (step.kind === 'run') {
      for (const name of step.secrets ?? [])
        uses.push({ name, automation: automation.name, step: step.id });
      continue;
    }
    const server = serverOf(step, servers);
    if (!server) continue;
    for (const name of server.secrets ?? [])
      uses.push({
        name,
        automation: automation.name,
        step: step.id,
        server: { name: step.server, transport: server.transport },
      });
  }
  if (automation.trigger.kind === 'poll')
    for (const name of automation.trigger.secrets ?? [])
      uses.push({ name, automation: automation.name, check: true });
  return uses;
}

/**
 * The distinct names an entry uses, sorted. `runOnly`: what a run reads, so
 * not its check's; `dryRun`: what a dry run reads, only the names of its
 * `dry_run: run` commands and calls (a check is no part of a run either way);
 * `servers`: the factory's, whose secrets a call's server needs.
 */
export function secretNamesOf(
  automation: Automation,
  options: { runOnly?: boolean; dryRun?: boolean; servers?: Servers } = {},
): string[] {
  const names = new Set<string>();
  for (const step of commandsAndCalls(automation)) {
    if (options.dryRun && step.dryRun !== 'run') continue;
    const secrets = step.kind === 'run' ? step.secrets : serverOf(step, options.servers)?.secrets;
    for (const name of secrets ?? []) names.add(name);
  }
  if (!options.runOnly && !options.dryRun && automation.trigger.kind === 'poll')
    for (const name of automation.trigger.secrets ?? []) names.add(name);
  return [...names].sort();
}
