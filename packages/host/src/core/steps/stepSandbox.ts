/**
 * A step's sandbox: where things are in it, what each command there is given, and what comes
 * back. One sandbox per attempt, from the `consola-session` template (the host's bundle, Node,
 * git, `gh` and the agent CLIs), made with no variables of its own: each command gets its own,
 * so the clone token reaches the checkout alone, the API key the host alone, and a command step's
 * command exactly what its request names. Pure.
 */
import { isRepository } from '@consola/runner-protocol';
import { HARNESS_API_KEYS, SESSION_TEMPLATE } from '../runnerDecisions.ts';
import type { CommandStepRequest, StepCheckout } from './ports.ts';
import { STEP_TOOL_CLI_NAMES, STEP_TOOL_SERVER } from './stepTools.ts';

/** The template a step's sandbox starts from: the sessions' (`sandbox-template/`). */
export const STEP_TEMPLATE = SESSION_TEMPLATE;

/** The step's place in its sandbox. */
export const STEP_WORKSPACE = '/workspace';
/** Where the checkout is, or an empty folder for a step with none. */
export const STEP_REPO = `${STEP_WORKSPACE}/repo`;
/** An agent step's folder: its declaration, and the outputs and documents its tools write. */
export const STEP_TOOLS_FOLDER = `${STEP_WORKSPACE}/.consola/step`;
/** A command step's folder: its request's `files`, each at its `path` under it. */
export const COMMAND_FILES_FOLDER = `${STEP_WORKSPACE}/.consola/attempt`;
/** A command step's `$CONSOLA_OUTPUT`, outside its files' folder so no `path` can be it. */
export const COMMAND_OUTPUT_FILE = `${STEP_WORKSPACE}/.consola/outputs.env`;

/** The template's checkout script (`sandbox-template/consola-step-checkout`). */
export const STEP_CHECKOUT_ARGV: readonly string[] = ['consola-step-checkout'];
/** The template's script that becomes an agent step's host (`sandbox-template/consola-step-start`). */
export const STEP_HOST_ARGV: readonly string[] = ['consola-step-start'];
/** How a command step's command runs. */
export const commandArgv = (command: string): string[] => ['bash', '-c', command];

/** The most `$CONSOLA_OUTPUT` holds that is read, as the engine's `OUTPUT_FILE_CAP_BYTES`. */
export const OUTPUT_FILE_CAP_BYTES = 64 * 1024;

const COMMIT = /^[0-9a-f]{40}$/;

/** Why a checkout cannot be asked for, or null. Names no value but the repository's. */
export function checkoutProblem(checkout: StepCheckout): string | null {
  if (!isRepository(checkout.repository)) {
    return `The step's checkout names ${JSON.stringify(String(checkout.repository).slice(0, 100))}, which is not a repository as owner/name.`;
  }
  if (!COMMIT.test(checkout.commit)) {
    return "The step's checkout commit is not 40 lowercase hexadecimal characters.";
  }
  if (
    checkout.pullRequest !== null &&
    (!Number.isSafeInteger(checkout.pullRequest) || checkout.pullRequest < 1)
  ) {
    return "The step's checkout pull request is not a pull request's number.";
  }
  if (checkout.baseRef !== null && !isBranchName(checkout.baseRef)) {
    return "The step's checkout base branch is not a branch's name.";
  }
  return null;
}

/**
 * Whether `name` is a branch name git takes, kept to the plain ones: letters, digits and `._/-`,
 * no part starting with `-` or `.`, no `..`, `//` or `@{`, not ending in `/`, `.` or `.lock`. The
 * checkout script asks git as well (`git check-ref-format --branch`).
 */
export const isBranchName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 255 &&
  /^[A-Za-z0-9._/-]+$/.test(name) &&
  name.split('/').every((part) => part !== '' && !part.startsWith('-') && !part.startsWith('.')) &&
  !name.includes('..') &&
  !name.endsWith('.lock') &&
  !name.endsWith('.');

/** The document an agent step on a pull request reads its changes from. */
export const CHANGES_DOCUMENT = 'changes';
/** Where the checkout script writes it. */
export const CHANGES_FILE = `${STEP_WORKSPACE}/.consola/changes.md`;
/**
 * The most it holds, in UTF-8 bytes: the file list whole, the diff cut to what is left, with a
 * last line that says how much was left out.
 */
export const CHANGES_MAX_BYTES = 512 * 1024;

/** Whether an agent step gets its pull request's changes: it has a pull request and its base. */
export const wantsChanges = (checkout: StepCheckout | null): boolean =>
  checkout !== null && checkout.pullRequest !== null && checkout.baseRef !== null;

/**
 * What the checkout script is given: the repository, the commit, the pull request whose head it
 * fetches, and the token for the clone, which no other command in the sandbox sees. With
 * `changes`, the pull request's base branch too, which it fetches to write the changes document
 * (`CHANGES_FILE`).
 */
export function checkoutEnv(
  checkout: StepCheckout,
  cloneToken: string | null,
  options: { readonly changes: boolean } = { changes: false },
): Record<string, string> {
  return {
    CONSOLA_REPOSITORY: checkout.repository,
    CONSOLA_CHECKOUT_COMMIT: checkout.commit,
    ...(checkout.pullRequest === null
      ? {}
      : { CONSOLA_CHECKOUT_PULL_REQUEST: String(checkout.pullRequest) }),
    ...(options.changes && wantsChanges(checkout) && checkout.baseRef !== null
      ? {
          CONSOLA_CHECKOUT_BASE_REF: checkout.baseRef,
          CONSOLA_CHANGES_MAX_BYTES: String(CHANGES_MAX_BYTES),
        }
      : {}),
    ...(cloneToken === null || cloneToken === '' ? {} : { GIT_TOKEN: cloneToken }),
  };
}

/** The line a cut document ends with: how much was left out, as the engine words it. */
export const cutLine = (leftOutBytes: number): string =>
  `[cut here: the rest is ${Math.ceil(leftOutBytes / 1024)} KB more (${leftOutBytes} bytes)]`;

/**
 * The changes document as the runner hands it to the step, from what the sandbox wrote (data:
 * the checkout script bounds it, and the runner bounds it again, on a character's edge, with
 * `cutLine`). With nothing written, one line that says the changes are missing.
 */
export function changesDocument(written: string | null, checkout: StepCheckout): string {
  if (written === null || written.trim() === '') {
    return `The changes of pull request #${checkout.pullRequest ?? ''} were not prepared: the checkout wrote nothing.`;
  }
  // A cut in the sandbox may leave half a character, which decoding made U+FFFD.
  const text = written.replace(/�$/, '');
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= CHANGES_MAX_BYTES) return text;
  let cut = CHANGES_MAX_BYTES;
  while (cut > 0 && ((encoded[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  const kept = new TextDecoder().decode(encoded.subarray(0, cut));
  return `${kept}\n${cutLine(encoded.length - cut)}`;
}

/** The pass the runner signs for its own client of a step's host: names no person or workspace. */
export const STEP_PASS_SUBJECT = 'consola-runner';
export const STEP_PASS_WORKSPACE = 'consola-step';

/** Where the template keeps Node and the host's bundle (`sandbox-template/Dockerfile`). */
export const TEMPLATE_NODE = '/usr/local/bin/node';
export const TEMPLATE_HOST_BUNDLE = '/opt/consola/consola-host.mjs';

/** An agent step's host keeps t3's state here, its settings in `userdata/settings.json`. */
export const STEP_STATE_DIR = `${STEP_WORKSPACE}/.consola/t3-state`;
export const STEP_T3_SETTINGS_FILE = `${STEP_STATE_DIR}/userdata/settings.json`;
/** The CLI's MCP config for a step: the step tools' server and no other. */
export const STEP_MCP_CONFIG_FILE = `${STEP_WORKSPACE}/.consola/step-mcp.json`;
/** The title an agent step's thread opens with, so its CLI is never asked for one. */
export const STEP_THREAD_TITLE = 'Consola step';

/**
 * The checkout's own Claude settings, which the step's start script takes out of the working tree
 * before the host runs: t3 starts Claude in the folder without `--restricted` for one thing, its
 * workspace probe (user, project and local setting sources, no turn), and a settings file there
 * can set the CLI's environment or name commands it runs (a credential helper). The step reads
 * what its pull request changes in them from its `changes` document.
 */
export const CHECKOUT_CLAUDE_SETTINGS: readonly string[] = [
  '.claude/settings.json',
  '.claude/settings.local.json',
];

/**
 * The CLI's launch arguments in a step, which t3 passes on every turn (its Claude instance's
 * `launchArgs`): the step tools' MCP config and no other server (`--strict-mcp-config`: not the
 * checkout's `.mcp.json`, not the user's), the four step tools allowed with no approval, and
 * `--restricted`, last, which keeps the checkout's settings, hooks, permission rules, servers,
 * plugins, skills and CLAUDE.md out, drops the tools that run code and WebFetch, and confines the
 * file tools to the folder (the desktop's `readOnlyArgs`, checked against the real CLI by its
 * canary's row 3). Each only narrows what the CLI loads, runs or asks about: none sets a
 * permission mode, so the thread's `approval-required` holds.
 */
export const STEP_LAUNCH_ARGS = [
  '--strict-mcp-config',
  '--mcp-config',
  STEP_MCP_CONFIG_FILE,
  '--allowedTools',
  STEP_TOOL_CLI_NAMES.join(','),
  '--restricted',
].join(' ');

/** Launch flags that would widen what the CLI may do or load: none is ever in `STEP_LAUNCH_ARGS`. */
export const LOOSENING_LAUNCH_FLAGS: readonly string[] = [
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-prompt-tool',
  '--settings',
  '--setting-sources',
  '--tools',
  '--add-dir',
  '--plugin-dir',
];

/** t3's settings for a step's host (`STEP_T3_SETTINGS_FILE`): no update checks, and Claude's launch arguments. */
export function stepT3Settings(): Record<string, unknown> {
  return {
    enableProviderUpdateChecks: false,
    providerInstances: {
      claudeAgent: { driver: 'claudeAgent', config: { launchArgs: STEP_LAUNCH_ARGS } },
    },
  };
}

/**
 * The CLI's MCP config for a step: the step tools' server, from the host's bundle, started through
 * `env -u ANTHROPIC_API_KEY`, so the server, which needs no key, never holds it.
 */
export function stepMcpConfig(folder: string = STEP_TOOLS_FOLDER): Record<string, unknown> {
  return {
    mcpServers: {
      [STEP_TOOL_SERVER]: {
        type: 'stdio',
        command: '/usr/bin/env',
        args: [
          '-u',
          HARNESS_API_KEYS.claude,
          TEMPLATE_NODE,
          TEMPLATE_HOST_BUNDLE,
          'step-tools',
          '--folder',
          folder,
        ],
      },
    },
  };
}

/** A JSON file's text, for one of the files the runner writes into a step's sandbox. */
export const jsonFileText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** What an agent step's host is started with: its session, the key its passes are checked with, the step's folder and the API key. */
export function stepHostEnv(input: {
  readonly sessionId: string;
  readonly passPublicKeyPem: string;
  readonly apiKey: string;
  readonly idleMinutes: number;
}): Record<string, string> {
  return {
    CONSOLA_SESSION_ID: input.sessionId,
    CONSOLA_HARNESS: 'claude',
    CONSOLA_PASS_PUBLIC_KEY: input.passPublicKeyPem,
    CONSOLA_SESSION_IDLE_MINUTES: String(input.idleMinutes),
    CONSOLA_STEP_FOLDER: STEP_TOOLS_FOLDER,
    [HARNESS_API_KEYS.claude]: input.apiKey,
  };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Whether `path` names a file inside the attempt's folder: relative segments, no `.` or `..`. */
export const isFilePath = (path: string): boolean => {
  const segments = path.split('/');
  return (
    path.length <= 512 &&
    segments.every((segment) => PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
  );
};

/** What a command step writes and runs with, or why it cannot run. */
export type CommandPlan =
  | {
      readonly ok: true;
      /** Each file at its absolute path in the sandbox. */
      readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
      /** Exactly the command's variables: `env`, then `secretEnv`, then `fileEnv`, then `CONSOLA_OUTPUT`. */
      readonly env: Readonly<Record<string, string>>;
      /** Where it runs. */
      readonly cwd: string;
    }
  | { readonly ok: false; readonly problem: string };

/**
 * What a command step's request becomes in its sandbox. Each file at its `path` under the
 * attempt's folder; each `fileEnv` variable the absolute path of the file whose `path` it names;
 * `CONSOLA_OUTPUT` Consola's own, last, so the request cannot point it elsewhere. A name or a
 * path it cannot take is refused before any sandbox is made, by name, never by value.
 */
export function commandPlan(request: CommandStepRequest): CommandPlan {
  const refuse = (problem: string): CommandPlan => ({ ok: false, problem });
  const files: Array<{ path: string; content: string }> = [];
  const byPath = new Map<string, string>();
  for (const file of request.files) {
    if (!isFilePath(file.path)) {
      return refuse(
        `The step's file ${JSON.stringify(file.path.slice(0, 100))} is not a path inside its folder.`,
      );
    }
    if (byPath.has(file.path)) {
      return refuse(`The step names the file ${file.path} twice.`);
    }
    const absolute = `${COMMAND_FILES_FOLDER}/${file.path}`;
    byPath.set(file.path, absolute);
    files.push({ path: absolute, content: file.content });
  }
  const groups = [request.env, request.secretEnv, request.fileEnv];
  for (const group of groups) {
    for (const name of Object.keys(group)) {
      if (!ENV_NAME.test(name)) {
        return refuse(
          `The step's variable ${JSON.stringify(name.slice(0, 64))} is not a variable name.`,
        );
      }
    }
  }
  const fileVariables: Record<string, string> = {};
  for (const [name, path] of Object.entries(request.fileEnv)) {
    const absolute = byPath.get(path);
    if (absolute === undefined) {
      return refuse(`The step's variable ${name} names a file the step does not write.`);
    }
    fileVariables[name] = absolute;
  }
  return {
    ok: true,
    files,
    env: {
      ...request.env,
      ...request.secretEnv,
      ...fileVariables,
      CONSOLA_OUTPUT: COMMAND_OUTPUT_FILE,
    },
    cwd: STEP_REPO,
  };
}

const OUTPUT_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * The `key=value` lines a command appended to `$CONSOLA_OUTPUT` (already masked): blank lines
 * ignored, each other line split at its first `=`, a trailing CR stripped, the last write of a key
 * winning. A line that is no `key=value` is left out; the engine judges what it got.
 */
export function readConsolaOutput(text: string): Record<string, string> {
  // A map, so a key such as `__proto__` is a key like any other.
  const outputs = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at);
    if (!OUTPUT_KEY.test(key)) continue;
    outputs.set(key, line.slice(at + 1));
  }
  return Object.fromEntries(outputs);
}
