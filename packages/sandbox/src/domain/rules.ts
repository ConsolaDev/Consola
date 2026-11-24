import type { Command, CreateSandboxOptions } from './sandbox';

/**
 * The rules every request keeps, whichever provider serves it. Each returns what is wrong, as a
 * sentence, or null when nothing is. They check the values themselves rather than trust the
 * types, since a caller in plain JavaScript, or one that casts, passes whatever it has.
 */

/** An environment variable's name, as POSIX shells and `env` accept it. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quoted = (value: unknown): string => JSON.stringify(value) ?? String(value);

const hasNul = (value: string): boolean => value.includes('\u0000');

export function templateProblem(template: unknown): string | null {
  if (typeof template !== 'string' || template.trim() === '') {
    return 'A sandbox needs the name of the template it starts from.';
  }
  return null;
}

export function envProblem(env: unknown): string | null {
  if (env === undefined) return null;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return 'Environment variables are an object of names and values.';
  }
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) {
      return `${quoted(name)} is not a variable name: use letters, digits and _, not starting with a digit.`;
    }
    if (typeof value !== 'string') return `The variable ${name} needs a string value.`;
    if (hasNul(value))
      return `The variable ${name} holds a NUL character, which no program can receive.`;
  }
  return null;
}

/** A sandbox's lifetime: a whole number of seconds, at least one. */
export function lifetimeProblem(lifetimeSeconds: unknown): string | null {
  if (
    typeof lifetimeSeconds !== 'number' ||
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds < 1
  ) {
    return `${quoted(lifetimeSeconds)} is not a lifetime: a lifetime is a whole number of seconds, at least 1.`;
  }
  return null;
}

export function createOptionsProblem(options: CreateSandboxOptions): string | null {
  if (options === null || typeof options !== 'object') {
    return 'A sandbox needs the name of the template it starts from.';
  }
  const lifetime =
    options.lifetimeSeconds === undefined ? null : lifetimeProblem(options.lifetimeSeconds);
  const publicPorts =
    options.publicPorts === undefined || typeof options.publicPorts === 'boolean'
      ? null
      : `${quoted(options.publicPorts)} is not a choice of public ports: it is true or false.`;
  return templateProblem(options.template) ?? envProblem(options.env) ?? lifetime ?? publicPorts;
}

/** The id of a sandbox a request names. `doing` is what needs it: "Attaching", say. */
export function sandboxIdProblem(doing: string, sandboxId: unknown): string | null {
  if (typeof sandboxId === 'string' && sandboxId.trim() !== '') return null;
  return `${doing} needs the id of a sandbox.`;
}

/** A path in a sandbox: absolute, so it means the same in every provider. */
export function pathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return `${quoted(path)} is not an absolute path. Paths in a sandbox start with /.`;
  }
  if (hasNul(path)) return `The path ${quoted(path)} holds a NUL character.`;
  return null;
}

export function commandProblem(command: Command): string | null {
  if (command === null || typeof command !== 'object') return 'A command needs a program to run.';
  const { argv, cwd, env, onStdout, onStderr, keepOutput } = command;
  if (keepOutput !== undefined && typeof keepOutput !== 'boolean') {
    return 'keepOutput is true or false.';
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    return 'A command needs a program to run: argv names it first.';
  }
  if (typeof argv[0] !== 'string' || argv[0].trim() === '') {
    return 'A command needs a program to run: argv names it first.';
  }
  for (const [index, argument] of argv.entries()) {
    if (typeof argument !== 'string') return `Argument ${index} is not a string.`;
    if (hasNul(argument)) {
      return `Argument ${index} holds a NUL character, which no program can receive.`;
    }
  }
  if (cwd !== undefined) {
    const problem = pathProblem(cwd);
    if (problem) return `The command's folder: ${problem}`;
  }
  for (const [name, listener] of [
    ['onStdout', onStdout],
    ['onStderr', onStderr],
  ] as const) {
    if (listener !== undefined && typeof listener !== 'function')
      return `${name} is not a function.`;
  }
  return envProblem(env);
}

export function portProblem(port: unknown): string | null {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return `${quoted(port)} is not a port: ports are whole numbers from 1 to 65535.`;
  }
  return null;
}

/** An exit code a provider reports: a whole number from 0, or null for a command a signal ended. */
export function exitCodeProblem(exitCode: unknown): string | null {
  if (exitCode === null) return null;
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0) {
    return `The provider reported ${quoted(exitCode)} as a command's exit code.`;
  }
  return null;
}

/** The address a provider gives an exposed port: an absolute http or https URL. */
export function exposedUrlProblem(url: unknown): string | null {
  if (typeof url === 'string' && URL.canParse(url)) {
    const { protocol, host } = new URL(url);
    if ((protocol === 'https:' || protocol === 'http:') && host !== '') return null;
  }
  return `The provider gave ${quoted(url)} as a port's address, which is no http or https URL.`;
}

/** An id a provider gives a sandbox, or a template name a snapshot returns. */
export function nameProblem(what: string, name: unknown): string | null {
  if (typeof name === 'string' && name.trim() !== '') return null;
  return `The provider gave ${quoted(name)} as ${what}.`;
}
