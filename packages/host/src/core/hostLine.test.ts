import { describe, expect, it } from 'vite-plus/test';
import { HOST_LINE_TYPES, readHostLine } from './hostLine.ts';
import type { HostLine } from './hostLine.ts';

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('readHostLine', () => {
  it.each<HostLine>([
    { type: 'ready', port: 7420 },
    { type: 'dev-pass', pass: 'a.b.c', expiresInSeconds: 43_200 },
    { type: 'title', title: 'Sprocket catalog' },
    { type: 'status', status: 'working' },
    { type: 'status', status: 'waiting' },
    { type: 'status', status: 'idle' },
    { type: 'exit', reason: 'idle' },
    { type: 'agent-run', state: 'working' },
    {
      type: 'agent-run',
      state: 'done',
      summary: 'Posted the review.',
      agents: [
        { id: 'thread-2', agent: 'reviewer', status: 'done', summary: 'Two findings.' },
        { id: 'thread-3', agent: 'tester', status: 'failed' },
      ],
    },
  ])('reads %j', (line) => {
    expect(readHostLine(roundTrip(line))).toEqual(line);
  });

  it('names every type it reads in HOST_LINE_TYPES', () => {
    expect([...HOST_LINE_TYPES].sort()).toEqual([
      'agent-run',
      'dev-pass',
      'exit',
      'ready',
      'status',
      'title',
    ]);
  });

  it.each([
    ['not an object', 'ready'],
    ['null', null],
    ['a list', [{ type: 'ready', port: 1 }]],
    ['an unknown type', { type: 'hello' }],
    ['a port of 0', { type: 'ready', port: 0 }],
    ['a port out of range', { type: 'ready', port: 65_536 }],
    ['a port that is not whole', { type: 'ready', port: 74.2 }],
    ['a port as text', { type: 'ready', port: '7420' }],
    ['an extra field', { type: 'ready', port: 7420, host: '0.0.0.0' }],
    ['a title that is not text', { type: 'title', title: 7 }],
    ['an unknown status', { type: 'status', status: 'busy' }],
    ['an exit for another reason', { type: 'exit', reason: 'clone-failed', message: 'x' }],
    ['a dev pass with no lifetime', { type: 'dev-pass', pass: 'a.b.c' }],
    ['an agent run with an unknown state', { type: 'agent-run', state: 'paused' }],
    ['an agent run with no state', { type: 'agent-run', summary: 'x' }],
    ['an agent run with an extra field', { type: 'agent-run', state: 'done', cost: 1 }],
    [
      'an agent run whose agent has an unknown status',
      { type: 'agent-run', state: 'working', agents: [{ id: 'a', agent: 'b', status: 'idle' }] },
    ],
  ])('refuses %s', (_case, value) => {
    expect(readHostLine(value)).toBeNull();
  });
});
