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
      cloudGlobalUrl: 'http://127.0.0.1:3100',
    });
  });

  it("reads CLOUD_GLOBAL_URL as cloud-global's origin", () => {
    for (const [url, origin] of [
      ['https://global.sprocket.test', 'https://global.sprocket.test'],
      ['https://global.sprocket.test/', 'https://global.sprocket.test'],
      ['https://global.sprocket.test:8443', 'https://global.sprocket.test:8443'],
      ['http://localhost:3100', 'http://localhost:3100'],
      ['http://[::1]:3100/', 'http://[::1]:3100'],
    ] as const) {
      expect(loadConfig({ ...valid, CLOUD_GLOBAL_URL: url }).cloudGlobalUrl).toBe(origin);
    }
  });

  it("takes an empty CLOUD_GLOBAL_URL as unset, so cloud-global's dev address", () => {
    expect(loadConfig({ ...valid, CLOUD_GLOBAL_URL: '' }).cloudGlobalUrl).toBe(
      'http://127.0.0.1:3100',
    );
  });

  it.each([
    ['not an address', 'global.sprocket.test'],
    ['another scheme', 'ftp://global.sprocket.test'],
    ['a user name and password', 'https://cell:secret@global.sprocket.test'],
    ['a path', 'https://global.sprocket.test/api'],
    ['a query', 'https://global.sprocket.test/?keys=1'],
    ['a fragment', 'https://global.sprocket.test/#keys'],
    ['plain http off this machine', 'http://global.sprocket.test'],
  ])('refuses a CLOUD_GLOBAL_URL with %s', (_what, url) => {
    const failure = failureOf({ ...valid, CLOUD_GLOBAL_URL: url });
    expect(failure.problems).toEqual([expect.stringMatching(/^CLOUD_GLOBAL_URL: /)]);
    expect(failure.message).not.toContain('secret');
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
