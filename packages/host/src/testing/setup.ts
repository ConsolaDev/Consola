// @effect-diagnostics nodeBuiltinImport:off - It builds the test process's own machine on disk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, expect } from 'vite-plus/test';
import {
  cliVariablesIn,
  copyRecord,
  homeVariables,
  pathWith,
  readCalls,
  writeFakeClis,
} from './machine.ts';

/** Set once the process is isolated, to the trap's record, so a later test file reuses it. */
const ISOLATED = 'CONSOLA_HOST_PROCESS_TRAP';

/**
 * Vitest's setup file for the host (`vite.config.ts` `setupFiles`). It runs before each test file
 * is imported, so before any t3 module could read the environment, and isolates the whole test
 * process, not only a test: `HOME`, `USERPROFILE` and the XDG folders become a temporary home of
 * the process's, every CLI config and login variable is deleted, and `PATH` is a trap: fake
 * `claude`, `codex`, `opencode` and `pi` before `/usr/bin:/bin`.
 *
 * A test's own machine (`isolateMachine`) replaces all of this while it runs. The trap catches a
 * CLI started from anywhere else (an environment captured as a module loaded, or work still
 * running after a test restored the environment), and fails the test file. Nothing here or there
 * can reach the developer's own CLIs or their logins.
 */
const isolateProcess = (): string => {
  const isolated = process.env[ISOLATED];
  if (isolated !== undefined) return isolated;
  const root = mkdtempSync(join(tmpdir(), 'consola-host-process-'));
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  const record = join(root, 'cli-calls.tsv');
  for (const dir of [home, trap]) mkdirSync(dir, { recursive: true });
  writeFileSync(record, '');
  writeFakeClis(trap, record);
  for (const name of cliVariablesIn(process.env)) delete process.env[name];
  Object.assign(process.env, homeVariables(home), { PATH: pathWith(trap), [ISOLATED]: record });
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  return record;
};

const trapRecord = isolateProcess();

afterAll(() => {
  const calls = readCalls(trapRecord);
  // Each test file answers for what ran during it.
  writeFileSync(trapRecord, '');
  const file = relative(process.cwd(), expect.getState().testPath ?? 'a test file');
  copyRecord(`${file} (outside any test's machine)`, calls);
  expect(calls, 'a CLI ran on the test process’s trap, outside any test’s machine').toEqual([]);
});
