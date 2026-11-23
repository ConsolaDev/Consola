// @effect-diagnostics nodeBuiltinImport:off - A build script: it runs the type checker.
/**
 * The package's typecheck, three programs:
 *
 * - t3's checker (`effect-tsgo`, as t3 runs it) over the browser program (`tsconfig.json`) and the
 *   Node one (`tsconfig.node.json`). It fails on every error but the four below, and on any of
 *   the four that no longer appears (compared by count, so a second identical error fails), so the list stays exact.
 * - An embedding app's program (`test-consumer/`), with TypeScript's own `tsc`, as cloud-web and
 *   the desktop check theirs. It imports the package by name, so it reads what `package.json`'s
 *   `exports` publish. It fails on any error at all, and on any file it reads that is neither its
 *   own, the package's published declarations (`types/`) nor a library's: a declaration that
 *   reached the package's source (t3's `~/` paths and types) or another workspace package would
 *   be in its file list.
 *
 * The four are in copied files, which are never edited: four callbacks that take their parameter
 * types from t3's router registration (`apps/web/src/router.ts`). That names t3's whole route
 * tree, which reaches its whole app (405 more files, 108,534 lines), so it is not copied, and
 * without it the parameters are implicitly `any`. Nothing at runtime depends on those types.
 */
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareErrors } from './errorCounts.ts';

const KNOWN_ERRORS = [
  "src/t3/components/settings/ScheduledTasksSettings.tsx: TS7031: Binding element '_closed' implicitly has an 'any' type.",
  "src/t3/hooks/useThreadActions.ts: TS7031: Binding element 'action' implicitly has an 'any' type.",
  "src/t3/lib/openIssueLink.ts: TS7006: Parameter 'previous' implicitly has an 'any' type.",
  "src/t3/lib/openPullRequestLink.ts: TS7006: Parameter 'previous' implicitly has an 'any' type.",
];

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const CONSUMER = 'test-consumer';

const ERROR_LINE = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/;

/** A checker's errors (`file: code: message`) and the rest of what it printed, line by line. */
const check = (command: string, args: string[]): { errors: string[]; lines: string[] } => {
  const run = spawnSync(command, args, { encoding: 'utf8' });
  if (run.error !== undefined) throw run.error;
  const output = `${run.stdout}${run.stderr}`;
  const lines = output.split('\n');
  const errors = lines
    .map((line) => line.match(ERROR_LINE))
    .filter((match) => match !== null)
    .map(([, file, code, message]) => `${file}: ${code}: ${message}`);
  if (run.status !== 0 && errors.length === 0) {
    throw new Error(`${command} failed on ${args.join(' ')} without a type error:\n${output}`);
  }
  return { errors, lines };
};

const t3Errors = (project: string) => check('effect-tsgo', ['tsrs', '--noEmit', '-p', project]);

const found = [...t3Errors('tsconfig.json').errors, ...t3Errors('tsconfig.node.json').errors];
// By count: a second identical error is a new one (`errorCounts.ts`).
const { unexpected, gone } = compareErrors(found, KNOWN_ERRORS);

const consumer = check('tsc', [
  '--noEmit',
  '--pretty',
  'false',
  '--listFiles',
  '-p',
  `${CONSUMER}/tsconfig.json`,
]);
/** What an embedder's program may read: its own files, `types/`, and libraries' declarations. */
const embedderMayRead = (file: string) => {
  const path = relative(PACKAGE, file);
  return (
    path.startsWith(`${CONSUMER}${sep}`) ||
    path.startsWith(`types${sep}`) ||
    file.split(sep).includes('node_modules')
  );
};
const consumerReads = consumer.lines.map((line) => line.trim()).filter((line) => isAbsolute(line));
const leaked = consumerReads.filter((file) => !embedderMayRead(file));

for (const error of unexpected) process.stderr.write(`error: ${error}\n`);
for (const error of gone) {
  process.stderr.write(`no longer reported (remove it from KNOWN_ERRORS): ${error}\n`);
}
for (const error of consumer.errors) process.stderr.write(`error (${CONSUMER}): ${error}\n`);
for (const file of leaked) {
  process.stderr.write(
    `${CONSUMER} reads ${relative(PACKAGE, file)}, which is not the package's published types\n`,
  );
}
if (consumerReads.length === 0) {
  process.stderr.write(`tsc listed no file of ${CONSUMER}'s program\n`);
}
if (
  unexpected.length > 0 ||
  gone.length > 0 ||
  consumer.errors.length > 0 ||
  leaked.length > 0 ||
  consumerReads.length === 0
) {
  process.exit(1);
}
process.stdout.write(
  `typecheck: no errors but the ${KNOWN_ERRORS.length} known ones in copied files, and an ` +
    `embedder's program (${CONSUMER}/) reads only the published types (build/typecheck.ts).\n`,
);
