import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeDriver } from './ClaudeDriver';

// (vi.mock is hoisted above the imports.) The real probe runs the user's interactive login shell.
vi.mock('../LoginEnvironment', () => ({
  getLoginEnv: () => process.env,
  loginEnvProblem: () => null,
}));

/*
 * The real-CLI canary (`scripts/claude-steps-canary.mjs`) writes a step's
 * read-only flags out by hand (`scripts/claude-step-flags.mjs`), since it
 * imports nothing from the app. This keeps that copy equal to what the
 * driver launches a step's turn with, so a change to the driver's flags
 * cannot leave the canary probing the old ones.
 */

const FLAGS = path.resolve(__dirname, '../../../scripts/claude-step-flags.mjs');

type StepFlags = (options?: {
  tools?: string;
  allowed?: string[];
  restricted?: boolean;
}) => string[];

/** The names after `--allowedTools`, up to the next flag. */
function allowedOf(flags: string[]): string[] {
  const at = flags.indexOf('--allowedTools');
  const names: string[] = [];
  for (let next = at + 1; next < flags.length && !flags[next].startsWith('--'); next++)
    names.push(flags[next]);
  return names;
}

/** The flags with the allowed tools' names left out: each canary row allows its own. */
function withoutAllowed(flags: string[]): string[] {
  const at = flags.indexOf('--allowedTools');
  return [...flags.slice(0, at + 1), ...flags.slice(at + 1 + allowedOf(flags).length)];
}

describe('the real-CLI canary', () => {
  it('probes the read-only flags a step’s turn launches with', async () => {
    // A path the compiler does not follow: the script is plain Node, outside `src`.
    const { stepFlags } = (await import(pathToFileURL(FLAGS).href)) as { stepFlags: StepFlags };
    const launched = new ClaudeDriver().buildSessionArgs(
      { extraArgs: [] },
      {
        sessionId: 's1',
        resume: false,
        toolPolicy: 'read-only',
        unattended: true,
        initialPrompt: 'p',
      },
    );
    const policy = launched.slice(
      launched.indexOf('--strict-mcp-config'),
      launched.indexOf('--restricted') + 1,
    );
    const canary = stepFlags();
    expect(policy[0]).toBe('--strict-mcp-config');
    expect(withoutAllowed(canary)).toEqual(withoutAllowed(policy));
    // What the canary allows, a step's turn allows too.
    expect(allowedOf(canary).length).toBeGreaterThan(0);
    expect(allowedOf(policy)).toEqual(expect.arrayContaining(allowedOf(canary)));
  });
});
