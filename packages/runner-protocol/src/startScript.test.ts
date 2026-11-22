import { describe, expect, it } from 'vitest';
import { readStartScriptLine } from './startScript.js';

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('readStartScriptLine', () => {
  it('reads the clone-failed exit', () => {
    const line = { type: 'exit', reason: 'clone-failed', message: 'The repository was not found.' };
    expect(readStartScriptLine(wire(line))).toEqual({ ok: true, value: line });
  });

  it.each([
    ['not an object', 'exit'],
    ['null', null],
    ["an idle exit, which is the host's", { type: 'exit', reason: 'idle', message: 'x' }],
    ['a host line', { type: 'ready', url: 'https://x.e2b.app' }],
    ['no message', { type: 'exit', reason: 'clone-failed' }],
    ['an empty message', { type: 'exit', reason: 'clone-failed', message: '' }],
    ['a numeric message', { type: 'exit', reason: 'clone-failed', message: 3 }],
    ['an extra field', { type: 'exit', reason: 'clone-failed', message: 'x', code: 1 }],
  ])('refuses %s', (_name, value) => {
    expect(readStartScriptLine(wire(value)).ok).toBe(false);
  });
});
