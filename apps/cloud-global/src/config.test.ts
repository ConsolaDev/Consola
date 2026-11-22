import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

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
    });
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
});
