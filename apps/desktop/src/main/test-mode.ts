import * as path from 'node:path';

/** A test run: `NODE_ENV=test`, which also moves `userData` to the test profile (`index.ts`). */
export const isTest = process.env.NODE_ENV === 'test';

/** Keep E2E launches off the desktop unless explicitly debugging visibly. */
export const isBackgroundTest = isTest && process.env.CONSOLA_E2E_HEADED !== '1';

/**
 * The automations tick an end-to-end test asks for (`CONSOLA_AUTOMATIONS_TICK_MS`),
 * so "across ticks" takes seconds: honoured only in a test run, and only as a
 * whole number of at least 500 ms. Anything else is undefined, the engine's own.
 */
export function automationsTickMs(
  raw = process.env.CONSOLA_AUTOMATIONS_TICK_MS,
  test = isTest,
): number | undefined {
  if (!test || raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const ms = Number.parseInt(raw, 10);
  return ms >= 500 ? ms : undefined;
}

/**
 * The folder "Open in" looks for apps in during a test run, for an
 * end-to-end test that says which apps are installed
 * (`CONSOLA_OPEN_IN_APPLICATIONS`, a folder of empty bundles): honoured only
 * in a test run, and only as an absolute path. Anything else is undefined.
 */
export function openInApplicationsDir(
  raw = process.env.CONSOLA_OPEN_IN_APPLICATIONS,
  test = isTest,
): string | undefined {
  return test && raw && path.isAbsolute(raw) ? raw : undefined;
}

/**
 * The login shell's environment as a test run uses it. A Claude harness that
 * pins no folder reads `CLAUDE_CONFIG_DIR`, and the E2E launch points that at
 * a folder of the test profile's; were the login shell's to win, a person
 * whose rc file exports one would have every such harness read their own
 * config and transcripts. So in a test run the launch environment's value
 * stands, set or not. Outside one, `login` is returned as it is.
 */
export function keepLaunchClaudeConfigDir(
  login: NodeJS.ProcessEnv,
  launch: NodeJS.ProcessEnv = process.env,
  test = isTest,
): NodeJS.ProcessEnv {
  if (!test) return login;
  const env = { ...login };
  delete env.CLAUDE_CONFIG_DIR;
  if (launch.CLAUDE_CONFIG_DIR !== undefined) env.CLAUDE_CONFIG_DIR = launch.CLAUDE_CONFIG_DIR;
  return env;
}

/**
 * Hands an object to the E2E suite, which reaches it from
 * `electronApp.evaluate` as `globalThis.__consolaTest[name]`. Only in a test
 * launch: anywhere else nothing is exposed, so no other code in main can come
 * to lean on it either.
 */
export function exposeToTests(name: string, value: unknown): void {
  if (process.env.NODE_ENV !== 'test') return;
  const root = globalThis as { __consolaTest?: Record<string, unknown> };
  root.__consolaTest ??= {};
  root.__consolaTest[name] = value;
}
