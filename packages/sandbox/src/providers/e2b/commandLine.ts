/**
 * How a command's argv reaches E2B, which runs a command line through a shell it is given:
 * it starts that shell's executable with the shell's own arguments, then the command line as
 * the last one. So no argument passes through a shell's parser here, and none is quoted. The
 * program and every argument but the last ride in as the shell's own arguments, the last as
 * the "command line", and the shell runs one fixed script, `exec "$@"`, which hands them all
 * to the program exactly as they are.
 *
 * The shell is `/bin/sh`, not E2B's default login shell (`bash -l`): a login profile sets
 * `PATH` again over the command's own (Debian's `/etc/profile` does), and a command's own
 * variables go on top of everything. So a template that needs a `PATH` sets it in its
 * environment, not in a profile.
 */
export interface E2BCommandLine {
  readonly shell: readonly string[];
  readonly cmd: string;
}

const SCRIPT = 'exec "$@"';

export function commandLineOf(argv: readonly string[]): E2BCommandLine {
  const last = argv.length - 1;
  return { shell: ['/bin/sh', '-c', SCRIPT, 'sh', ...argv.slice(0, last)], cmd: argv[last] ?? '' };
}
