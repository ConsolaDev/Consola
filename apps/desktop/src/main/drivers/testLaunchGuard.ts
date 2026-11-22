import path from 'node:path';
import type { HarnessDriver } from './HarnessDriver';

/**
 * Why a test run may not launch this binary, or null when it may: only a
 * binary a harness names by an absolute path, which is a stub the test wrote.
 * Anything else would be looked up (on the login PATH, at an install location
 * like `~/.local/bin/claude`, or by the spawn itself for a bare or relative
 * name) and could reach the person's real CLI with their login, where an
 * unattended turn spends their tokens.
 */
export function testLaunchProblem(driverId: string, binaryPath: string | undefined): string | null {
  if (binaryPath && path.isAbsolute(binaryPath)) return null;
  const named = binaryPath ? ` (\`${binaryPath}\`)` : '';
  return `A test run launches only a stub, named by its absolute path; refused the ambient ${driverId} CLI${named}.`;
}

/** What a test run's launches reached that a spec may fail on. */
export interface TestLaunches {
  /** Refused, nothing run: a bare or relative binary, or the ambient CLI with no stand-in. Every spec fails on one. */
  refused: string[];
  /**
   * Launched the run's stand-in for the ambient CLI (a harness that names no
   * binary, the built-in one): no real CLI ran, but a spec whose every launch
   * is meant to be its own stub fails on one. Health probes are not counted:
   * they ask whether a CLI is installed and start nothing.
   */
  ambient: string[];
}

/** This test run's, for the end-to-end specs to read. */
export const testLaunches: TestLaunches = { refused: [], ambient: [] };

/**
 * In a test launch of the app, guard each driver's `resolveBinary`, which
 * every launch of its CLI goes through (a session or a turn, a title, a
 * commit message, a capability, usage or health probe), so no test run ever
 * runs a CLI it did not provide:
 *
 * - a binary a harness names by an absolute path is the driver's own answer;
 * - a harness that names none (the ambient CLI) gets `standIn`, the stub the
 *   run provides in its place (`CONSOLA_TEST_AMBIENT_CLI`), never the login
 *   PATH or an install location, and the launch is recorded in `ambient`;
 * - anything else, and the ambient CLI when there is no stand-in, is
 *   refused before anything is looked for or runs, logged, and recorded in
 *   `refused`.
 *
 * Main installs it once at startup, only when `isTest`; unit tests install it
 * on drivers of their own.
 */
export function guardTestLaunches(
  drivers: readonly HarnessDriver[],
  standIn: string | undefined,
  record: TestLaunches = testLaunches,
): void {
  const usable = standIn && path.isAbsolute(standIn) ? standIn : undefined;
  for (const driver of drivers) {
    const resolve = driver.resolveBinary.bind(driver);
    const probeHealth = driver.probeHealth.bind(driver);
    // A health probe resolves first, before anything it awaits: that is when it is not counted.
    let probingHealth = false;
    driver.probeHealth = (config) => {
      probingHealth = true;
      try {
        return probeHealth(config);
      } finally {
        probingHealth = false;
      }
    };
    driver.resolveBinary = (config) => {
      const problem = testLaunchProblem(driver.id, config.binaryPath);
      if (problem === null) return resolve(config);
      if (!config.binaryPath && usable) {
        if (!probingHealth) record.ambient.push(`the ambient ${driver.id} CLI`);
        return usable;
      }
      record.refused.push(problem);
      console.error(`[test launch] ${problem}`);
      throw new Error(problem);
    };
  }
}
