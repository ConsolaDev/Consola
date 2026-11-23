/**
 * `consola-host runner`, for tests only: the same command (`runnerCommand`, `runHostProcess` from
 * `../bin.ts`), its sandboxes local processes that run the session command over a replay
 * (`localProvider.ts`) instead of a provider's. `bin.test.ts` starts it with node:
 *
 *   node src/testing/replayRunner.ts runner --cell-url ws://127.0.0.1:<port>/api/runner --runner-id <id>
 *
 * with the runner's variables (`CONSOLA_RUNNER_SECRET`, `CONSOLA_RUNNER_REPOSITORIES`,
 * `ANTHROPIC_API_KEY`, …) over the test machine's environment.
 */
import { runHostProcess, runnerCommand } from '../bin.ts';
import { LocalProvider } from './localProvider.ts';

runHostProcess(
  runnerCommand(process.argv.slice(2), process.env, () => new LocalProvider()),
  'runner',
);
