import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AntigravityDriver } from './AntigravityDriver';
import { ClaudeDriver, runHeadless } from './ClaudeDriver';
import { CodexDriver } from './CodexDriver';
import type { HarnessDriver } from './HarnessDriver';
import { guardTestLaunches, testLaunchProblem, type TestLaunches } from './testLaunchGuard';

/*
 * In an end-to-end test run, no CLI the app launches is one the test did not
 * provide (review S4). A harness's own stub, named by its absolute path, runs
 * as itself; a harness that names none (the ambient CLI, the built-in
 * harness) gets the run's stand-in, never the login PATH or an install
 * location like ~/.local/bin/claude, and the launch is recorded; a bare or
 * relative name, or the ambient CLI with no stand-in, is refused before
 * anything runs, and recorded, so the spec fails.
 */

const STUB = path.resolve('tests/fixtures/claude-steps.cjs');
const STAND_IN = path.resolve('tests/fixtures/ambient-cli.cjs');
const record = (): TestLaunches => ({ refused: [], ambient: [] });
const REFUSED = (driver: string, named = '') =>
  `A test run launches only a stub, named by its absolute path; refused the ambient ${driver} CLI${named}.`;

describe('testLaunchProblem', () => {
  it('passes a binary a harness names by an absolute path', () => {
    expect(testLaunchProblem('claude', STUB)).toBeNull();
  });

  it.each([
    ['no binary at all (the ambient harness)', undefined, ''],
    ['an empty one', '', ''],
    ['a bare name the spawn would look up on PATH', 'claude', ' (`claude`)'],
    ['a relative path', 'bin/claude', ' (`bin/claude`)'],
  ])('refuses %s', (_, binaryPath, named) => {
    expect(testLaunchProblem('claude', binaryPath)).toBe(REFUSED('claude', named));
  });
});

describe('guardTestLaunches', () => {
  it("hands a stub's path to the driver's own resolution, and records nothing", () => {
    const driver = new ClaudeDriver();
    const launches = record();
    guardTestLaunches([driver], STAND_IN, launches);
    expect(driver.resolveBinary({ binaryPath: STUB, extraArgs: [] })).toBe(STUB);
    expect(launches).toEqual({ refused: [], ambient: [] });
  });

  it('gives the ambient harness the stand-in, never looking for an install, and records the launch', () => {
    const driver = new ClaudeDriver();
    const own = vi.spyOn(driver, 'resolveBinary');
    const launches = record();
    guardTestLaunches([driver], STAND_IN, launches);
    expect(driver.resolveBinary({ extraArgs: [] })).toBe(STAND_IN);
    expect(own).not.toHaveBeenCalled();
    expect(launches).toEqual({ refused: [], ambient: ['the ambient claude CLI'] });
  });

  it('refuses and records a bare name, even with a stand-in', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const driver = new ClaudeDriver();
    const launches = record();
    guardTestLaunches([driver], STAND_IN, launches);
    expect(() => driver.resolveBinary({ binaryPath: 'claude', extraArgs: [] })).toThrow(
      REFUSED('claude', ' (`claude`)'),
    );
    expect(launches.refused).toEqual([REFUSED('claude', ' (`claude`)')]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('refused the ambient claude CLI'));
    logged.mockRestore();
  });

  it.each([
    ['no stand-in', undefined],
    ['a stand-in that is no absolute path', 'ambient-cli.cjs'],
  ])("with %s, refuses the ambient CLI in the driver's own launches", async (_, standIn) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const driver = new ClaudeDriver();
    const own = vi.spyOn(driver, 'resolveBinary');
    const launches = record();
    guardTestLaunches([driver], standIn, launches);
    const ambient = { extraArgs: [] };
    await expect(
      driver.generateText(ambient, { prompt: 'Name this session.', schema: {} } as never),
    ).rejects.toThrow(REFUSED('claude'));
    await expect(driver.probeCapabilities(ambient)).rejects.toThrow(REFUSED('claude'));
    await expect(runHeadless('Write a commit message.', { cwd: '/' }, driver)).rejects.toThrow(
      REFUSED('claude'),
    );
    await expect(driver.probeHealth(ambient)).rejects.toThrow(REFUSED('claude'));
    expect(own).not.toHaveBeenCalled();
    expect(launches.refused).toHaveLength(4);
    logged.mockRestore();
  });

  it('a health probe gets the stand-in too, but is not counted as a launch', async () => {
    for (const driver of [
      new ClaudeDriver(),
      new CodexDriver(),
      new AntigravityDriver(),
    ] as HarnessDriver[]) {
      const launches = record();
      guardTestLaunches([driver], '/nonexistent/consola-test-stand-in', launches);
      const health = await driver.probeHealth({ extraArgs: [] });
      expect(health.resolvedBinary).toBe('/nonexistent/consola-test-stand-in');
      expect(launches).toEqual({ refused: [], ambient: [] });
      // Once the probe has started, the next resolution counts again.
      driver.resolveBinary({ extraArgs: [] });
      expect(launches.ambient).toEqual([`the ambient ${driver.id} CLI`]);
    }
  });
});
