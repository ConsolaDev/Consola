import { describe, expect, it } from 'vitest';
import {
  type CloudSession,
  type CloudSessionStatus,
  nextStatus,
  readStartRequest,
  transition,
} from './cloudSession.js';

const session = (status: CloudSessionStatus): CloudSession => ({
  id: 'session-1',
  workspaceId: 'acme',
  personId: 'person-1',
  repository: 'sprocket/catalog-portal',
  harness: 'claude',
  status,
  title: null,
  hostUrl: null,
  error: null,
  errorCode: null,
  runnerId: 'runner-1',
  createdAt: 100,
  endedAt: null,
});

describe('nextStatus', () => {
  it.each([
    ['starting', 'running', 'running'],
    ['starting', 'failed', 'failed'],
    ['running', 'stopped', 'stopped'],
    ['running', 'failed', 'failed'],
    // Not a step the lifecycle has: the status stays.
    ['starting', 'stopped', 'starting'],
    ['running', 'running', 'running'],
    ['stopped', 'running', 'stopped'],
    ['stopped', 'failed', 'stopped'],
    ['failed', 'running', 'failed'],
    ['failed', 'stopped', 'failed'],
  ] as const)('%s with %s is %s', (current, update, expected) => {
    expect(nextStatus(current, update)).toBe(expected);
  });
});

describe('transition', () => {
  it('sets endedAt on reaching stopped or failed', () => {
    expect(transition(session('running'), 'stopped', 200)).toMatchObject({
      status: 'stopped',
      endedAt: 200,
    });
    expect(transition(session('starting'), 'failed', 300)).toMatchObject({
      status: 'failed',
      endedAt: 300,
    });
  });

  it('leaves endedAt null while the session lives', () => {
    expect(transition(session('starting'), 'running', 200)).toMatchObject({
      status: 'running',
      endedAt: null,
    });
  });

  it('never moves an ended session, nor changes its end', () => {
    const ended = { ...session('stopped'), endedAt: 150 };
    expect(transition(ended, 'failed', 999)).toEqual(ended);
    expect(transition(ended, 'running', 999)).toEqual(ended);
  });
});

describe('readStartRequest', () => {
  it('reads exactly a repository and a harness', () => {
    expect(readStartRequest({ repository: 'sprocket/catalog-portal', harness: 'codex' })).toEqual({
      ok: true,
      value: { repository: 'sprocket/catalog-portal', harness: 'codex' },
    });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'sprocket/catalog-portal'],
    ['no harness', { repository: 'sprocket/catalog-portal' }],
    ['no repository', { harness: 'claude' }],
    [
      'an extra field',
      { repository: 'sprocket/catalog-portal', harness: 'claude', workspaceId: 'x' },
    ],
    ['a repository that is not owner/name', { repository: '../etc', harness: 'claude' }],
    ['a harness nobody runs', { repository: 'sprocket/catalog-portal', harness: 'vim' }],
    ['a number for a repository', { repository: 7, harness: 'claude' }],
  ])('refuses %s', (_name, body) => {
    expect(readStartRequest(body).ok).toBe(false);
  });
});
