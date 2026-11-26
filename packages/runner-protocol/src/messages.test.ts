import { describe, expect, it } from 'vitest';
import {
  isHarness,
  isHostUrl,
  isRepository,
  readCellMessage,
  readRunnerMessage,
} from './messages.js';

/** What the other side really sends: the value after `JSON.stringify` and `JSON.parse`. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const hello = {
  type: 'hello',
  runnerId: 'runner-1',
  repositories: ['sprocket/catalog-portal'],
  harnesses: ['claude', 'codex'],
  runningSessionIds: ['s-1'],
  endedSessions: [{ sessionId: 's-2', status: 'failed', error: 'The sandbox stopped.' }],
};
const update = { type: 'session.update', sessionId: 's-1', status: 'running' };
const start = {
  type: 'session.start',
  sessionId: 's-1',
  workspaceId: 'ws-1',
  repository: 'sprocket/catalog-portal',
  harness: 'claude',
  passPublicKeyPem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n',
};
const stop = { type: 'session.stop', sessionId: 's-1' };
const agentRun = {
  agent: 'foreman',
  prompt: 'Review pull request 7.',
  checkout: { ref: 'refs/pull/7/head', sha: 'b'.repeat(40) },
  agents: [{ name: 'review', description: 'Reviews.', instructions: 'You review.' }],
  files: [{ path: 'factory.yml', content: 'version: 1\n' }],
};
const agentRunReport = {
  state: 'working',
  agents: [{ id: 'conversation-1', agent: 'review', status: 'working' }],
};

describe('harnesses', () => {
  it('knows claude and codex', () => {
    expect(isHarness('claude')).toBe(true);
    expect(isHarness('codex')).toBe(true);
    expect(isHarness('cursor')).toBe(false);
    expect(isHarness(1)).toBe(false);
  });
});

describe('isRepository', () => {
  it.each(['sprocket/catalog-portal', 'acme/web.app', 'a-b/c_d', 'sprocket/a.b'])(
    'accepts %s',
    (value) => expect(isRepository(value)).toBe(true),
  );
  it.each([
    '../etc',
    'sprocket/..',
    'sprocket/.',
    'sprocket/.git',
    'sprocket',
    'a/b/c',
    'sprocket/',
    '/x',
    'a b/c',
    '',
    4,
    null,
  ])('refuses %s', (value) => expect(isRepository(value)).toBe(false));
});

describe('isHostUrl', () => {
  it.each([
    'https://7420-x.e2b.app',
    'http://127.0.0.1:4100',
    'http://localhost:4100',
    'http://[::1]:4100',
  ])('accepts %s', (value) => expect(isHostUrl(value)).toBe(true));
  it.each([
    'http://sprocket.test',
    'wss://7420-x.e2b.app',
    'ws://127.0.0.1:4100',
    'https://u:p@7420-x.e2b.app',
    'https://7420-x.e2b.app/path',
    'https://7420-x.e2b.app/',
    'https://7420-x.e2b.app?x=1',
    'https://7420-x.e2b.app#x',
    'not a url',
    '',
    7,
  ])('refuses %s', (value) => expect(isHostUrl(value)).toBe(false));
});

describe('readRunnerMessage', () => {
  it('reads hello', () => {
    expect(readRunnerMessage(wire(hello))).toEqual({ ok: true, value: hello });
  });
  it('reads a hello with nothing running and nothing ended', () => {
    const empty = { ...hello, repositories: [], runningSessionIds: [], endedSessions: [] };
    expect(readRunnerMessage(wire(empty))).toEqual({ ok: true, value: empty });
  });
  it('reads an ended session without an error', () => {
    const value = { ...hello, endedSessions: [{ sessionId: 's-2', status: 'stopped' }] };
    expect(readRunnerMessage(wire(value)).ok).toBe(true);
  });
  it('reads session.update, with each optional field', () => {
    expect(readRunnerMessage(wire(update)).ok).toBe(true);
    const full = {
      ...update,
      status: 'failed',
      hostUrl: 'https://7420-x.e2b.app',
      title: 'Fix the cart',
      error: 'The clone failed.',
    };
    expect(readRunnerMessage(wire(full))).toEqual({ ok: true, value: full });
    expect(readRunnerMessage(wire({ type: 'session.update', sessionId: 's-1' })).ok).toBe(true);
  });
  it("reads session.update with an agent run's report", () => {
    const value = { ...update, agentRun: agentRunReport };
    expect(readRunnerMessage(wire(value))).toEqual({ ok: true, value });
  });
  it('refuses session.update with a report it cannot read, naming the field', () => {
    const read = readRunnerMessage(wire({ ...update, agentRun: { state: 'paused' } }));
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('agentRun') });
  });

  it.each([
    ['not an object', 'hello'],
    ['null', null],
    ['an array', []],
    ['no type', { runnerId: 'r' }],
    ['an unknown type', { ...stop, type: 'session.pause' }],
    ['a cell message', start],
    ['an extra field on hello', { ...hello, token: 'x' }],
    ['an extra field on session.update', { ...update, secret: 'x' }],
    ['a hello without a runnerId', { ...hello, runnerId: undefined }],
    ['an empty runnerId', { ...hello, runnerId: '' }],
    ['a hello without endedSessions', { ...hello, endedSessions: undefined }],
    ['a bad repository', { ...hello, repositories: ['../etc'] }],
    ['an unknown harness', { ...hello, harnesses: ['cursor'] }],
    ['repositories not an array', { ...hello, repositories: 'sprocket/a' }],
    ['a bad running id', { ...hello, runningSessionIds: [''] }],
    [
      'an ended session still running',
      { ...hello, endedSessions: [{ sessionId: 's', status: 'running' }] },
    ],
    [
      'an ended session with an extra field',
      { ...hello, endedSessions: [{ sessionId: 's', status: 'failed', x: 1 }] },
    ],
    ['an update without a sessionId', { type: 'session.update', status: 'running' }],
    ['an update with an unknown status', { ...update, status: 'paused' }],
    ['an update with a plain http host', { ...update, hostUrl: 'http://sprocket.test' }],
    ['an update with a wss host', { ...update, hostUrl: 'wss://7420-x.e2b.app' }],
    [
      'an update with a host carrying user info',
      { ...update, hostUrl: 'https://u:p@7420-x.e2b.app' },
    ],
    ['an update with an empty title', { ...update, title: '' }],
    ['an update with a numeric error', { ...update, error: 3 }],
  ])('refuses %s', (_name, value) => {
    const read = readRunnerMessage(wire(value));
    expect(read.ok).toBe(false);
  });

  it('names the field in a reason and never what it held', () => {
    const read = readRunnerMessage(wire({ ...update, hostUrl: 'http://hunter2-secret.test' }));
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('hostUrl') });
    expect(JSON.stringify(read)).not.toContain('hunter2');
    const extra = readRunnerMessage(wire({ ...hello, repositories: ['hunter2-secret'] }));
    expect(JSON.stringify(extra)).not.toContain('hunter2');
  });
});

describe('readCellMessage', () => {
  it('reads session.start and session.stop', () => {
    expect(readCellMessage(wire(start))).toEqual({ ok: true, value: start });
    expect(readCellMessage(wire(stop))).toEqual({ ok: true, value: stop });
  });

  it('reads session.start as an agent run', () => {
    const value = { ...start, agentRun };
    expect(readCellMessage(wire(value))).toEqual({ ok: true, value });
  });

  it.each([
    ['not an object', 'foreman'],
    ['without a prompt', { ...agentRun, prompt: undefined }],
    ['with a path climbing out', { ...agentRun, files: [{ path: '../x', content: '' }] }],
  ])('refuses a session.start whose agent run is %s, naming the field', (_name, run) => {
    const read = readCellMessage(wire({ ...start, agentRun: run }));
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('agentRun') });
  });

  it.each(['../etc', 'sprocket/..', 'sprocket/.git', 'sprocket/.'])(
    'refuses a session.start for %s',
    (repository) => {
      expect(readCellMessage(wire({ ...start, repository })).ok).toBe(false);
    },
  );

  it.each([
    ['an unknown type', { ...stop, type: 'session.kill' }],
    ['a runner message', update],
    ['an extra field', { ...start, gitToken: 'x' }],
    ['an extra field on stop', { ...stop, force: true }],
    ['no workspaceId', { ...start, workspaceId: undefined }],
    ['an unknown harness', { ...start, harness: 'cursor' }],
    ['no key', { ...start, passPublicKeyPem: undefined }],
    ['an empty key', { ...start, passPublicKeyPem: '' }],
    ['a stop without a sessionId', { type: 'session.stop' }],
    ['not an object', 4],
  ])('refuses %s', (_name, value) => {
    expect(readCellMessage(wire(value)).ok).toBe(false);
  });
});
