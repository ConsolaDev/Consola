import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'pglite:memory',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'http://localhost:5175',
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 's',
  ORG_NAME: 'Sprocket',
  ORG_SLUG: 'sprocket',
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
      organization: { name: 'Sprocket', slug: 'sprocket' },
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

  it('refuses a slug that is not lowercase letters, digits and dashes', () => {
    const failure = failureOf({ ...valid, ORG_SLUG: 'Sprocket Inc' });
    expect(failure.problems.join('\n')).toContain('ORG_SLUG');
  });

  it('names every problem at once', () => {
    const failure = failureOf({});
    for (const name of [
      'DATABASE_URL',
      'BETTER_AUTH_SECRET',
      'PUBLIC_URL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'ORG_NAME',
      'ORG_SLUG',
    ]) {
      expect(failure.problems.some((p) => p.startsWith(`${name}:`))).toBe(true);
      expect(failure.message).toContain(name);
    }
  });
});
