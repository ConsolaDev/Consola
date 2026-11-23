import { describe, expect, it } from 'vite-plus/test';
import { HOST_LINE_TYPES, type HostLine, readHostLine } from './hostLine.ts';

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
  ])('reads %j', (line) => {
    expect(readHostLine(roundTrip(line))).toEqual(line);
  });

  it('names every type it reads in HOST_LINE_TYPES', () => {
    expect([...HOST_LINE_TYPES].sort()).toEqual(['dev-pass', 'exit', 'ready', 'status', 'title']);
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
  ])('refuses %s', (_case, value) => {
    expect(readHostLine(value)).toBeNull();
  });
});
