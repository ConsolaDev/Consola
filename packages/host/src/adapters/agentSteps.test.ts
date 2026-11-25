// @effect-diagnostics nodeBuiltinImport:off - It reads what the local sandboxes left on disk, and checks their processes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxesFrom } from '@consola/sandbox';
import { ORCHESTRATOR_REPLAY_FIXTURES } from '@t3tools/server-orchestration/testing';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vite-plus/test';
import type { AgentStepRequest, AgentStepResult } from '../core/steps/ports.ts';
import { DECLARATION_FILE, OUTPUTS_FILE } from '../core/steps/stepFolder.ts';
import {
  CHANGES_DOCUMENT,
  STEP_TOOLS_FOLDER,
  stepMcpConfig,
  stepT3Settings,
} from '../core/steps/stepSandbox.ts';
import { readDeclaration } from '../core/steps/stepFolder.ts';
import {
  LocalProvider,
  type LocalSandboxRecord,
  type LocalStepsOptions,
} from '../testing/localProvider.ts';
import { isolateMachine } from '../testing/machine.ts';
import { makeAgentSteps } from './agentSteps.ts';

/**
 * Agent steps on the local provider (`testing/localProvider.ts`): each attempt's sandbox is a
 * folder of this machine, its checkout a stand-in, and its host `replaySession.ts` over one of
 * t3's recorded Claude fixtures. The step tools' calls an agent would make during its turn are
 * made by the real step tools' server, against the step's folder, before the host starts.
 */
isolateMachine();

const TEST_TIMEOUT_MS = 180_000;
const API_KEY = 'sk-ant-sprocket-step-0123456789';
/** Not a real token; its `/` and `+` make its URL-encoded form differ from it. */
const CLONE_TOKEN = 'ghs_Sprocket/Clone+0123456789';
const RUNNER_SECRET = 'consola-runner-secret-sprocket-0123456789';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

const fixtureText = (name: string, index: number): string => {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((each) => each.name === name);
  const messages = (fixture?.buildInput().steps ?? []).filter((step) => step.type === 'message');
  const step = messages[index];
  if (step?.type !== 'message') throw new Error(`${name} has no message ${index}`);
  return step.text;
};

const SET_VERDICT = {
  name: 'consola_set_outputs',
  arguments: { outputs: { verdict: 'comment' } },
};
const WRITE_HANDOVER = {
  name: 'consola_write_artifact',
  arguments: { name: 'handover', content: `# Review\nThe checkout change reads well. ${API_KEY}` },
};

type Ran = {
  readonly result: AgentStepResult;
  readonly provider: LocalProvider;
  readonly logged: string[];
};

/** Runs one attempt on a local provider whose step sandboxes behave as `steps` says. */
const runStep = async (
  steps: LocalStepsOptions,
  fields: Partial<AgentStepRequest> = {},
  signal: AbortSignal = new AbortController().signal,
  provider: LocalProvider = new LocalProvider({ steps }),
): Promise<Ran> => {
  const logged: string[] = [];
  const agentSteps = makeAgentSteps({
    sandboxes: sandboxesFrom(provider),
    apiKeys: { claude: API_KEY },
    secretValues: [RUNNER_SECRET, API_KEY],
    log: (message) =>
      Effect.sync(() => {
        logged.push(message);
      }),
    pollEvery: '100 millis',
  });
  const request: AgentStepRequest = {
    runId: 'run-sprocket-1',
    stepId: 'review',
    attempt: 1,
    harness: 'claude',
    model: 'claude-sonnet-4-6',
    checkout: {
      repository: 'sprocket/catalog-portal',
      commit: COMMIT,
      pullRequest: 42,
      baseRef: 'main',
    },
    cloneToken: CLONE_TOKEN,
    prompt: fixtureText(steps.fixture ?? 'simple', 0),
    reminder: (missing) =>
      `You ended without: ${[...missing.outputs, ...missing.artifacts].join(', ')}.`,
    outputs: { verdict: { type: 'enum', values: ['approve', 'comment', 'request-changes'] } },
    requiredArtifacts: ['handover'],
    allowedArtifacts: ['handover'],
    readable: [{ name: 'triage.handover', content: 'Sprocket triage: look at checkout.' }],
    policy: 'read-only',
    maxTurns: null,
    timeoutMs: 150_000,
    ...fields,
  };
  const result = await agentSteps.run(request, signal);
  return { result, provider, logged };
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The attempt's one sandbox: stopped, its folder gone, no process of it left. */
const expectStopped = (provider: LocalProvider): LocalSandboxRecord => {
  expect(provider.sandboxes).toHaveLength(1);
  const [record] = provider.sandboxes;
  if (record === undefined) throw new Error('no sandbox');
  expect(record.stopped).toBe(true);
  expect(existsSync(record.folder)).toBe(false);
  expect(record.pids.filter(isAlive)).toEqual([]);
  return record;
};

/** Nothing the attempt returned or logged holds a secret, in any form. */
const expectNoSecret = (ran: Ran) => {
  const said = JSON.stringify(ran.result) + ran.logged.join('\n');
  for (const secret of [API_KEY, CLONE_TOKEN, RUNNER_SECRET]) {
    expect(said).not.toContain(secret);
    expect(said).not.toContain(encodeURIComponent(secret));
  }
};

const sleep = (ms: number) => Effect.runPromise(Effect.sleep(Duration.millis(ms)));

const waitFor = (done: () => boolean, what: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      while (!done()) yield* Effect.sleep(Duration.millis(50));
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(60),
        orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
      }),
    ),
  );

describe('AgentSteps on sandboxes', () => {
  it(
    'completes a step that called its tools, with its validated outputs and its handover, masked',
    async () => {
      // The declaration, as the step tools found it, and the changes the checkout wrote.
      let declaration: ReturnType<typeof readDeclaration> = null;
      // What the runner wrote for the host and its CLI: t3's settings and the MCP config.
      let launch: { t3: unknown; mcp: unknown } | null = null;
      const ran = await runStep({
        toolCalls: [{ name: 'consola_list_artifacts', arguments: {} }, SET_VERDICT, WRITE_HANDOVER],
        changes: 'Files changed:\nM\tsrc/checkout.ts\n',
        tamper: (folder) => {
          declaration = readDeclaration(readFileSync(join(folder, DECLARATION_FILE), 'utf8'));
          const consola = join(folder, '..');
          launch = {
            t3: JSON.parse(
              readFileSync(join(consola, 't3-state', 'userdata', 'settings.json'), 'utf8'),
            ),
            mcp: JSON.parse(readFileSync(join(consola, 'step-mcp.json'), 'utf8')),
          };
        },
      });
      // Every turn's CLI runs --restricted, with the step tools' server alone.
      expect(launch).toEqual({ t3: stepT3Settings(), mcp: stepMcpConfig() });
      expect(ran.result).toMatchObject({
        status: 'completed',
        error: null,
        outputs: { verdict: 'comment' },
        artifacts: [{ name: 'handover', content: '# Review\nThe checkout change reads well. ***' }],
        costUsd: null,
        turns: null,
        deniedTools: [],
        reminded: false,
      });
      expect(ran.result.output?.stdout).toContain('fixture simple ok');
      const record = expectStopped(ran.provider);
      expectNoSecret(ran);

      // The tools answered as the agent would have read them.
      expect(record.toolAnswers[0]).toMatchObject({
        content: [{ type: 'text', text: expect.stringContaining('triage.handover') }],
      });
      expect(JSON.stringify(record.toolAnswers[0])).toContain(CHANGES_DOCUMENT);
      // The step reads its pull request's changes beside the documents it was given.
      expect(declaration).toMatchObject({
        readable: [
          { name: 'triage.handover', content: 'Sprocket triage: look at checkout.' },
          { name: 'changes', content: 'Files changed:\nM\tsrc/checkout.ts\n' },
        ],
      });

      // The sandbox was made with no variables; the clone token reached the checkout alone, the
      // API key the host alone.
      expect(record.env).toEqual({});
      const [checkout, host] = record.commands;
      expect(checkout?.argv).toEqual(['consola-step-checkout']);
      expect(checkout?.env).toMatchObject({
        GIT_TOKEN: CLONE_TOKEN,
        CONSOLA_CHECKOUT_COMMIT: COMMIT,
        CONSOLA_CHECKOUT_PULL_REQUEST: '42',
        CONSOLA_CHECKOUT_BASE_REF: 'main',
      });
      expect(checkout?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(host?.argv).toEqual(['consola-step-start']);
      expect(host?.env).toMatchObject({
        ANTHROPIC_API_KEY: API_KEY,
        CONSOLA_HARNESS: 'claude',
        CONSOLA_STEP_FOLDER: STEP_TOOLS_FOLDER,
        CONSOLA_SESSION_ID: 'step-run-sprocket-1-review-1',
      });
      expect(host?.env).not.toHaveProperty('GIT_TOKEN');
      expect(host?.env.CONSOLA_PASS_PUBLIC_KEY).toMatch(/BEGIN PUBLIC KEY/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reminds a step that forgets once, in the same conversation, then fails naming what is missing',
    async () => {
      const reminders: unknown[] = [];
      const ran = await runStep(
        { fixture: 'multi_turn' },
        {
          reminder: (missing) => {
            reminders.push(missing);
            // The fixture's second turn stands in for the reminder.
            return fixtureText('multi_turn', 1);
          },
        },
      );
      expect(reminders).toEqual([{ outputs: ['verdict'], artifacts: ['handover'] }]);
      expect(ran.result).toMatchObject({
        status: 'failed',
        error:
          'The step ended without the output verdict and the document handover, even after its reminder.',
        outputs: {},
        artifacts: [],
        reminded: true,
      });
      // Both turns' answers, in one conversation.
      expect(ran.result.output?.stdout).toContain('first fixture turn complete');
      expect(ran.result.output?.stdout).toContain('second fixture turn complete');
      expectStopped(ran.provider);
      expectNoSecret(ran);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a write its policy does not allow, records it, and the step still ends',
    async () => {
      // Recorded in the host's own mode: Claude asks to write a file, and its turn goes on when
      // the answer is no.
      const ran = await runStep({
        fixture: 'tool_call_denied_write',
        mode: 'default',
        toolCalls: [SET_VERDICT, WRITE_HANDOVER],
      });
      expect(ran.result).toMatchObject({
        status: 'completed',
        deniedTools: ['file-change'],
        outputs: { verdict: 'comment' },
      });
      expect(ran.result.output?.stdout).toContain('write permission denied');
      expectStopped(ran.provider);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an outputs file tampered with in the sandbox: the runner's own check drops it",
    async () => {
      const ran = await runStep(
        {
          fixture: 'multi_turn',
          toolCalls: [SET_VERDICT, WRITE_HANDOVER],
          // An agent with a way to write the folder plants a value its tool would refuse.
          tamper: (folder) => {
            writeFileSync(join(folder, OUTPUTS_FILE), JSON.stringify({ verdict: 'merge-it-now' }));
          },
        },
        { reminder: () => fixtureText('multi_turn', 1) },
      );
      expect(ran.result).toMatchObject({
        status: 'failed',
        error: 'The step ended without the output verdict, even after its reminder.',
        outputs: {},
        reminded: true,
      });
      expect(JSON.stringify(ran.result)).not.toContain('merge-it-now');
      expect(ran.logged.join('\n')).toContain('verdict must be one of');
      expectStopped(ran.provider);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops the sandbox when the step is aborted mid-turn',
    async () => {
      const controller = new AbortController();
      const provider = new LocalProvider({ steps: { fixture: 'turn_interrupt' } });
      const running = runStep(
        {},
        { prompt: fixtureText('turn_interrupt', 0) },
        controller.signal,
        provider,
      );
      // Once the host runs, its turn goes on until something stops it.
      await waitFor(
        () => (provider.sandboxes[0]?.commands.length ?? 0) >= 2,
        "the step's host to start",
      );
      await sleep(3_000);
      controller.abort();
      const ran = await running;
      expect(ran.result).toMatchObject({ status: 'failed', error: 'The step was stopped.' });
      expectStopped(provider);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops the sandbox when the step runs past its timeout',
    async () => {
      const ran = await runStep(
        { fixture: 'turn_interrupt' },
        { prompt: fixtureText('turn_interrupt', 0), timeoutMs: 12_000 },
      );
      expect(ran.result).toMatchObject({
        status: 'failed',
        error: 'The step did not end within 12 s.',
      });
      expectStopped(ran.provider);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails a checkout that fails with its message, the clone token taken out',
    async () => {
      const ran = await runStep({
        checkoutFails: 'Could not clone sprocket/catalog-portal: fatal: 403 for',
      });
      expect(ran.result.status).toBe('failed');
      expect(ran.result.error).toMatch(/^Could not clone sprocket\/catalog-portal: fatal: 403 for/);
      expect(ran.result.error).not.toContain(CLONE_TOKEN);
      expectStopped(ran.provider);
      expect(ran.provider.sandboxes[0]?.commands).toHaveLength(1);
      expectNoSecret(ran);
    },
    TEST_TIMEOUT_MS,
  );

  it('fails at once, with no sandbox, for a harness it cannot serve or a checkout it cannot ask for', async () => {
    const codex = await runStep({}, { harness: 'codex' });
    expect(codex.result).toMatchObject({
      status: 'failed',
      error: 'This runner runs agent steps on Claude alone, not on codex.',
    });
    expect(codex.provider.sandboxes).toEqual([]);
    const bad = await runStep(
      {},
      {
        checkout: {
          repository: 'sprocket/catalog-portal',
          commit: 'not-a-commit',
          pullRequest: null,
          baseRef: null,
        },
      },
    );
    expect(bad.result.error).toMatch(/40 lowercase/);
    expect(bad.provider.sandboxes).toEqual([]);
  });
});
