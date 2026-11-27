import { describe, expect, it } from 'vitest';
import type { CloudConfig } from './config.js';
import { describeStartupFailure } from './startupError.js';

const config: CloudConfig = {
  databaseUrl: 'postgres://consola:s3cret%2Fsprocket@db.sprocket.test:5432/consola_cloud',
  authSecret: 'sprocket-test-secret-that-is-long-enough-to-sign-with',
  publicUrl: 'http://localhost:5175',
  port: 3100,
  region: 'eu',
  google: { clientId: 'sprocket-test-client-id', clientSecret: 'sprocket-test-client-secret' },
  github: {
    clientId: 'Iv23liSprocketTest',
    clientSecret: 'sprocket-test-github-client-secret',
    slug: 'consola-dev',
    privateKeyPath: '/keys/github-app.pem',
  },
  githubWebhookSecret: 'sprocket-test-webhook-secret-0123456789',
  runner: null,
  connectionSecretsKey: 'c3Byb2NrZXQtY29ubmVjdGlvbi1zZWNyZXRzLWtleSE=',
};

describe('describeStartupFailure', () => {
  it('is the first line of the message', () => {
    const failure = new Error("EEXIST: file already exists, mkdir '/dev/null'\n    at mkdirSync");
    expect(describeStartupFailure(failure, config)).toBe(
      "EEXIST: file already exists, mkdir '/dev/null'",
    );
  });

  it("reads the database's answer out of a failed query", () => {
    const failure = new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"\nparams: ', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:5432'),
    });
    expect(describeStartupFailure(failure, config)).toBe('connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('reads a connection refused on every address of a host', () => {
    // What node-postgres rejects with for `localhost` when nothing listens: no message of its own.
    const refused = new AggregateError(
      [
        new Error('connect ECONNREFUSED ::1:5432'),
        new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      ],
      '',
    );
    const failure = new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"\nparams: ', {
      cause: refused,
    });
    expect(describeStartupFailure(failure, config)).toBe('connect ECONNREFUSED ::1:5432');
  });

  it('never shows the database URL or a secret', () => {
    const failure = new Error(
      `could not use ${config.databaseUrl} (client ${config.google.clientSecret}, ${config.authSecret})`,
    );
    const line = describeStartupFailure(failure, config);
    expect(line).toBe('could not use <hidden> (client <hidden>, <hidden>)');
  });

  it("never shows the database's password, encoded or not", () => {
    const failure = new Error('password s3cret%2Fsprocket, decoded s3cret/sprocket');
    expect(describeStartupFailure(failure, config)).toBe('password <hidden>, decoded <hidden>');
  });

  it("never shows the GitHub App's client secret", () => {
    const failure = new Error(`GitHub refused ${config.github?.clientSecret}`);
    expect(describeStartupFailure(failure, config)).toBe('GitHub refused <hidden>');
    expect(describeStartupFailure(failure, { ...config, github: null })).toContain('refused');
  });

  it("never shows the GitHub App's webhook secret", () => {
    const failure = new Error(`could not check with ${config.githubWebhookSecret}`);
    expect(describeStartupFailure(failure, config)).toBe('could not check with <hidden>');
    const unset = { ...config, githubWebhookSecret: null };
    expect(describeStartupFailure(failure, unset)).toContain('could not check');
  });

  it("never shows the runner's secret or the pass key's private part", () => {
    const secret = 'sprocket-runner-secret-0123456789abcdef';
    const d = 'private-part-of-the-pass-key-0123456789abc';
    const withRunner: CloudConfig = {
      ...config,
      runner: {
        secret,
        workspaceId: 'acme',
        passPrivateKey: { kty: 'OKP', crv: 'Ed25519', x: 'public-part', d },
      },
    };
    const failure = new Error(`refused ${secret} with {"d":"${d}"}`);
    expect(describeStartupFailure(failure, withRunner)).toBe(
      'refused <hidden> with {"d":"<hidden>"}',
    );
  });

  it('never shows the connection secrets key', () => {
    const failure = new Error(`could not seal with ${config.connectionSecretsKey}`);
    expect(describeStartupFailure(failure, config)).toBe('could not seal with <hidden>');
  });

  it('says something for a failure with no message', () => {
    expect(describeStartupFailure(new Error(''), config)).toBe('An unexpected error occurred.');
    expect(describeStartupFailure('boom', config)).toBe('boom');
  });
});
