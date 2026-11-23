import { describe, expect, it } from 'vite-plus/test';
import { decideCommand, OFFERED_COMMANDS } from './commandPolicy.ts';

describe('decideCommand', () => {
  it('runs a command the host offers', () => {
    expect(decideCommand('message.dispatch')).toBe('run');
  });

  it.each(['thread.fork', 'checkpoint.rollback'])('does not offer %s', (type) => {
    expect(decideCommand(type)).toBe('not-offered');
  });

  it('offers exactly the four commands of one session', () => {
    expect([...OFFERED_COMMANDS].sort()).toEqual([
      'message.dispatch',
      'run.interrupt',
      'runtime-request.respond',
      'thread.model-selection.set',
    ]);
  });
});
