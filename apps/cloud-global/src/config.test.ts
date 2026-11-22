import { generateKeyPairSync } from 'node:crypto';
import { REGIONS } from '@consola/cloud-contract';
import { describe, expect, it } from 'vitest';
import { ConfigError, cellKeyVariable, cellUrlVariable, loadConfig } from './config.js';

// A key made for this run only, never one written down.
const cellKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  d: string;
};

const valid = {
  DATABASE_URL: 'pglite:memory',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'http://localhost:5175',
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 's',
  CELL_TOKEN_PRIVATE_KEY: JSON.stringify(cellKey),
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
      authSecret: 'x'.repeat(32),
      publicUrl: 'http://localhost:5175',
      port: 3100,
      google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 's' },
      cellTokenPrivateKey: { kty: 'OKP', crv: 'Ed25519', x: cellKey.x, d: cellKey.d },
      cellUrls: {},
      cellPublicKeys: {},
      github: null,
    });
  });

  describe("the GitHub App's settings", () => {
    const app = {
      GITHUB_APP_CLIENT_ID: 'Iv23liSprocketTest',
      GITHUB_APP_CLIENT_SECRET: 'sprocket-client-secret',
      GITHUB_APP_SLUG: 'consola-dev',
      GITHUB_APP_PRIVATE_KEY_PATH: '/keys/github-app.pem',
    };

    it('reads all four', () => {
      expect(loadConfig({ ...valid, ...app }).github).toEqual({
        clientId: 'Iv23liSprocketTest',
        clientSecret: 'sprocket-client-secret',
        slug: 'consola-dev',
        privateKeyPath: '/keys/github-app.pem',
      });
    });

    it('are optional together, and an empty one counts as unset', () => {
      const empty = Object.fromEntries(Object.keys(app).map((name) => [name, '']));
      expect(loadConfig({ ...valid, ...empty, GITHUB_APP_ID: '' }).github).toBeNull();
    });

    it('do not need the app ID or the webhook secret', () => {
      expect(
        loadConfig({ ...valid, ...app, GITHUB_APP_ID: '', GITHUB_WEBHOOK_SECRET: '' }).github,
      ).not.toBeNull();
    });

    it('refuse a half-set app, naming each one missing', () => {
      const failure = failureOf({ ...valid, GITHUB_APP_SLUG: 'consola-dev' });
      expect(failure.problems).toEqual([
        expect.stringMatching(/^GITHUB_APP_CLIENT_ID: is required once any/),
        expect.stringMatching(/^GITHUB_APP_CLIENT_SECRET: is required once any/),
        expect.stringMatching(/^GITHUB_APP_PRIVATE_KEY_PATH: is required once any/),
      ]);
    });

    it('refuse a slug that is not one, alongside the other problems', () => {
      const failure = failureOf({
        ...valid,
        ...app,
        GITHUB_APP_SLUG: 'https://github.com/apps/consola-dev',
        BETTER_AUTH_SECRET: 'short',
      });
      expect(failure.problems).toEqual([
        expect.stringContaining('BETTER_AUTH_SECRET'),
        expect.stringMatching(/^GITHUB_APP_SLUG: must be the name in the app's address/),
      ]);
    });

    it('never quote the client secret', () => {
      const failure = failureOf({ ...valid, GITHUB_APP_CLIENT_SECRET: 'sprocket-secret-value' });
      expect(failure.message).not.toContain('sprocket-secret-value');
    });
  });

  it("reads each region's cell, as an origin, from its own variable", () => {
    expect(
      loadConfig({
        ...valid,
        CELL_URL_EU: 'http://127.0.0.1:3101/',
        CELL_URL_US: 'https://us.cells.sprocket.test',
      }).cellUrls,
    ).toEqual({ eu: 'http://127.0.0.1:3101', us: 'https://us.cells.sprocket.test' });
  });

  it('names one cell variable for every region the contract lists', () => {
    expect(REGIONS.map(cellUrlVariable)).toEqual(['CELL_URL_EU', 'CELL_URL_US']);
  });

  it('leaves out a region whose cell is unset or empty, so its messages wait', () => {
    expect(loadConfig({ ...valid, CELL_URL_EU: 'http://127.0.0.1:3101' }).cellUrls).toEqual({
      eu: 'http://127.0.0.1:3101',
    });
    expect(loadConfig({ ...valid, CELL_URL_EU: '', CELL_URL_US: '' }).cellUrls).toEqual({});
  });

  it.each([
    ['a path', 'http://127.0.0.1:3101/api'],
    ['a query', 'http://127.0.0.1:3101/?region=eu'],
    ['another scheme', 'ftp://127.0.0.1:3101'],
    ['no address at all', 'acme-cell'],
  ])("refuses a region's cell with %s, naming its variable", (_what, value) => {
    const failure = failureOf({ ...valid, CELL_URL_US: value });
    expect(failure.problems).toEqual([expect.stringMatching(/^CELL_URL_US: /)]);
  });

  it('names a bad cell beside every other problem', () => {
    const failure = failureOf({ CELL_URL_EU: 'acme-cell' });
    expect(failure.problems.some((p) => p.startsWith('DATABASE_URL:'))).toBe(true);
    expect(failure.problems.some((p) => p.startsWith('CELL_URL_EU:'))).toBe(true);
  });

  it('reads PORT when set', () => {
    expect(loadConfig({ ...valid, PORT: '4000' }).port).toBe(4000);
  });

  it('drops a trailing slash from PUBLIC_URL', () => {
    expect(loadConfig({ ...valid, PUBLIC_URL: 'http://localhost:5175/' }).publicUrl).toBe(
      'http://localhost:5175',
    );
  });

  it('refuses PUBLIC_URL with a path', () => {
    const failure = failureOf({ ...valid, PUBLIC_URL: 'http://localhost:5175/app' });
    expect(failure.problems.join('\n')).toContain('PUBLIC_URL');
  });

  it('accepts postgres, postgresql and pglite database URLs', () => {
    for (const url of [
      'postgres://u:p@localhost:5432/cloud',
      'postgresql://u:p@localhost:5432/cloud',
      'pglite:memory',
      'pglite:./.data/cloud-db',
    ]) {
      expect(loadConfig({ ...valid, DATABASE_URL: url }).databaseUrl).toBe(url);
    }
  });

  it('refuses an unknown database scheme', () => {
    const failure = failureOf({ ...valid, DATABASE_URL: 'mysql://x' });
    expect(failure.problems.join('\n')).toContain('DATABASE_URL');
  });

  it('refuses a short secret', () => {
    const failure = failureOf({ ...valid, BETTER_AUTH_SECRET: 'x'.repeat(31) });
    expect(failure.problems.join('\n')).toContain('BETTER_AUTH_SECRET');
  });

  it('ignores the organisation settings an older .env still has', () => {
    expect(loadConfig({ ...valid, ORG_NAME: 'Sprocket', ORG_SLUG: 'Sprocket Inc' })).toEqual(
      loadConfig(valid),
    );
  });

  it('names every problem at once', () => {
    const failure = failureOf({});
    for (const name of [
      'DATABASE_URL',
      'BETTER_AUTH_SECRET',
      'PUBLIC_URL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'CELL_TOKEN_PRIVATE_KEY',
    ]) {
      expect(failure.problems.some((p) => p.startsWith(`${name}:`))).toBe(true);
      expect(failure.message).toContain(name);
    }
  });

  it('keeps only the members of the cell token key it signs with', () => {
    const withMore = { ...cellKey, kid: 'sprocket-key', alg: 'EdDSA', use: 'sig' };
    expect(
      loadConfig({ ...valid, CELL_TOKEN_PRIVATE_KEY: JSON.stringify(withMore) })
        .cellTokenPrivateKey,
    ).toEqual({ kty: 'OKP', crv: 'Ed25519', x: cellKey.x, d: cellKey.d });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not JSON', `d=${cellKey.d}`],
    ['JSON cut short', `{"kty":"OKP","crv":"Ed25519","d":"${cellKey.d}"`],
    ['not an object', JSON.stringify([cellKey])],
    ['another curve', JSON.stringify({ ...cellKey, crv: 'Ed448' })],
    ['another key type', JSON.stringify({ ...cellKey, kty: 'EC' })],
    ['a public key', JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: cellKey.x })],
    ['a short `d`', JSON.stringify({ ...cellKey, d: cellKey.d.slice(1) })],
    ['a `d` that is not base64url', JSON.stringify({ ...cellKey, d: `${cellKey.d.slice(1)}+` })],
    ['no `x`', JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: cellKey.d })],
  ])('refuses a cell token key that is %s, naming it and never echoing it', (_what, value) => {
    const failure = failureOf({ ...valid, CELL_TOKEN_PRIVATE_KEY: value });
    expect(failure.problems).toEqual([expect.stringMatching(/^CELL_TOKEN_PRIVATE_KEY: /)]);
    expect(failure.message).toContain('CELL_TOKEN_PRIVATE_KEY');
    if (value) expect(failure.message).not.toContain(value);
    expect(failure.message).not.toContain(cellKey.d);
    expect(failure.message).not.toContain(cellKey.d.slice(1, 20));
  });

  describe("each region's cell's public key", () => {
    // Keys made for this run only. Each cell signs its requests with its own.
    const publicOf = () => {
      const { x } = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
      return { kty: 'OKP', crv: 'Ed25519', x: x as string };
    };
    const euCell = publicOf();
    const usCell = publicOf();

    it('names one variable for every region the contract lists', () => {
      expect(REGIONS.map(cellKeyVariable)).toEqual(['CELL_PUBLIC_KEY_EU', 'CELL_PUBLIC_KEY_US']);
    });

    it("reads each region's, keeping only what checks a signature", () => {
      const withMore = { ...usCell, kid: 'sprocket-us', alg: 'EdDSA', use: 'sig' };
      expect(
        loadConfig({
          ...valid,
          CELL_PUBLIC_KEY_EU: JSON.stringify(euCell),
          CELL_PUBLIC_KEY_US: JSON.stringify(withMore),
        }).cellPublicKeys,
      ).toEqual({ eu: euCell, us: usCell });
    });

    it('leaves out a region whose key is unset or empty, so its cell can ask for nothing', () => {
      expect(
        loadConfig({ ...valid, CELL_PUBLIC_KEY_EU: JSON.stringify(euCell), CELL_PUBLIC_KEY_US: '' })
          .cellPublicKeys,
      ).toEqual({ eu: euCell });
    });

    it.each([
      ['not JSON', 'x=abc', /JSON Web Key on one line/],
      ['not an object', JSON.stringify([euCell]), /JSON Web Key on one line/],
      ['another curve', JSON.stringify({ ...euCell, crv: 'Ed448' }), /Ed25519/],
      ['a short `x`', JSON.stringify({ ...euCell, x: euCell.x.slice(1) }), /32 bytes/],
      ['no `x`', JSON.stringify({ kty: 'OKP', crv: 'Ed25519' }), /32 bytes/],
    ])('refuses a key that is %s', (_what, value, problem) => {
      const failure = failureOf({ ...valid, CELL_PUBLIC_KEY_EU: value });
      expect(failure.problems).toEqual([expect.stringMatching(/^CELL_PUBLIC_KEY_EU: /)]);
      expect(failure.problems[0]).toMatch(problem);
    });

    it("refuses a cell's private key, and never echoes it", () => {
      const pair = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
      const failure = failureOf({ ...valid, CELL_PUBLIC_KEY_US: JSON.stringify(pair) });
      expect(failure.problems).toEqual([
        expect.stringMatching(/^CELL_PUBLIC_KEY_US: .*private part \(`d`\)/),
      ]);
      expect(failure.message).not.toContain(pair.d as string);
    });

    it('refuses one key for two cells: each signs with its own', () => {
      const failure = failureOf({
        ...valid,
        CELL_PUBLIC_KEY_EU: JSON.stringify(euCell),
        CELL_PUBLIC_KEY_US: JSON.stringify(euCell),
      });
      expect(failure.problems).toEqual([
        'CELL_PUBLIC_KEY_US: is the key CELL_PUBLIC_KEY_EU names; each cell signs with a key of its own',
      ]);
    });

    it("refuses cloud-global's own cell token key, so nothing it signs can pass for a cell's", () => {
      const own = { kty: 'OKP', crv: 'Ed25519', x: cellKey.x };
      const failure = failureOf({ ...valid, CELL_PUBLIC_KEY_EU: JSON.stringify(own) });
      expect(failure.problems).toEqual([
        "CELL_PUBLIC_KEY_EU: is the public half of CELL_TOKEN_PRIVATE_KEY, cloud-global's own key; a cell signs with a key of its own",
      ]);
    });

    it('names a bad key beside every other problem', () => {
      const failure = failureOf({
        ...valid,
        BETTER_AUTH_SECRET: 'short',
        CELL_PUBLIC_KEY_EU: 'nope',
      });
      expect(failure.problems).toEqual([
        expect.stringMatching(/^BETTER_AUTH_SECRET: /),
        expect.stringMatching(/^CELL_PUBLIC_KEY_EU: /),
      ]);
    });
  });
});
