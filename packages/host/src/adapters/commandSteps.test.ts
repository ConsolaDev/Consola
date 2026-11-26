// @effect-diagnostics nodeBuiltinImport:off - It checks what the local sandboxes left on disk.
import { existsSync } from 'node:fs';
import { sandboxesFrom } from '@consola/sandbox';
import * as Effect from 'effect/Effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { MASK } from '../core/steps/mask.ts';
import type { CommandStepRequest, CommandStepResult } from '../core/steps/ports.ts';
import { LocalProvider } from '../testing/localProvider.ts';
import type { LocalStepsOptions } from '../testing/localProvider.ts';
import { isolateMachine } from '../testing/machine.ts';
import { makeCommandSteps } from './commandSteps.ts';

/**
 * Command steps on the local provider (`testing/localProvider.ts`): each attempt's sandbox is a
 * folder of this machine, its checkout a stand-in, and its command a real `bash -c` there.
 */
isolateMachine();

const TEST_TIMEOUT_MS = 60_000;
/** Not real tokens; their `/` and `+` make their encoded forms differ from them. */
const GH_TOKEN = 'ghs_Sprocket/Post+0123456789';
const CLONE_TOKEN = 'ghs_Sprocket/Clone+0123456789';
const RUNNER_SECRET = 'consola-runner-secret-sprocket-0123456789';
const API_KEY = 'sk-ant-sprocket-runner-0123456789';

// The runner's own process holds its secret, its keys and its git token: none reaches a command.
beforeEach(() => {
  vi.stubEnv('CONSOLA_RUNNER_SECRET', RUNNER_SECRET);
  vi.stubEnv('ANTHROPIC_API_KEY', API_KEY);
  vi.stubEnv('GIT_TOKEN', CLONE_TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Ran = { readonly result: CommandStepResult; readonly provider: LocalProvider };

const runCommand = async (
  fields: Partial<CommandStepRequest>,
  steps: LocalStepsOptions = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<Ran> => {
  const provider = new LocalProvider({ steps });
  const commandSteps = makeCommandSteps({
    sandboxes: sandboxesFrom(provider),
    secretValues: [RUNNER_SECRET, API_KEY, CLONE_TOKEN],
    log: () => Effect.void,
  });
  const result = await commandSteps.run(
    {
      runId: 'run-sprocket-1',
      stepId: 'post',
      attempt: 1,
      checkout: null,
      cloneToken: null,
      command: 'true',
      env: {},
      secretEnv: {},
      files: [],
      fileEnv: {},
      timeoutMs: 30_000,
      ...fields,
    },
    signal,
  );
  return { result, provider };
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const expectStopped = (provider: LocalProvider) => {
  expect(provider.sandboxes).toHaveLength(1);
  const [record] = provider.sandboxes;
  expect(record?.stopped).toBe(true);
  expect(existsSync(record?.folder ?? '')).toBe(false);
  expect(record?.pids.filter(isAlive)).toEqual([]);
};

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('CommandSteps on sandboxes', () => {
  it(
    'returns the exit code, the ends of its output and its $CONSOLA_OUTPUT, its secret masked everywhere',
    async () => {
      const { result, provider } = await runCommand({
        command: [
          'echo "pr=$PR"',
          'cat "$REVIEW"',
          'echo "token=$GH_TOKEN"',
          'printf "%s" "$GH_TOKEN" | base64',
          'echo "to stderr: $GH_TOKEN" >&2',
          String.raw`echo "names: $(env | cut -d= -f1 | sort | tr "\n" " ")"`,
          'echo "review_id=17" >> "$CONSOLA_OUTPUT"',
          'echo "echoed=$GH_TOKEN" >> "$CONSOLA_OUTPUT"',
          'echo "not a line" >> "$CONSOLA_OUTPUT"',
          'exit 3',
        ].join('\n'),
        env: { PR: '42' },
        secretEnv: { GH_TOKEN },
        files: [{ path: 'reviews/review.md', content: 'Looks right.\n' }],
        fileEnv: { REVIEW: 'reviews/review.md' },
      });
      expect(result).toMatchObject({
        exitCode: 3,
        signal: null,
        error: null,
        outputs: { review_id: '17', echoed: MASK },
      });
      const { stdout, stderr } = result.output;
      expect(stdout).toContain('pr=42\nLooks right.\n');
      expect(stdout).toContain(`token=${MASK}`);
      expect(stderr).toBe(`to stderr: ${MASK}\n`);
      for (const text of [stdout, stderr, JSON.stringify(result)]) {
        for (const form of [GH_TOKEN, encodeURIComponent(GH_TOKEN), base64(GH_TOKEN)]) {
          expect(text).not.toContain(form);
        }
      }
      // The sizes are of what it printed, before masking.
      expect(result.stderrBytes).toBe(Buffer.byteLength(`to stderr: ${GH_TOKEN}\n`));
      expect(result.output.truncated).toBe(false);

      // Exactly its variables: the request's, its file's path and Consola's output; none of the
      // runner's own (its secret, its API key, its git token).
      const names = (/names: (.*)/.exec(stdout)?.[1] ?? '').trim().split(' ');
      expect(names).toEqual(expect.arrayContaining(['PR', 'GH_TOKEN', 'REVIEW', 'CONSOLA_OUTPUT']));
      for (const name of ['CONSOLA_RUNNER_SECRET', 'ANTHROPIC_API_KEY', 'GIT_TOKEN']) {
        expect(names).not.toContain(name);
      }
      const record = provider.sandboxes[0];
      expect(record?.env).toEqual({});
      expect(record?.commands.at(-1)?.env).toEqual({
        PR: '42',
        GH_TOKEN,
        REVIEW: '/workspace/.consola/attempt/reviews/review.md',
        CONSOLA_OUTPUT: '/workspace/.consola/outputs.env',
      });
      expectStopped(provider);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs in the checkout at the commit, the clone token given to the checkout alone',
    async () => {
      const { result, provider } = await runCommand({
        checkout: {
          repository: 'sprocket/catalog-portal',
          commit: '0123456789abcdef0123456789abcdef01234567',
          pullRequest: 42,
          baseRef: 'main',
        },
        cloneToken: CLONE_TOKEN,
        command: 'pwd',
      });
      expect(result.exitCode).toBe(0);
      expect(result.output.stdout.trim().endsWith('/workspace/repo')).toBe(true);
      const [checkout, command] = provider.sandboxes[0]?.commands ?? [];
      expect(checkout?.argv).toEqual(['consola-step-checkout']);
      expect(checkout?.env).toMatchObject({
        GIT_TOKEN: CLONE_TOKEN,
        CONSOLA_CHECKOUT_PULL_REQUEST: '42',
      });
      // A command step reads no pull request's changes.
      expect(checkout?.env).not.toHaveProperty('CONSOLA_CHECKOUT_BASE_REF');
      expect(command?.env).not.toHaveProperty('GIT_TOKEN');
      expectStopped(provider);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs a step with no checkout in an empty folder',
    async () => {
      const { result } = await runCommand({ command: 'ls -A | wc -l | tr -d " "' });
      expect(result).toMatchObject({ exitCode: 0, error: null });
      expect(result.output.stdout).toBe('0\n');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the last 16 KiB of each stream, and counts all of it',
    async () => {
      const { result } = await runCommand({
        command: String.raw`head -c 40000 /dev/zero | tr "\0" "x"; printf "\nend\n"`,
      });
      expect(result.output.truncated).toBe(true);
      expect(result.output.stdout.length).toBe(16 * 1024);
      expect(result.output.stdout.endsWith('x\nend\n')).toBe(true);
      expect(result.stdoutBytes).toBe(40_005);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops a command past its timeout, and its sandbox with it',
    async () => {
      const { result, provider } = await runCommand({
        command: 'echo started; exec sleep 60',
        timeoutMs: 3000,
      });
      expect(result).toMatchObject({
        exitCode: null,
        signal: 'SIGTERM',
        error: "The step's command did not end within 3 s, so its sandbox was stopped.",
      });
      expect(result.output.stdout).toBe('started\n');
      expectStopped(provider);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops a command when the step is aborted',
    async () => {
      const controller = new AbortController();
      const running = runCommand(
        { command: 'exec sleep 60', timeoutMs: 30_000 },
        {},
        controller.signal,
      );
      await Effect.runPromise(Effect.sleep('2 seconds'));
      controller.abort();
      const { result, provider } = await running;
      expect(result).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
      expect(result.error).toMatch(/stopped/);
      expectStopped(provider);
    },
    TEST_TIMEOUT_MS,
  );

  it('refuses a file outside its folder, or a checkout it cannot ask for, with no sandbox', async () => {
    const outside = await runCommand({ files: [{ path: '../escape', content: '' }] });
    expect(outside.result).toMatchObject({ exitCode: null, signal: null });
    expect(outside.result.error).toMatch(/not a path inside its folder/);
    expect(outside.provider.sandboxes).toEqual([]);
    const bad = await runCommand({
      checkout: { repository: 'sprocket', commit: 'x', pullRequest: null, baseRef: null },
    });
    expect(bad.result.error).toMatch(/not a repository/);
    expect(bad.provider.sandboxes).toEqual([]);
  });

  it(
    'says why when the checkout fails, the clone token taken out',
    async () => {
      const { result, provider } = await runCommand(
        {
          checkout: {
            repository: 'sprocket/catalog-portal',
            commit: '0123456789abcdef0123456789abcdef01234567',
            pullRequest: null,
            baseRef: null,
          },
          cloneToken: CLONE_TOKEN,
        },
        { checkoutFails: 'Could not clone sprocket/catalog-portal: 403 for' },
      );
      expect(result.exitCode).toBeNull();
      expect(result.error).toMatch(/^Could not clone sprocket\/catalog-portal: 403 for/);
      expect(result.error).not.toContain(CLONE_TOKEN);
      expectStopped(provider);
    },
    TEST_TIMEOUT_MS,
  );
});
