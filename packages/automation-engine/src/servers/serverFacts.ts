/**
 * What a factory server is, as every view says it: what it starts or
 * calls, what its environment holds by name, which headers its secrets make,
 * and whether its package is pinned. The runner's policy lives here, in the
 * core, so the Node adapter and every view read one list.
 */
import { unpinnedLauncher, type McpServerDefinition } from '@consola/factory-spec';

/**
 * What a stdio server's environment starts from, taken from the runner's (on
 * the desktop, the login environment): the SDK's own list plus locale and
 * temp (spike V7). `LC_*` is every name starting `LC_`.
 */
export const SERVER_ENV_ALLOW_LIST: readonly string[] = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TERM',
  'LANG',
  'LC_*',
  'TMPDIR',
];

export interface ServerFacts {
  name: string;
  transport: 'stdio' | 'http';
  description?: string;
  /** The command and its args as one line, or the URL. */
  target: string;
  /** stdio: its environment by name: the allow-list, its `env:`, its secrets, in that order. */
  environment?: string[];
  /** http: each header made from a secret, and which. */
  secretHeaders?: Array<{ header: string; secrets: string[] }>;
  /** stdio through `npx`, `uvx`, `bunx`, `pnpm dlx` or `yarn dlx`: the card's dependency note. */
  launcher?: true;
  /** Its package has no exact version: the warning. */
  unpinned?: true;
  secrets?: string[];
}

/** Programs that fetch a package and run it. */
const LAUNCHERS = ['npx', 'uvx', 'bunx'];
const DLX_LAUNCHERS = ['pnpm', 'yarn'];

/** Whether a stdio server runs through a launcher that fetches its package: `npx`, `uvx`, `bunx`, `pnpm dlx`, `yarn dlx`. */
function isLauncher(command: string, args: readonly string[]): boolean {
  const program = command.split('/').pop() ?? command;
  if (LAUNCHERS.includes(program)) return true;
  return DLX_LAUNCHERS.includes(program) && args.find((arg) => !arg.startsWith('-')) === 'dlx';
}

/** The names `${NAME}` references in a header value, in order, once each, among `secrets`. */
function referencedSecrets(value: string, secrets: readonly string[]): string[] {
  const names: string[] = [];
  for (const found of value.matchAll(/\$\{([^}]*)\}/g)) {
    const name = found[1];
    if (secrets.includes(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

export function serverFactsOf(definition: McpServerDefinition): ServerFacts {
  const secrets = definition.secrets ?? [];
  const common = {
    name: definition.name,
    transport: definition.transport,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
  };
  const withSecrets = secrets.length > 0 ? { secrets: [...secrets] } : {};
  if (definition.transport === 'http') {
    const secretHeaders = Object.entries(definition.headers).flatMap(([header, value]) => {
      const named = referencedSecrets(value, secrets);
      return named.length > 0 ? [{ header, secrets: named }] : [];
    });
    return {
      ...common,
      target: definition.url,
      ...(secretHeaders.length > 0 ? { secretHeaders } : {}),
      ...withSecrets,
    };
  }
  const { command, args } = definition;
  return {
    ...common,
    target: [command, ...args].join(' '),
    environment: [...SERVER_ENV_ALLOW_LIST, ...Object.keys(definition.env), ...secrets],
    ...(isLauncher(command, args) ? { launcher: true as const } : {}),
    ...(unpinnedLauncher(command, args) !== null ? { unpinned: true as const } : {}),
    ...withSecrets,
  };
}
