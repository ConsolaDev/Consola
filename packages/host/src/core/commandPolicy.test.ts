import { describe, expect, it } from 'vite-plus/test';
import {
  claimsHostId,
  decideCommand,
  HOST_ID_PREFIX,
  hostCommandId,
  hostMessageId,
  OFFERED_COMMANDS,
} from './commandPolicy.ts';

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

describe('claimsHostId', () => {
  it('makes the host’s own ids under its prefix', () => {
    expect(hostCommandId('session-sprocket-run', 'agent-run-prompt')).toBe(
      'consola-host:command:session-sprocket-run:agent-run-prompt',
    );
    expect(hostMessageId('session-sprocket-run', 'report:run-1')).toBe(
      'consola-host:message:session-sprocket-run:report:run-1',
    );
  });

  it.each([
    [
      'the prompt’s command id',
      { commandId: hostCommandId('session-sprocket-run', 'agent-run-prompt') },
    ],
    [
      'a report’s command id',
      { commandId: hostCommandId('session-sprocket-run', 'report:run-1'), messageId: 'm-1' },
    ],
    [
      'a follow-up’s command id',
      { commandId: hostCommandId('session-sprocket-run', 'follow-up:slack:Ev1:ab12') },
    ],
    [
      'a dispatched agent’s brief',
      { commandId: hostCommandId('session-sprocket-run-review-1', 'brief') },
    ],
    [
      'a message id of the host’s, under a command id of the client’s',
      {
        commandId: 'c4a1f0e2',
        messageId: hostMessageId('session-sprocket-run', 'agent-run-prompt'),
      },
    ],
    ['the bare prefix', { commandId: HOST_ID_PREFIX }],
  ])('claims %s', (_, command) => {
    expect(claimsHostId(command)).toBe(true);
  });

  it.each([
    [
      't3’s client’s ids',
      {
        commandId: '3b7c9a52-8d0e-4f3a-9b1c-2e6d7f8a9b0c',
        messageId: '3b7c9a52-8d0e-4f3a-9b1c-2e6d7f8a9b0c',
      },
    ],
    [
      'a test’s own ids',
      { commandId: 'command:session-sprocket:message-1', messageId: 'message:session-sprocket:1' },
    ],
    ['no message id', { commandId: 'command:session-sprocket:interrupt-1' }],
  ])('leaves %s alone', (_, command) => {
    expect(claimsHostId(command)).toBe(false);
  });
});
