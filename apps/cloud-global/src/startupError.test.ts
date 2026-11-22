import { describe, expect, it } from 'vitest';
import type { CloudConfig } from './config.js';
import { describeStartupFailure } from './startupError.js';

const config: CloudConfig = {
  databaseUrl: 'postgres://consola:s3cret-sprocket@db.sprocket.test:5432/consola_cloud',
  authSecret: 'sprocket-test-secret-that-is-long-enough-to-sign-with',
  publicUrl: 'http://localhost:5175',
  port: 3100,
  google: { clientId: 'sprocket-test-client-id', clientSecret: 'sprocket-test-client-secret' },
  cellTokenPrivateKey: {
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'sprocket-test-cell-key-public-part',
    d: 'sprocket-test-cell-key-private-part',
  },
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
      `could not use ${config.databaseUrl} (password s3cret-sprocket, client ${config.google.clientSecret}, ${config.authSecret})`,
    );
    const line = describeStartupFailure(failure, config);
    expect(line).toBe('could not use <hidden> (password <hidden>, client <hidden>, <hidden>)');
  });

  it("never shows the cell token's private key", () => {
    const failure = new Error(`could not sign with ${config.cellTokenPrivateKey.d}`);
    expect(describeStartupFailure(failure, config)).toBe('could not sign with <hidden>');
  });

  it('says something for a failure with no message', () => {
    expect(describeStartupFailure(new Error(''), config)).toBe('An unexpected error occurred.');
    expect(describeStartupFailure('boom', config)).toBe('boom');
  });
});
