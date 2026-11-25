import { describe, expect, it } from 'vite-plus/test';
import type { CommandStepRequest, StepCheckout } from './ports.ts';
import {
  checkoutEnv,
  checkoutProblem,
  commandPlan,
  isFilePath,
  readConsolaOutput,
  stepHostEnv,
} from './stepSandbox.ts';
import { stepMessage, stepModelSelection, stepSessionId } from './stepTurn.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const CHECKOUT: StepCheckout = {
  repository: 'sprocket/catalog-portal',
  commit: COMMIT,
  pullRequest: 42,
};

const command = (fields: Partial<CommandStepRequest> = {}): CommandStepRequest => ({
  runId: 'run-sprocket-1',
  stepId: 'post',
  attempt: 1,
  checkout: CHECKOUT,
  cloneToken: 'ghs_clone',
  command: 'gh pr review "$PR" --body-file "$REVIEW"',
  env: { PR: '42' },
  secretEnv: { GH_TOKEN: 'ghs_post' },
  files: [{ path: 'review.md', content: 'Looks right.' }],
  fileEnv: { REVIEW: 'review.md' },
  timeoutMs: 60_000,
  ...fields,
});

describe('a step’s sandbox', () => {
  it('checks a checkout before any sandbox is made', () => {
    expect(checkoutProblem(CHECKOUT)).toBeNull();
    expect(checkoutProblem({ ...CHECKOUT, commit: COMMIT.toUpperCase() })).toMatch(/40 lowercase/);
    expect(checkoutProblem({ ...CHECKOUT, repository: '-x/y/z' })).toMatch(/not a repository/);
    expect(checkoutProblem({ ...CHECKOUT, pullRequest: 0 })).toMatch(/pull request/);
  });

  it('gives the clone token to the checkout alone, and the API key to the host alone', () => {
    expect(checkoutEnv(CHECKOUT, 'ghs_clone')).toEqual({
      CONSOLA_REPOSITORY: 'sprocket/catalog-portal',
      CONSOLA_CHECKOUT_COMMIT: COMMIT,
      CONSOLA_CHECKOUT_PULL_REQUEST: '42',
      GIT_TOKEN: 'ghs_clone',
    });
    expect(checkoutEnv({ ...CHECKOUT, pullRequest: null }, null)).toEqual({
      CONSOLA_REPOSITORY: 'sprocket/catalog-portal',
      CONSOLA_CHECKOUT_COMMIT: COMMIT,
    });
    const host = stepHostEnv({
      sessionId: 'step-run-review-1',
      passPublicKeyPem: 'PEM',
      apiKey: 'sk-ant-sprocket',
      idleMinutes: 10,
    });
    expect(host).toEqual({
      CONSOLA_SESSION_ID: 'step-run-review-1',
      CONSOLA_HARNESS: 'claude',
      CONSOLA_PASS_PUBLIC_KEY: 'PEM',
      CONSOLA_SESSION_IDLE_MINUTES: '10',
      CONSOLA_STEP_FOLDER: '/workspace/.consola/step',
      ANTHROPIC_API_KEY: 'sk-ant-sprocket',
    });
    expect(Object.keys(host)).not.toContain('GIT_TOKEN');
  });

  it("runs a command with exactly its request's variables, its files' paths, and Consola's output last", () => {
    expect(commandPlan(command())).toEqual({
      ok: true,
      files: [{ path: '/workspace/.consola/attempt/review.md', content: 'Looks right.' }],
      env: {
        PR: '42',
        GH_TOKEN: 'ghs_post',
        REVIEW: '/workspace/.consola/attempt/review.md',
        CONSOLA_OUTPUT: '/workspace/.consola/outputs.env',
      },
      cwd: '/workspace/repo',
    });
    const pointed = commandPlan(command({ env: { CONSOLA_OUTPUT: '/etc/passwd' } }));
    expect(pointed.ok && pointed.env.CONSOLA_OUTPUT).toBe('/workspace/.consola/outputs.env');
  });

  it('refuses a file outside its folder, a bad name, or a variable naming no file', () => {
    for (const path of ['../x', '/etc/passwd', 'a/../b', '', 'a//b', '.']) {
      expect(isFilePath(path), path).toBe(false);
      expect(commandPlan(command({ files: [{ path, content: '' }], fileEnv: {} })).ok).toBe(false);
    }
    expect(isFilePath('reviews/2026-11/review.md')).toBe(true);
    expect(commandPlan(command({ env: { 'BAD NAME': 'x' } })).ok).toBe(false);
    expect(commandPlan(command({ fileEnv: { REVIEW: 'missing.md' } }))).toEqual({
      ok: false,
      problem: "The step's variable REVIEW names a file the step does not write.",
    });
  });

  it('reads the key=value lines of $CONSOLA_OUTPUT, the last write winning', () => {
    expect(
      readConsolaOutput(
        'review_id=17\r\n\nnot a line\n=x\nurl=https://x?a=b\nreview_id=18\n__proto__=p\n',
      ),
    ).toEqual({ review_id: '18', url: 'https://x?a=b', ['__proto__']: 'p' });
    expect(Object.getPrototypeOf(readConsolaOutput('__proto__=p'))).toBe(Object.prototype);
  });

  it('names an attempt’s session and messages it as t3’s chat would', () => {
    expect(stepSessionId({ runId: 'run/1', stepId: 'review', attempt: 2 })).toBe(
      'step-run_1-review-2',
    );
    const model = stepModelSelection('claude-sonnet-4-6');
    expect(model.model).toBe('claude-sonnet-4-6');
    expect(stepModelSelection(null).model).not.toBe('');
    expect(stepMessage('step-1', 2, 'You ended without: verdict.', model)).toMatchObject({
      type: 'message.dispatch',
      commandId: 'command:step-1:message-2',
      threadId: 'step-1',
      messageId: 'message:step-1:2',
      text: 'You ended without: verdict.',
      dispatchMode: { type: 'start_immediately' },
    });
  });
});
