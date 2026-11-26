import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, seedRefusal } from './config.js';

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
      runner: null,
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

// Stand-ins, never real credentials: a runner secret and a pass key's JWK on one line.
const SECRET = 'sprocket-runner-secret-0123456789abcdef';
const JWK = { kty: 'OKP', crv: 'Ed25519', x: 'x-of-the-key', d: 'd-of-the-key' };
const runner = {
  RUNNER_SECRET: SECRET,
  RUNNER_WORKSPACE_ID: 'acme',
  PASS_PRIVATE_KEY: JSON.stringify(JWK),
};

describe('loadConfig, the runner and its passes', () => {
  it('has no runner when none of its three settings is set, or each is empty', () => {
    expect(loadConfig(valid).runner).toBeNull();
    expect(
      loadConfig({ ...valid, RUNNER_SECRET: '', RUNNER_WORKSPACE_ID: '', PASS_PRIVATE_KEY: '' })
        .runner,
    ).toBeNull();
  });

  it('reads all three together, the key as the JSON object it holds', () => {
    expect(loadConfig({ ...valid, ...runner }).runner).toEqual({
      secret: SECRET,
      workspaceId: 'acme',
      passPrivateKey: JWK,
    });
  });

  it.each([['RUNNER_SECRET'], ['RUNNER_WORKSPACE_ID'], ['PASS_PRIVATE_KEY']] as const)(
    'refuses the other two without %s, so no session starts without a key',
    (left) => {
      for (const unset of [undefined, '']) {
        const failure = failureOf({ ...valid, ...runner, [left]: unset });
        expect(failure.problems).toEqual([expect.stringMatching(new RegExp(`^${left}: `))]);
        expect(failure.message).not.toContain(SECRET);
        expect(failure.message).not.toContain('d-of-the-key');
      }
    },
  );

  it('refuses one of the three alone, naming the two it needs', () => {
    const failure = failureOf({ ...valid, RUNNER_SECRET: SECRET });
    expect(failure.problems).toEqual([
      expect.stringMatching(/^RUNNER_WORKSPACE_ID: /),
      expect.stringMatching(/^PASS_PRIVATE_KEY: /),
    ]);
    expect(failure.message).not.toContain(SECRET);
  });

  it.each([
    ['shorter than 32 characters', 'short-secret'],
    ['with a space', 'sprocket runner secret 0123456789abcdef'],
    ['with a character no header carries', 'sprocket-runner-secret-0123456789abcdéf'],
  ])('refuses a RUNNER_SECRET %s, never quoting it', (_what, secret) => {
    const failure = failureOf({ ...valid, ...runner, RUNNER_SECRET: secret });
    expect(failure.problems).toEqual([expect.stringMatching(/^RUNNER_SECRET: /)]);
    expect(failure.message).not.toContain(secret);
  });

  it.each([
    ['not JSON', '{"kty":"OKP","d":"d-of-the-key"'],
    ['a JSON list', JSON.stringify([JWK])],
    ['a JSON string', JSON.stringify('d-of-the-key')],
    ['JSON null', 'null'],
  ])('refuses a PASS_PRIVATE_KEY that is %s, never quoting it', (_what, key) => {
    const failure = failureOf({ ...valid, ...runner, PASS_PRIVATE_KEY: key });
    expect(failure.problems).toEqual([expect.stringMatching(/^PASS_PRIVATE_KEY: /)]);
    expect(failure.message).not.toContain('d-of-the-key');
  });
});

describe('seedRefusal', () => {
  it('lets the demo seed write to a local PGlite folder only', () => {
    expect(seedRefusal('pglite:./.data/cell-eu-db')).toBeNull();
    for (const url of [
      'postgres://consola@localhost:5432/cell',
      'postgresql://consola@db.example.com/cell',
      'pglite:memory',
      'pglite:',
    ]) {
      expect([url, seedRefusal(url)]).toEqual([url, expect.any(String)]);
    }
  });
});
