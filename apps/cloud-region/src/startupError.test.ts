import { describe, expect, it } from 'vitest';
import type { CellConfig } from './config.js';
import { describeStartupFailure } from './startupError.js';

const config: CellConfig = {
  databaseUrl: 'postgres://consola:s3cret%2Fsprocket@db.sprocket.test:5432/consola_cell_eu',
  region: 'eu',
  port: 3101,
  cloudGlobalUrl: 'http://127.0.0.1:3100',
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

  it('never shows the database URL or its password, encoded or not', () => {
    const failure = new Error(
      `could not use ${config.databaseUrl} (password s3cret%2Fsprocket, decoded s3cret/sprocket)`,
    );
    expect(describeStartupFailure(failure, config)).toBe(
      'could not use <hidden> (password <hidden>, decoded <hidden>)',
    );
  });

  it('says something for a failure with no message', () => {
    expect(describeStartupFailure(new Error(''), config)).toBe('An unexpected error occurred.');
    expect(describeStartupFailure('boom', config)).toBe('boom');
  });
});
