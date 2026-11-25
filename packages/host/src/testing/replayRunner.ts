/**
 * `consola-host runner`, for tests only: the same command (`runnerCommand`, `runHostProcess` from
 * `../bin.ts`), its sandboxes local processes that run the session command over a replay
 * (`localProvider.ts`) instead of a provider's. `bin.test.ts` and `@consola/cloud-session-e2e`
 * start it with node:
 *
 *   node src/testing/replayRunner.ts runner --cell-url ws://127.0.0.1:<port>/api/runner --runner-id <id>
 *
 * with the runner's variables (`CONSOLA_RUNNER_SECRET`, `CONSOLA_RUNNER_REPOSITORIES`,
 * `ANTHROPIC_API_KEY`, …) over the test machine's environment. With
 * `CONSOLA_TEST_SANDBOX_STOP=hangs`, no sandbox's stop ever returns, as a provider that hangs;
 * with `CONSOLA_TEST_SANDBOX_CREATE=hangs`, no sandbox's create does. `CONSOLA_TEST_STEPS`, a
 * JSON object, is how its step sandboxes behave (`LocalStepsOptions`, less `tamper`): the
 * fixture, the step tools' calls the agent makes, the changes the checkout writes, and
 * `anyPrompt` for a step whose prompt the engine words (`@consola/cloud-session-e2e`'s triggered
 * run).
 */
import { runHostProcess, runnerCommand } from '../bin.ts';
import { LocalProvider, type LocalStepsOptions } from './localProvider.ts';

const stopHangsForTests = process.env.CONSOLA_TEST_SANDBOX_STOP === 'hangs';
const createHangsForTests = process.env.CONSOLA_TEST_SANDBOX_CREATE === 'hangs';
const steps: LocalStepsOptions = JSON.parse(process.env.CONSOLA_TEST_STEPS ?? '{}');

runHostProcess(
  runnerCommand(
    process.argv.slice(2),
    process.env,
    async () => new LocalProvider({ stopHangsForTests, createHangsForTests, steps }),
  ),
  'runner',
);
