import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'pglite:memory',
  REGION: 'eu',
};

function failureOf(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('loads a full environment', () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: 'pglite:memory',
      region: 'eu',
      port: 3101,
    });
  });

  it('reads REGION', () => {
    expect(loadConfig({ ...valid, REGION: 'us' }).region).toBe('us');
  });

  it('reads PORT when set, so two cells can run on one machine', () => {
    expect(loadConfig({ ...valid, PORT: '3102' }).port).toBe(3102);
  });

  it('takes an empty PORT as unset', () => {
    expect(loadConfig({ ...valid, PORT: '' }).port).toBe(3101);
  });

  it('refuses a region that is not listed', () => {
    for (const region of ['EU', 'ap', '']) {
      const failure = failureOf({ ...valid, REGION: region });
      expect(failure.problems).toEqual([expect.stringMatching(/^REGION: /)]);
    }
  });

  it('refuses a port out of range', () => {
    for (const port of ['0', '65536', '31.5', 'abc']) {
      const failure = failureOf({ ...valid, PORT: port });
      expect(failure.problems).toEqual([expect.stringMatching(/^PORT: /)]);
    }
  });

  it('accepts postgres, postgresql and pglite database URLs', () => {
    for (const url of [
      'postgres://u:p@localhost:5432/cell',
      'postgresql://u:p@localhost:5432/cell',
      'pglite:memory',
      'pglite:./.data/cell-db',
    ]) {
      expect(loadConfig({ ...valid, DATABASE_URL: url }).databaseUrl).toBe(url);
    }
  });

  it('refuses an unknown database scheme', () => {
    const failure = failureOf({ ...valid, DATABASE_URL: 'mysql://x' });
    expect(failure.problems).toEqual([expect.stringMatching(/^DATABASE_URL: /)]);
  });

  it('names every problem at once', () => {
    const failure = failureOf({});
    for (const name of ['DATABASE_URL', 'REGION']) {
      expect(failure.problems.some((p) => p.startsWith(`${name}:`))).toBe(true);
      expect(failure.message).toContain(name);
    }
  });
});
