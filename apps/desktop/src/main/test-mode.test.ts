import { describe, expect, it } from 'vitest';
import {
  automationsRetryMs,
  automationsTickMs,
  keepLaunchClaudeConfigDir,
  openInApplicationsDir,
} from './test-mode';

describe('keepLaunchClaudeConfigDir', () => {
  const login = {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    CLAUDE_CONFIG_DIR: '/Users/javidev/.claude-work',
  };
  const launch = { CLAUDE_CONFIG_DIR: '/tmp/consola-e2e-a1/claude/config' };

  it('keeps the launch’s folder over the login shell’s, in a test run', () => {
    expect(keepLaunchClaudeConfigDir(login, launch, true)).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: '/tmp/consola-e2e-a1/claude/config',
    });
  });

  it('never takes the login shell’s folder in a test run, even when the launch names none', () => {
    expect(keepLaunchClaudeConfigDir(login, {}, true)).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    });
  });

  it('leaves the login shell’s environment as it is outside a test run', () => {
    expect(keepLaunchClaudeConfigDir(login, launch, false)).toEqual(login);
  });
});

describe('openInApplicationsDir', () => {
  it('is the folder an end-to-end test gives, as an absolute path, in a test run', () => {
    expect(openInApplicationsDir('/tmp/consola-e2e/Applications', true)).toBe(
      '/tmp/consola-e2e/Applications',
    );
  });

  it('is undefined for anything else', () => {
    expect(openInApplicationsDir(undefined, true)).toBeUndefined();
    expect(openInApplicationsDir('', true)).toBeUndefined();
    expect(openInApplicationsDir('Applications', true)).toBeUndefined();
  });

  it('is never read outside a test run', () => {
    expect(openInApplicationsDir('/tmp/consola-e2e/Applications', false)).toBeUndefined();
  });
});

describe('automationsTickMs', () => {
  it('takes a whole number of at least 500 ms, in a test run', () => {
    expect(automationsTickMs('2000', true)).toBe(2000);
    expect(automationsTickMs('500', true)).toBe(500);
  });

  it('is the engine’s own tick (undefined) for anything else', () => {
    expect(automationsTickMs(undefined, true)).toBeUndefined();
    expect(automationsTickMs('', true)).toBeUndefined();
    expect(automationsTickMs('499', true)).toBeUndefined();
    expect(automationsTickMs('2s', true)).toBeUndefined();
    expect(automationsTickMs('1.5', true)).toBeUndefined();
    expect(automationsTickMs('-2000', true)).toBeUndefined();
  });

  it('is never read outside a test run', () => {
    expect(automationsTickMs('2000', false)).toBeUndefined();
  });
});

describe('automationsRetryMs (slice 3, Call 7)', () => {
  it('honours CONSOLA_AUTOMATIONS_RETRY_MS only in a test run, whole and ≥ 500', () => {
    expect(automationsRetryMs('2000', true)).toBe(2000);
    expect(automationsRetryMs('500', true)).toBe(500);
    expect(automationsRetryMs('2000', false)).toBeUndefined();
    expect(automationsRetryMs('499', true)).toBeUndefined();
    expect(automationsRetryMs('1.5', true)).toBeUndefined();
    expect(automationsRetryMs('', true)).toBeUndefined();
    expect(automationsRetryMs('-2000', true)).toBeUndefined();
  });

  it('reads its own variable, not the tick’s', () => {
    const saved = {
      tick: process.env.CONSOLA_AUTOMATIONS_TICK_MS,
      retry: process.env.CONSOLA_AUTOMATIONS_RETRY_MS,
    };
    try {
      process.env.CONSOLA_AUTOMATIONS_TICK_MS = '700';
      process.env.CONSOLA_AUTOMATIONS_RETRY_MS = '900';
      // No value given: it reads the environment, its own variable.
      expect(automationsRetryMs(undefined, true)).toBe(900);
    } finally {
      for (const [name, value] of [
        ['CONSOLA_AUTOMATIONS_TICK_MS', saved.tick],
        ['CONSOLA_AUTOMATIONS_RETRY_MS', saved.retry],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
