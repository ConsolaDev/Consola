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
export const STEP_CHECKOUT_ARGV: ReadonlyArray<string> = ['consola-step-checkout'];
/** The template's script that becomes an agent step's host (`sandbox-template/consola-step-start`). */
export const STEP_HOST_ARGV: ReadonlyArray<string> = ['consola-step-start'];
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
  return null;
}

/**
 * What the checkout script is given: the repository, the commit, the pull request whose head it
 * fetches, and the token for the clone, which no other command in the sandbox sees.
 */
export function checkoutEnv(
  checkout: StepCheckout,
  cloneToken: string | null,
): Record<string, string> {
  return {
    CONSOLA_REPOSITORY: checkout.repository,
    CONSOLA_CHECKOUT_COMMIT: checkout.commit,
    ...(checkout.pullRequest === null
      ? {}
      : { CONSOLA_CHECKOUT_PULL_REQUEST: String(checkout.pullRequest) }),
    ...(cloneToken === null || cloneToken === '' ? {} : { GIT_TOKEN: cloneToken }),
  };
}

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
