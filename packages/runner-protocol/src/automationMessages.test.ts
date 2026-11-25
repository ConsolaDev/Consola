import { describe, expect, it } from 'vitest';
import {
  FACTORIES_PER_ANSWER_MAX,
  FACTORY_FILE_PATH_MAX,
  FACTORY_FILE_TEXT_MAX,
  FILES_PER_FACTORY_MAX,
  GITHUB_TOKEN_MAX,
  isRequestId,
  RUN_PROBLEM_TEXT_MAX,
  RUN_PROBLEMS_MAX,
  TOKEN_REFUSAL_MAX,
} from './automationMessages.js';
import { readCellMessage, readRunnerMessage } from './messages.js';
import type { RunRecord } from './run.js';

/** What the other side really sends: the value after `JSON.stringify` and `JSON.parse`. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const run: RunRecord = {
  id: 'run-1',
  factoryId: 'factory-1',
  factoryVersion: 3,
  parent: null,
  automation: 'review-pr',
  status: 'needs-approval',
  waitingOn: null,
  trigger: 'event',
  triggerDetail: 'pull_request.opened',
  startedBy: null,
  item: {
    url: 'https://github.com/sprocket/catalog-portal/pull/12',
    title: 'Fix the cart',
    kind: 'pr',
    repo: 'sprocket/catalog-portal',
    number: 12,
  },
  runner: 'cloud',
  steps: [
    {
      id: 'review',
      kind: 'agent',
      status: 'pending',
      attempt: 1,
      agent: 'reviewer',
      model: null,
      startedAt: null,
      finishedAt: null,
      costUsd: null,
      error: null,
      skipped: null,
      outputs: null,
      artifacts: [],
      turn: null,
      command: null,
      previous: [],
      reminded: false,
      output: null,
    },
  ],
  request: null,
  summary: null,
  error: null,
  costUsd: null,
  createdAt: '2026-11-25T09:58:00.000Z',
  startedAt: null,
  finishedAt: null,
  updatedAt: '2026-11-25T09:58:00.000Z',
};

const deliveryId = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

// Runner to cell.
const factoriesRequest = { type: 'factories.request', requestId: 'req-1' };
const pickRequest = { ...factoriesRequest, only: { factoryId: 'factory-1', version: 3 } };
const runRecord = { type: 'run.record', run };
const ack = { type: 'github.event.ack', deliveryId };
const tokenRequest = {
  type: 'github.token.request',
  requestId: 'req_2',
  runId: 'run-1',
  stepId: 'review',
  repository: 'sprocket/catalog-portal',
  permissions: { contents: 'read', pull_requests: 'write' },
};

// Cell to runner.
const event = {
  type: 'github.event',
  deliveryId,
  event: {
    name: 'pull_request',
    action: 'opened',
    repository: 'sprocket/catalog-portal',
    number: 12,
    url: 'https://github.com/sprocket/catalog-portal/pull/12',
    title: 'Fix the cart',
    author: 'octo-dev',
    draft: false,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    headRef: 'fix/cart',
    baseRef: 'main',
    fork: false,
  },
};
const factories = {
  type: 'factories',
  requestId: 'req-1',
  factories: [
    {
      factoryId: 'factory-1',
      version: 3,
      files: [
        { path: 'factory.yml', content: 'automations: {}\n' },
        { path: 'agents/reviewer.md', content: '' },
      ],
    },
  ],
};
const answered = { type: 'run.answered', run, decision: 'approved', personId: 'person-1' };
const token = {
  type: 'github.token',
  requestId: 'req_2',
  token: 'ghs_16C7e42F292c6912E7710c838347Ae178B4a',
  expiresAt: '2026-11-25T11:00:00Z',
};
const tokenRefused = {
  type: 'github.token.refused',
  requestId: 'req_2',
  reason: "The workspace's installation does not cover sprocket/catalog-portal.",
};
const runRefused = {
  type: 'run.refused',
  runId: 'run-1',
  problems: [{ field: 'steps[0].attempt', message: 'Attempts are numbered from 1.' }],
};

describe('isRequestId', () => {
  it.each(['req-1', 'a', 'A_b-9', 'x'.repeat(64)])('accepts %s', (value) =>
    expect(isRequestId(value)).toBe(true),
  );
  it.each(['', 'x'.repeat(65), 'a b', 'a.b', 'a/b', 'é', 7, null])('refuses %s', (value) =>
    expect(isRequestId(value)).toBe(false),
  );
});

describe('the runner messages for runs', () => {
  it.each([
    ['factories.request', factoriesRequest],
    ['factories.request for one factory at one version', pickRequest],
    ['run.record', runRecord],
    ['github.event.ack', ack],
    ['github.token.request', tokenRequest],
  ])('reads %s', (_name, value) => {
    expect(readRunnerMessage(wire(value))).toEqual({ ok: true, value });
  });

  it.each([
    ['a factories request with a bad request id', { ...factoriesRequest, requestId: 'a b' }],
    ['a factories request without a request id', { type: 'factories.request' }],
    ['a factories request with an extra field', { ...factoriesRequest, all: true }],
    ['a factories request whose only is null', { ...factoriesRequest, only: null }],
    ['an only without its version', { ...factoriesRequest, only: { factoryId: 'f' } }],
    ['an only at version 0', { ...factoriesRequest, only: { factoryId: 'f', version: 0 } }],
    [
      'an only with an empty factory id',
      { ...factoriesRequest, only: { factoryId: '', version: 1 } },
    ],
    ['an only with an extra field', { ...pickRequest, only: { ...pickRequest.only, team: 't' } }],
    ['a run record without its run', { type: 'run.record' }],
    ['a run record with an extra field', { ...runRecord, workspaceId: 'ws-1' }],
    ['a run record whose run is malformed', { ...runRecord, run: { ...run, status: 'paused' } }],
    ['an ack with a bad delivery id', { ...ack, deliveryId: 'not a delivery' }],
    ['an ack with an extra field', { ...ack, runs: 2 }],
    ['a token request with a bad request id', { ...tokenRequest, requestId: '' }],
    ['a token request without a run', { ...tokenRequest, runId: undefined }],
    ['a token request with an empty step id', { ...tokenRequest, stepId: '' }],
    ['a token request for a bad repository', { ...tokenRequest, repository: 'sprocket/.git' }],
    ['a token request with no permissions', { ...tokenRequest, permissions: {} }],
    ['a token request asking admin', { ...tokenRequest, permissions: { contents: 'admin' } }],
    ['a token request with an extra field', { ...tokenRequest, token: 'x' }],
    ['a cell message', runRefused],
  ])('refuses %s', (_name, value) => {
    expect(readRunnerMessage(wire(value)).ok).toBe(false);
  });
});

describe('the cell messages for runs', () => {
  it.each([
    ['github.event', event],
    ['factories', factories],
    ['factories, with none', { ...factories, factories: [] }],
    ['run.answered', answered],
    ['run.answered, rejected', { ...answered, decision: 'rejected' }],
    ['github.token', token],
    ['github.token.refused', tokenRefused],
    ['run.refused', runRefused],
  ])('reads %s', (_name, value) => {
    expect(readCellMessage(wire(value))).toEqual({ ok: true, value });
  });

  it('reads factories at their bounds', () => {
    const files = Array.from({ length: FILES_PER_FACTORY_MAX }, (_, i) => ({
      path: `skills/s/${i}.md`,
      content: '',
    }));
    const most = {
      ...factories,
      factories: Array.from({ length: FACTORIES_PER_ANSWER_MAX }, (_, i) => ({
        factoryId: `factory-${i}`,
        version: 1,
        files: i === 0 ? files : [],
      })),
    };
    expect(readCellMessage(wire(most)).ok).toBe(true);
    const longest = {
      ...factories,
      factories: [
        {
          factoryId: 'f',
          version: 1,
          files: [
            { path: 'p'.repeat(FACTORY_FILE_PATH_MAX), content: 'c'.repeat(FACTORY_FILE_TEXT_MAX) },
          ],
        },
      ],
    };
    expect(readCellMessage(wire(longest)).ok).toBe(true);
  });

  const factory = factories.factories[0];
  it.each([
    ['an event with a bad delivery id', { ...event, deliveryId: '' }],
    ["an event carrying GitHub's payload", { ...event, payload: {} }],
    [
      'an event of a name the protocol does not name',
      { ...event, event: { ...event.event, name: 'push' } },
    ],
    ['an event with a short sha', { ...event, event: { ...event.event, headSha: 'abc' } }],
    ['factories with a bad request id', { ...factories, requestId: 'x'.repeat(65) }],
    ['factories that are not a list', { ...factories, factories: factory }],
    [
      'too many factories',
      {
        ...factories,
        factories: Array.from({ length: FACTORIES_PER_ANSWER_MAX + 1 }, () => factory),
      },
    ],
    [
      'a factory with too many files',
      {
        ...factories,
        factories: [
          {
            ...factory,
            files: Array.from({ length: FILES_PER_FACTORY_MAX + 1 }, (_, i) => ({
              path: `${i}`,
              content: '',
            })),
          },
        ],
      },
    ],
    ['a factory at version 0', { ...factories, factories: [{ ...factory, version: 0 }] }],
    ['a factory with an extra field', { ...factories, factories: [{ ...factory, team: 't' }] }],
    [
      'a file with an empty path',
      { ...factories, factories: [{ ...factory, files: [{ path: '', content: '' }] }] },
    ],
    [
      'a file whose path is past its bound',
      {
        ...factories,
        factories: [
          { ...factory, files: [{ path: 'p'.repeat(FACTORY_FILE_PATH_MAX + 1), content: '' }] },
        ],
      },
    ],
    [
      'a file whose text is past its bound',
      {
        ...factories,
        factories: [
          { ...factory, files: [{ path: 'p', content: 'c'.repeat(FACTORY_FILE_TEXT_MAX + 1) }] },
        ],
      },
    ],
    [
      'a file without its text',
      { ...factories, factories: [{ ...factory, files: [{ path: 'p' }] }] },
    ],
    ['an answer with an unknown decision', { ...answered, decision: 'maybe' }],
    ['an answer without a person', { ...answered, personId: '' }],
    ['an answer whose run is malformed', { ...answered, run: { ...run, steps: 'none' } }],
    ['an answer with an extra field', { ...answered, comment: 'Looks fine' }],
    ['a token with a space', { ...token, token: 'ghs_16C7 e42F' }],
    ['an empty token', { ...token, token: '' }],
    ['a token past its bound', { ...token, token: 'g'.repeat(GITHUB_TOKEN_MAX + 1) }],
    ['a token that expires at no time', { ...token, expiresAt: 'in an hour' }],
    ['a token that expires in whole seconds', { ...token, expiresAt: 1764068400 }],
    ['a token with an extra field', { ...token, permissions: {} }],
    ['a refusal without a reason', { ...tokenRefused, reason: '' }],
    [
      'a refusal whose reason is past its bound',
      { ...tokenRefused, reason: 'r'.repeat(TOKEN_REFUSAL_MAX + 1) },
    ],
    ['a run refused with no problems', { ...runRefused, problems: [] }],
    [
      'a run refused with too many problems',
      {
        ...runRefused,
        problems: Array.from({ length: RUN_PROBLEMS_MAX + 1 }, () => runRefused.problems[0]),
      },
    ],
    ['a problem without its message', { ...runRefused, problems: [{ field: 'id' }] }],
    [
      'a problem whose message is past its bound',
      { ...runRefused, problems: [{ field: 'id', message: 'm'.repeat(RUN_PROBLEM_TEXT_MAX + 1) }] },
    ],
    ['a run refused without its run', { ...runRefused, runId: '' }],
    ['a runner message', tokenRequest],
  ])('refuses %s', (_name, value) => {
    expect(readCellMessage(wire(value)).ok).toBe(false);
  });

  it("never holds a token in a reason, whatever is wrong with the token's message", () => {
    const secret = 'ghs_hunter2SECRET';
    for (const value of [
      { ...token, token: `${secret} x` },
      { ...token, token: secret, expiresAt: 'soon' },
      { ...token, token: secret, requestId: '' },
      { ...token, token: secret, extra: 1 },
      { ...token, token: `${secret}${'x'.repeat(GITHUB_TOKEN_MAX)}` },
    ]) {
      const read = readCellMessage(wire(value));
      expect(read.ok).toBe(false);
      expect(JSON.stringify(read)).not.toContain('hunter2');
    }
  });

  it('names the field in a reason and never what it held', () => {
    const read = readCellMessage(
      wire({
        ...factories,
        factories: [{ ...factory, files: [{ path: '', content: 'hunter2' }] }],
      }),
    );
    expect(read).toEqual({
      ok: false,
      reason: expect.stringContaining('factories[0].files[0].path'),
    });
    expect(JSON.stringify(read)).not.toContain('hunter2');
  });
});
