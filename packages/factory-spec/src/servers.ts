/**
 * `mcpServers:` in `factory.yml` — the MCP servers the engine itself calls
 * through a `uses:` step: one it starts (stdio, `command`) or one it calls
 * (Streamable HTTP, `url`). Every key that would run something outside the
 * approved version, or put a credential in the file, is refused with its
 * reason. Read server by server, so one broken server is an issue at its own
 * key while its siblings, and the file's automations, still read.
 *
 * Imports `envNames.ts`, `secrets.ts` and `run.ts` (its `stableStringify`),
 * never `steps.ts`.
 */
import { createHash } from 'node:crypto';
import { ENV_NAME_PATTERN, isRefusedEnvName, REFUSED_ENV_LIST } from './envNames';
import { stableStringify } from './run';
import { parseSecretNames } from './secrets';

export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_SERVERS = 20;
export const MAX_SERVER_ARGS = 50;

interface ServerCommon {
  name: string;
  /** One line, shown on the card; present only when written. */
  description?: string;
  /** Its secrets, by name: a stdio server's environment, or `${NAME}` in a remote one's headers; present only when written and non-empty. */
  secrets?: string[];
}

export type McpServerDefinition =
  | (ServerCommon & {
      transport: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
    })
  | (ServerCommon & { transport: 'http'; url: string; headers: Record<string, string> });

export interface ServersParse {
  /** The valid servers, by name. */
  servers: Record<string, McpServerDefinition>;
  /** Names written under `mcpServers:` that have an issue: a step naming one has "problems of its own". */
  broken: string[];
  /** Not refusals: the unpinned-package warning, at `[<name>, 'args', <i>]`. */
  warnings: Array<{ message: string; path: Array<string | number> }>;
}

type Fail = (message: string, path: Array<string | number>) => void;

const NOT_A_MAPPING = 'Expected `mcpServers:` to be a mapping of server name to its definition.';
const NOT_A_SERVER = 'Expected a server: a mapping with `command` or `url`.';
const NAME_WORDS = 'Use lowercase letters, digits and dashes, starting with a letter, e.g. slack.';
const CONSOLA_WORDS = "`consola` is Consola's own tools; name this server something else.";
const EXACTLY_ONE =
  'A server has exactly one of `command` (a program Consola starts) or `url` (a server Consola calls).';
const CREDENTIAL =
  'This looks like a credential written into the file. Name it in `secrets:` and bind it on each runner.';
const UNPINNED = 'This runs the newest version at every call, unattended; pin one.';
const NUMBER_IN_QUOTES = 'Expected text: write a number in quotes, e.g. "8080".';
const SIGN_IN =
  'A sign-in for the engine is not supported yet: give the server a token in `secrets:`.';

/** Keys a server may not have, each with why (the spec's *Refusals*). */
const REFUSED_KEYS: Readonly<Record<string, string>> = {
  headersHelper:
    'A helper is a command Consola would run on your machine to make headers, and it would be outside what you approved. Put the token in `secrets:` and use it in `headers:`.',
  cwd: 'Consola decides where a server starts, and it is never a checkout.',
  oauth: SIGN_IN,
  auth: SIGN_IN,
  timeout: 'Set `timeout:` on the step that calls it.',
};
const KEYS = new Set([
  'command',
  'args',
  'env',
  'url',
  'headers',
  'secrets',
  'description',
  'type',
]);

/** A header name: an HTTP token. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** Headers that carry a credential whatever else they hold. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);
/** An `env:` name that reads as a credential's (slice 3's list). */
const CREDENTIAL_ENV_NAME = /TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
/** The hosts a plain `http://` URL may name: this machine's own. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `mcpServers:` as written; `undefined` or YAML null is no servers. Issues at paths under `[<name>, …]`. */
export function parseMcpServers(raw: unknown, fail: Fail): ServersParse {
  const result: ServersParse = { servers: {}, broken: [], warnings: [] };
  if (raw === undefined || raw === null) return result;
  if (!isRecord(raw)) {
    fail(NOT_A_MAPPING, []);
    return result;
  }
  const names = Object.keys(raw);
  if (names.length > MAX_SERVERS) {
    fail(`\`mcpServers:\` defines at most ${MAX_SERVERS} servers.`, []);
    result.broken = names;
    return result;
  }
  for (const name of names) {
    let ok = true;
    const bad = (message: string, path: Array<string | number> = []) => {
      ok = false;
      fail(message, [name, ...path]);
    };
    if (!MCP_SERVER_NAME_PATTERN.test(name)) bad(NAME_WORDS);
    else if (name === 'consola') bad(CONSOLA_WORDS);
    const definition = parseServer(name, raw[name], bad, (message, path) =>
      result.warnings.push({ message, path: [name, ...path] }),
    );
    if (ok && definition) result.servers[name] = definition;
    else result.broken.push(name);
  }
  return result;
}

function parseServer(
  name: string,
  raw: unknown,
  bad: (message: string, path?: Array<string | number>) => void,
  warn: (message: string, path: Array<string | number>) => void,
): McpServerDefinition | null {
  if (!isRecord(raw)) {
    bad(NOT_A_SERVER);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (own(REFUSED_KEYS, key)) bad(REFUSED_KEYS[key], [key]);
    else if (!KEYS.has(key)) bad(`Unrecognized key in a server: \`${key}\`.`, [key]);
  }
  let type: 'stdio' | 'http' | undefined;
  if ('type' in raw) {
    if (raw.type === 'sse') {
      bad(
        "The HTTP+SSE transport is deprecated (MCP 2025-03-26). Point `url` at the server's Streamable HTTP endpoint, usually `/mcp`.",
        ['type'],
      );
    } else if (raw.type === 'stdio' || raw.type === 'http') type = raw.type;
    else bad('Consola speaks MCP over stdio and Streamable HTTP.', ['type']);
  }
  if ('command' in raw === 'url' in raw) {
    bad(EXACTLY_ONE);
    return null;
  }
  const transport = 'command' in raw ? 'stdio' : 'http';
  if (type !== undefined && type !== transport) {
    bad(`\`type: ${type}\` does not match: \`stdio\` needs \`command\`, \`http\` needs \`url\`.`, [
      'type',
    ]);
  }
  let description: string | undefined;
  if ('description' in raw) {
    if (typeof raw.description === 'string' && !/[\r\n]/.test(raw.description)) {
      description = raw.description;
    } else bad('`description` is one line of text.', ['description']);
  }
  const common = (secrets: string[] | null): ServerCommon => ({
    name,
    ...(description !== undefined ? { description } : {}),
    ...(secrets && secrets.length > 0 ? { secrets } : {}),
  });
  const secretsOf = (envNames: readonly string[]) =>
    'secrets' in raw
      ? parseSecretNames(
          raw.secrets,
          (message, path = []) => bad(message, ['secrets', ...path]),
          envNames,
          'server',
        )
      : [];

  if (transport === 'stdio') {
    if ('headers' in raw) bad('`headers` is for a server Consola calls (`url`).', ['headers']);
    const command = readCommand(raw.command, bad);
    const args = readArgs(raw.args, bad);
    const env = readEnv(raw.env, bad);
    const secrets = secretsOf(Object.keys(env));
    if (command !== null && args !== null) {
      const unpinned = unpinnedLauncher(command, args);
      if (unpinned) warn(UNPINNED, ['args', unpinned.at]);
    }
    if (command === null || args === null) return null;
    return { ...common(secrets), transport, command, args, env };
  }

  for (const key of ['args', 'env']) {
    if (key in raw) bad(`\`${key}\` is for a server Consola starts (\`command\`).`, [key]);
  }
  const url = readUrl(raw.url, bad);
  const secrets = secretsOf([]);
  const headers = readHeaders(raw.headers, secrets, bad);
  if (url === null) return null;
  return { ...common(secrets), transport, url, headers };
}

function readCommand(
  raw: unknown,
  bad: (message: string, path?: Array<string | number>) => void,
): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    bad('Expected `command` to be a program: a name on your `PATH`, or an absolute path.', [
      'command',
    ]);
    return null;
  }
  if (raw.includes('/') && !raw.startsWith('/')) {
    bad(
      `\`${raw}\` would run whatever is at that path in the folder the server starts in. Use an absolute path, or a program on your \`PATH\`.`,
      ['command'],
    );
    return null;
  }
  return raw;
}

function readArgs(
  raw: unknown,
  bad: (message: string, path?: Array<string | number>) => void,
): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    bad('Expected `args` to be a list of text.', ['args']);
    return null;
  }
  if (raw.length > MAX_SERVER_ARGS) {
    bad(`A server takes at most ${MAX_SERVER_ARGS} \`args\`.`, ['args']);
    return null;
  }
  let ok = true;
  raw.forEach((arg: unknown, index) => {
    if (typeof arg !== 'string') {
      ok = false;
      bad(NUMBER_IN_QUOTES, ['args', index]);
    } else if (arg.includes('${') || arg.includes('{{')) {
      ok = false;
      bad(
        'An argument is visible to every process on this Mac, so it takes no `${…}` or `{{ }}`: name the secret in `secrets:`, which reaches the server as its environment.',
        ['args', index],
      );
    }
  });
  return ok ? (raw as string[]) : null;
}

/** The valid entries of a server's `env:`; every other one is reported. */
function readEnv(
  raw: unknown,
  bad: (message: string, path?: Array<string | number>) => void,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (raw === undefined) return env;
  if (!isRecord(raw)) {
    bad('Expected `env` to be a mapping of NAME to text.', ['env']);
    return env;
  }
  for (const [name, value] of Object.entries(raw)) {
    const at = ['env', name];
    if (name.startsWith('CONSOLA_')) {
      bad("`CONSOLA_` is Consola's own namespace; pick another name.", at);
    } else if (!ENV_NAME_PATTERN.test(name)) {
      bad('Use uppercase letters, digits and underscores, e.g. PR_NUMBER.', at);
    } else if (isRefusedEnvName(name)) {
      bad(
        `\`${name}\` is refused: these names and prefixes are refused because they make a program run a value: ${REFUSED_ENV_LIST}.`,
        at,
      );
    } else if (typeof value !== 'string') bad(NUMBER_IN_QUOTES, at);
    else if (value.includes('{{') || value.includes('${')) {
      bad("A server's `env:` is literal: name a secret in `secrets:` instead.", at);
    } else if (looksLikeCredential(name, value)) bad(CREDENTIAL, at);
    else env[name] = value;
  }
  return env;
}

/** A credential's name (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `*_KEY`) and a credential's value: 16 characters or more, no space. */
function looksLikeCredential(name: string, value: string): boolean {
  const named = CREDENTIAL_ENV_NAME.test(name) || name.endsWith('_KEY');
  return named && value.length >= 16 && !/\s/.test(value);
}

function readUrl(
  raw: unknown,
  bad: (message: string, path?: Array<string | number>) => void,
): string | null {
  const words = '`url` is `https://…`, or `http://` on 127.0.0.1, localhost or [::1].';
  if (typeof raw !== 'string') {
    bad(words, ['url']);
    return null;
  }
  if (raw.includes('${')) {
    bad('A URL is shown and logged as it is, so it takes no `${…}`: put the secret in a header.', [
      'url',
    ]);
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    bad(words, ['url']);
    return null;
  }
  const allowed =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!allowed) {
    bad(words, ['url']);
    return null;
  }
  return raw;
}

/** The valid headers; every other one is reported. `secrets` null: they did not read, so no `${NAME}` is checked against them. */
function readHeaders(
  raw: unknown,
  secrets: readonly string[] | null,
  bad: (message: string, path?: Array<string | number>) => void,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (raw === undefined) return headers;
  if (!isRecord(raw)) {
    bad('Expected `headers` to be a mapping of header name to text.', ['headers']);
    return headers;
  }
  for (const [name, value] of Object.entries(raw)) {
    const at = ['headers', name];
    if (!HEADER_NAME_PATTERN.test(name)) {
      bad(`\`${name}\` is not a header name.`, at);
      continue;
    }
    if (typeof value !== 'string') {
      bad(NUMBER_IN_QUOTES, at);
      continue;
    }
    if (/[\r\n]/.test(value)) {
      bad("A header's value is one line.", at);
      continue;
    }
    if (value.includes('{{')) {
      bad("A header takes `${NAME}` for one of the server's secrets, never `{{ }}`.", at);
      continue;
    }
    const refs = secretRefsOf(value);
    if (refs.length === 0 && isCredentialHeader(name)) {
      bad(CREDENTIAL, at);
      continue;
    }
    const missing = secrets === null ? undefined : refs.find((ref) => !secrets.includes(ref));
    if (missing !== undefined) {
      bad(
        `\`\${${missing}}\` is not one of this server's \`secrets:\`; add it there, or write the value as it is.`,
        at,
      );
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

/** The text inside each `${…}` of a header's value, in order (an unclosed one runs to the end). */
function secretRefsOf(value: string): string[] {
  const refs: string[] = [];
  let from = value.indexOf('${');
  while (from !== -1) {
    const end = value.indexOf('}', from + 2);
    refs.push(value.slice(from + 2, end === -1 ? undefined : end));
    from = end === -1 ? -1 : value.indexOf('${', end + 1);
  }
  return refs;
}

function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return CREDENTIAL_HEADERS.has(lower) || lower.endsWith('-api-key');
}

/** `sha256(stableStringify(definition))`, its first 16 hex: what the version of an entry using it holds (M9). */
export function serverHash(definition: McpServerDefinition): string {
  return createHash('sha256').update(stableStringify(definition)).digest('hex').slice(0, 16);
}

/** A package pinned to an exact version: `@1.2.3` (a prerelease allowed), or `==<version>` for `uvx`. */
const PINNED = /@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const UV_PINNED = /==\d[0-9A-Za-z.+-]*$/;

/** The launcher whose package is unpinned (`npx`, `uvx`, `bunx`, `pnpm dlx`, `yarn dlx`), or null. */
export function unpinnedLauncher(
  command: string,
  args: readonly string[],
): { launcher: string; at: number } | null {
  const program = command.split('/').pop() ?? command;
  const operands = args.flatMap((arg, at) => (arg.startsWith('-') ? [] : [{ arg, at }]));
  let launcher: string;
  let package_: { arg: string; at: number } | undefined;
  if (program === 'npx' || program === 'uvx' || program === 'bunx') {
    launcher = program;
    package_ = operands[0];
  } else if (program === 'pnpm' || program === 'yarn') {
    if (operands[0]?.arg !== 'dlx') return null;
    launcher = `${program} dlx`;
    package_ = operands[1];
  } else return null;
  if (package_ === undefined) return null;
  const pinned = PINNED.test(package_.arg) || (program === 'uvx' && UV_PINNED.test(package_.arg));
  return pinned ? null : { launcher, at: package_.at };
}
