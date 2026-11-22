// @effect-diagnostics nodeBuiltinImport:off - A build script: it runs the type checker.
/**
 * The package's typecheck: t3's checker (`effect-tsgo`, as t3 runs it) over the browser program
 * (`tsconfig.json`) and the Node one (`tsconfig.node.json`). It fails on every error but the
 * four below, and on any of the four that no longer appears, so the list stays exact.
 *
 * The four are in copied files, which are never edited: four callbacks that take their parameter
 * types from t3's router registration (`apps/web/src/router.ts`). That names t3's whole route
 * tree, which reaches its whole app (405 more files, 108,534 lines), so it is not copied, and
 * without it the parameters are implicitly `any`. Nothing at runtime depends on those types.
 */
import { spawnSync } from 'node:child_process';

const KNOWN_ERRORS = [
  "src/t3/components/settings/ScheduledTasksSettings.tsx: TS7031: Binding element '_closed' implicitly has an 'any' type.",
  "src/t3/hooks/useThreadActions.ts: TS7031: Binding element 'action' implicitly has an 'any' type.",
  "src/t3/lib/openIssueLink.ts: TS7006: Parameter 'previous' implicitly has an 'any' type.",
  "src/t3/lib/openPullRequestLink.ts: TS7006: Parameter 'previous' implicitly has an 'any' type.",
];

const ERROR_LINE = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/;

const errorsOf = (project: string): string[] => {
  const run = spawnSync('effect-tsgo', ['tsrs', '--noEmit', '-p', project], { encoding: 'utf8' });
  if (run.error !== undefined) throw run.error;
  const output = `${run.stdout}${run.stderr}`;
  const errors = output
    .split('\n')
    .map((line) => line.match(ERROR_LINE))
    .filter((match) => match !== null)
    .map(([, file, code, message]) => `${file}: ${code}: ${message}`);
  if (run.status !== 0 && errors.length === 0) {
    throw new Error(`effect-tsgo failed on ${project} without a type error:\n${output}`);
  }
  return errors;
};

const found = [...errorsOf('tsconfig.json'), ...errorsOf('tsconfig.node.json')];
const unexpected = found.filter((error) => !KNOWN_ERRORS.includes(error));
const gone = KNOWN_ERRORS.filter((error) => !found.includes(error));

for (const error of unexpected) process.stderr.write(`error: ${error}\n`);
for (const error of gone) {
  process.stderr.write(`no longer reported (remove it from KNOWN_ERRORS): ${error}\n`);
}
if (unexpected.length > 0 || gone.length > 0) process.exit(1);
process.stdout.write(
  `typecheck: no errors but the ${KNOWN_ERRORS.length} known ones in copied files (build/typecheck.ts).\n`,
);
