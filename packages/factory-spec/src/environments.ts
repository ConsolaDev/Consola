/**
 * `environments/<name>.yaml` (slice 3-B, *The file › Environment files*):
 * where a write agent's commands run. `isolation: host` is a convention, the
 * person's own machine as they are; `isolation: sandbox` is the CLI's own
 * sandbox, with the hosts a step may reach (`network`) and the names of the
 * variables it gets from the person's login environment (`env`), and
 * nothing else. On `host` neither list could be enforced, so neither may be
 * written. A name that would make a program run its value, or that is
 * Consola's or the harness's own, is refused; so, until commands run in an
 * environment (3-C), is one that looks like a credential, since an
 * environment passes one to its commands only. `container`, `image` and
 * `setup` (slice 7) and `secrets` (slice 5) are refused with what they
 * arrive with. The hash is the file's say, not its spelling: what the
 * version of every entry whose agent names it covers.
 */
import { createHash } from 'node:crypto';
import { LineCounter, parseDocument } from 'yaml';
import { closestNode, formatPath, type FactorySpecIssue } from './issues';
import { stableStringify } from './run';
import { ENV_NAME_PATTERN, isRefusedEnvName } from './steps';
import { documentValue } from './yamlValue';

export interface EnvironmentDefinition {
  /** The file's name, `environments/<name>.yaml`. */
  name: string;
  isolation: 'host' | 'sandbox';
  /** Hosts a sandboxed step may reach: a name, or `*.` and a name. Empty: none. */
  network: string[];
  /** Names of the variables passed from the person's login environment. */
  env: string[];
  /** One line, shown on the card; present only when written. */
  description?: string;
  /** `environmentHash` of the parsed file. */
  hash: string;
}

/** The most hosts `network` and names `env` may list. */
export const MAX_ENVIRONMENT_ENTRIES = 50;

const KEYS = ['isolation', 'network', 'env', 'description'];

/** Keys a later slice owns, refused with what each arrives with. */
const LATER: Readonly<Record<string, string>> = {
  image: '`image` arrives with the headless runner (slice 7).',
  setup: '`setup` arrives with the headless runner (slice 7).',
  secrets: '`secrets` arrives with connections as data (slice 5).',
};

const ISOLATION = '`isolation:` is `host` or `sandbox`.';
const CONTAINER = '`isolation: container` arrives with the headless runner (slice 7).';
const ON_HOST =
  'On `host` a step has your whole network and environment; a list here would not be enforced. Use `isolation: sandbox` to limit them.';
const ROOT = 'An environment file holds keys, e.g. `isolation: sandbox`.';
const DESCRIPTION = '`description:` is one line of text.';

/**
 * Names an environment passes though `env:` on a step refuses them (review
 * of the spec's example): `NODE_ENV` is data, which the `NODE_` prefix
 * refuses for `NODE_OPTIONS` and the like.
 */
const PASSED_DESPITE_PREFIX: ReadonlySet<string> = new Set(['NODE_ENV']);

/** Variables that are Consola's or the harness's own: never the file's to pass. */
function isOwnName(name: string): boolean {
  return name.startsWith('CONSOLA_') || name === 'CLAUDE_CONFIG_DIR';
}

/** One label of a host name: letters, digits and inner dashes, at most 63. */
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Whether `entry` is a host `network` may list: a name of at least two
 * labels, or `*.` and such a name, with no scheme, port, path or address
 * (a name all of whose labels are digits is an IPv4 address), and a
 * wildcard over at least two labels (`*.com` is refused, as the CLI
 * refuses it).
 */
function isHostEntry(entry: unknown): boolean {
  if (typeof entry !== 'string' || entry.length > 253) return false;
  const name = entry.startsWith('*.') ? entry.slice(2) : entry;
  const labels = name.split('.');
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) return false;
  return !labels.every((label) => /^\d+$/.test(label));
}

/**
 * A guess by name at a variable that holds a credential: `*TOKEN*`,
 * `*SECRET*`, `*PASSWORD*`, `*PASSWD*`, `*CREDENTIAL*`, or ending `_KEY`,
 * `_PAT`, `_AUTH`, `_PASS`, or `DATABASE_URL` and ending `_DATABASE_URL`
 * (review M4). A guess: the card never calls what passes "no tokens".
 */
export function looksLikeCredential(name: string): boolean {
  if (/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/.test(name)) return true;
  if (/(_KEY|_PAT|_AUTH|_PASS)$/.test(name)) return true;
  return name === 'DATABASE_URL' || name.endsWith('_DATABASE_URL');
}

/** sha256 of what the file says (`stableStringify({ isolation, network, env, description })`), full hex. */
export function environmentHash(environment: Omit<EnvironmentDefinition, 'hash' | 'name'>): string {
  const { isolation, network, env, description } = environment;
  return createHash('sha256')
    .update(stableStringify({ isolation, network, env, description }))
    .digest('hex');
}

/** Why a name `env:` lists is refused, or null. */
function envNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !ENV_NAME_PATTERN.test(name))
    return `\`${String(name)}\` is not a variable name: capital letters, digits and \`_\`.`;
  if (isRefusedEnvName(name) && !PASSED_DESPITE_PREFIX.has(name))
    return `\`${name}\` makes a program run its value, so an environment does not pass it.`;
  if (isOwnName(name))
    return `\`${name}\` is Consola's or the harness's own; an environment does not pass it.`;
  if (looksLikeCredential(name))
    return `\`${name}\` looks like a credential, which an environment passes to its commands only, and no command runs in an environment yet.`;
  return null;
}

/**
 * `environments/<fileName>.yaml`, parsed and checked. Never throws. Each
 * issue names the file, the key (`env[1]`) and its line; with any issue
 * there is no environment.
 */
export function parseEnvironmentFile(
  fileName: string,
  text: string,
): { environment?: EnvironmentDefinition; issues: FactorySpecIssue[] } {
  const file = `environments/${fileName}.yaml`;
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const lineOf = (offset: number | undefined) =>
    offset === undefined ? undefined : lineCounter.linePos(offset).line;
  const issues: FactorySpecIssue[] = [];
  const issue = (message: string, path: Array<string | number> = []) => {
    const line = path.length === 0 ? 1 : lineOf(closestNode(doc, path)?.range?.[0]);
    issues.push({ message, file, path: formatPath(path), ...(line !== undefined ? { line } : {}) });
  };

  if (doc.errors.length > 0) {
    for (const error of doc.errors)
      issues.push({
        message: error.message.split('\n')[0].trim(),
        file,
        path: '',
        line: error.linePos?.[0]?.line ?? lineOf(error.pos?.[0]) ?? 1,
      });
    return { issues };
  }
  const value = documentValue(doc);
  if (!value.ok) {
    issue(value.message);
    return { issues };
  }
  // An empty file has no isolation, which is the first thing it must say.
  const root: unknown = value.value ?? {};
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    issue(ROOT);
    return { issues };
  }
  const fields = root as Record<string, unknown>;

  for (const key of Object.keys(fields)) {
    if (Object.prototype.hasOwnProperty.call(LATER, key)) issue(LATER[key], [key]);
    else if (!KEYS.includes(key)) issue(`Unrecognized key in an environment: \`${key}\`.`, [key]);
  }

  const { isolation } = fields;
  if (isolation === 'container') issue(CONTAINER, ['isolation']);
  else if (isolation !== 'host' && isolation !== 'sandbox')
    issue(ISOLATION, isolation === undefined ? [] : ['isolation']);

  const list = (key: 'network' | 'env', check: (entry: unknown) => string | null): string[] => {
    const raw = fields[key];
    if (raw === undefined) return [];
    if (isolation === 'host') {
      issue(ON_HOST, [key]);
      return [];
    }
    if (!Array.isArray(raw)) {
      issue(
        `\`${key}:\` is a list, e.g. \`${key}: [${key === 'env' ? 'CI' : 'registry.npmjs.org'}]\`.`,
        [key],
      );
      return [];
    }
    if (raw.length > MAX_ENVIRONMENT_ENTRIES) {
      issue(`\`${key}\` lists at most ${MAX_ENVIRONMENT_ENTRIES} entries.`, [key]);
      return [];
    }
    const seen = new Set<string>();
    raw.forEach((entry, index) => {
      const problem = check(entry);
      if (problem) issue(problem, [key, index]);
      else if (seen.has(String(entry).toLowerCase()))
        issue(`\`${String(entry)}\` is listed twice in \`${key}:\`.`, [key, index]);
      else seen.add(String(entry).toLowerCase());
    });
    return raw as string[];
  };
  const network = list('network', (entry) =>
    isHostEntry(entry)
      ? null
      : `\`${String(entry)}\` is not a host name: write a name (\`registry.npmjs.org\`) or \`*.\` and a name (\`*.githubusercontent.com\`), no scheme, port or address.`,
  );
  const env = list('env', envNameProblem);

  const { description } = fields;
  if (description !== undefined && (typeof description !== 'string' || /[\r\n]/.test(description)))
    issue(DESCRIPTION, ['description']);

  if (issues.length > 0) return { issues };
  const said = {
    isolation: isolation as 'host' | 'sandbox',
    network,
    env,
    ...(description !== undefined ? { description: description as string } : {}),
  };
  return { environment: { name: fileName, ...said, hash: environmentHash(said) }, issues };
}
