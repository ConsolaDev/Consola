import type { FakeProcess, FakeProgram } from './FakeProvider';

/**
 * Stand-ins for the POSIX tools the contract runs (`CONTRACT_PROGRAMS`), as far as it uses them,
 * so the fake can be held to the same contract as a real provider. Each answers what the real
 * tool would for those uses, and refuses with exit code 2 any form it does not imitate, so a
 * test that leans on more than that fails rather than passing against the wrong behaviour.
 *
 * The fake keeps no clock: `sleep` and `tail -f` run until the command is killed, or the sandbox
 * stops or pauses.
 */

const unsupported = (child: FakeProcess, form: string): number => {
  child.stderr(`${child.argv[0]}: the fake does not imitate ${form}\n`);
  return 2;
};

/** `printf FORMAT [ARGUMENT…]` with `%s`, `%%` and the escapes `\n`, `\t` and `\\`. */
const printf: FakeProgram = (child) => {
  const [, format, ...args] = child.argv;
  if (format === undefined) {
    child.stderr('printf: missing operand\n');
    return 1;
  }
  let out = '';
  let rest = args;
  // POSIX printf reuses the format until every argument is used.
  for (;;) {
    const applied = applyFormat(format, rest);
    if (typeof applied === 'string') return unsupported(child, applied);
    out += applied.text;
    rest = rest.slice(applied.used);
    if (applied.used === 0 || rest.length === 0) break;
  }
  child.stdout(out);
  return 0;
};

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', '\\': '\\' };

/** `format` with `args` in place, and how many it used, or the form it does not imitate. */
function applyFormat(
  format: string,
  args: readonly string[],
): { text: string; used: number } | string {
  let text = '';
  let used = 0;
  for (let index = 0; index < format.length; index += 1) {
    const char = format[index];
    const next = format[index + 1] ?? '';
    if (char === '\\') {
      const escaped = ESCAPES[next];
      if (escaped === undefined) return `the escape \\${next}`;
      text += escaped;
      index += 1;
    } else if (char === '%') {
      if (next === '%') text += '%';
      else if (next === 's') {
        text += args[used] ?? '';
        used += 1;
      } else return `the conversion %${next}`;
      index += 1;
    } else {
      text += char;
    }
  }
  return { text, used: Math.min(used, args.length) };
}

/** `cat FILE…`: each file in turn. A missing one is reported, and the rest still printed. */
const cat: FakeProgram = (child) => {
  let status = 0;
  for (const path of child.argv.slice(1)) {
    if (path.startsWith('-')) return unsupported(child, `the option ${path}`);
    const content = child.files.readText(path);
    if (content === undefined) {
      child.stderr(`cat: ${path}: No such file or directory\n`);
      status = 1;
    } else {
      child.stdout(content);
    }
  }
  return status;
};

/** `cp SOURCE DESTINATION`, for one file. */
const cp: FakeProgram = (child) => {
  const operands = child.argv.slice(1);
  if (operands.length !== 2 || operands.some((operand) => operand.startsWith('-'))) {
    return unsupported(child, 'anything but cp SOURCE DESTINATION');
  }
  const [source = '', destination = ''] = operands;
  const content = child.files.read(source);
  if (content === undefined) {
    child.stderr(`cp: cannot stat '${source}': No such file or directory\n`);
    return 1;
  }
  child.files.write(destination, content);
  return 0;
};

const pwd: FakeProgram = (child) => {
  if (child.argv.length > 1) return unsupported(child, 'options');
  child.stdout(`${child.cwd}\n`);
  return 0;
};

/** `printenv [NAME…]`: each variable's value, or every variable with no names. */
const printenv: FakeProgram = (child) => {
  const names = child.argv.slice(1);
  if (names.some((name) => name.startsWith('-'))) return unsupported(child, 'options');
  if (names.length === 0) {
    for (const [name, value] of Object.entries(child.env)) child.stdout(`${name}=${value}\n`);
    return 0;
  }
  let status = 0;
  for (const name of names) {
    const value = child.env[name];
    if (value === undefined) status = 1;
    else child.stdout(`${value}\n`);
  }
  return status;
};

/** `tail [-n K | -n +K] [-f] FILE`: the last K lines, or the lines from line K; then, with -f, it waits. */
const tail: FakeProgram = async (child) => {
  let count = '10';
  let follow = false;
  const files: string[] = [];
  const args = child.argv.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '-f') follow = true;
    else if (arg === '-n') {
      count = args[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('-')) return unsupported(child, `the option ${arg}`);
    else files.push(arg);
  }
  const [path] = files;
  if (path === undefined || files.length > 1 || !/^\+?\d+$/.test(count)) {
    return unsupported(child, 'anything but tail [-n K | -n +K] [-f] FILE');
  }
  const content = child.files.readText(path);
  if (content === undefined) {
    child.stderr(`tail: cannot open '${path}' for reading: No such file or directory\n`);
    return 1;
  }
  const lines = content.split(/(?<=\n)/).filter((line) => line !== '');
  const shown = count.startsWith('+')
    ? lines.slice(Math.max(Number(count.slice(1)) - 1, 0))
    : lines.slice(lines.length - Math.min(Number(count), lines.length));
  child.stdout(shown.join(''));
  if (follow) await child.killed;
  return 0;
};

/** `sleep SECONDS`: runs until killed, since the fake keeps no clock. */
const sleep: FakeProgram = async (child) => {
  if (child.argv.length !== 2 || !/^\d+(\.\d+)?$/.test(child.argv[1] ?? '')) {
    return unsupported(child, 'anything but sleep SECONDS');
  }
  await child.killed;
  return 0;
};

/** The programs, by the name a command runs them with. */
export const POSIX_PROGRAMS: Readonly<Record<string, FakeProgram>> = {
  cat,
  cp,
  false: () => 1,
  printenv,
  printf,
  pwd,
  sleep,
  tail,
  true: () => 0,
};
