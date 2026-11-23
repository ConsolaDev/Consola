import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { RUNNER_SECRET_VARIABLES, SESSION_TEMPLATE } from '../core/runnerDecisions.ts';
import { LocalProvider } from './localProvider.ts';

/** The runner's own variables, as its process holds them: none may reach a sandbox. */
const RUNNER_VARIABLES: Record<string, string> = {
  CONSOLA_RUNNER_SECRET: 'runner-secret-sprocket-0123456789abcdef',
  CONSOLA_RUNNER_REPOSITORIES: 'sprocket/catalog-portal',
  GIT_TOKEN: 'ghp_sprocketRunnerToken0123456789',
  ANTHROPIC_API_KEY: 'sk-ant-sprocket-runner-0123456789',
  OPENAI_API_KEY: 'sk-openai-sprocket-runner-0123456789',
};

/** A sandbox's own variables, as `sandboxEnvFor` gives a claude session. */
const SANDBOX_VARIABLES: Record<string, string> = {
  CONSOLA_SESSION_ID: 'session-sprocket-local-1',
  CONSOLA_HARNESS: 'claude',
  GIT_TOKEN: 'ghp_sprocketSandboxToken0123456789',
  ANTHROPIC_API_KEY: 'sk-ant-sprocket-sandbox-0123456789',
};

const parseEnv = (printed: string): Record<string, string> =>
  Object.fromEntries(
    printed
      .split('\n')
      .filter((row) => row.includes('='))
      .map((row) => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)]),
  );

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('LocalProvider', () => {
  it("runs a sandbox's commands with its own variables over the machine's PATH and home, and none of the runner's", async () => {
    for (const [name, value] of Object.entries(RUNNER_VARIABLES)) vi.stubEnv(name, value);
    const provider = new LocalProvider();
    const sandbox = await provider.create({ template: SESSION_TEMPLATE, env: SANDBOX_VARIABLES });
    let printed = '';
    const command = await sandbox.start({
      argv: ['printenv'],
      onStdout: (chunk) => {
        printed += chunk;
      },
    });
    expect(await command.wait()).toBe(0);
    await sandbox.stop();

    const env = parseEnv(printed);
    expect(env).toMatchObject(SANDBOX_VARIABLES);
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    for (const name of [...RUNNER_SECRET_VARIABLES, 'CONSOLA_RUNNER_REPOSITORIES']) {
      expect(env[name], name).toBe(SANDBOX_VARIABLES[name]);
    }
    for (const value of Object.values(RUNNER_VARIABLES)) expect(printed).not.toContain(value);
  });
});
