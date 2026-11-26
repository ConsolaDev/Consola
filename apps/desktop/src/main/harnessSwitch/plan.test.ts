import { describe, expect, it } from 'vitest';
import type { HarnessDriver } from '../drivers';
import { conversationSupport, describeSwitch, planHarnessSwitch } from './plan';
import type { ConversationSupport } from './plan';

const claude: ConversationSupport = { driverId: 'claude', transplant: true, readable: true };
const codex: ConversationSupport = { driverId: 'codex', transplant: false, readable: true };
const sealed: ConversationSupport = { driverId: 'codex', transplant: false, readable: false };

const plan = (source: ConversationSupport, target: ConversationSupport, hasStarted = true) =>
  planHarnessSwitch({ source, target, sourceName: 'Personal', targetName: 'Work', hasStarted });

describe('planHarnessSwitch', () => {
  it('forks natively between harnesses of a CLI that can carry its conversations', () => {
    expect(plan(claude, claude)).toEqual({ ok: true, mode: 'native' });
  });

  it('hands the conversation over between CLIs, and within a CLI that cannot fork', () => {
    expect(plan(claude, codex)).toEqual({ ok: true, mode: 'handoff' });
    expect(plan(codex, claude)).toEqual({ ok: true, mode: 'handoff' });
    expect(plan(codex, codex)).toEqual({ ok: true, mode: 'handoff' });
  });

  it('has nothing to carry for a session that never started', () => {
    expect(plan(sealed, claude, false)).toEqual({ ok: true, mode: 'unstarted' });
  });

  it('refuses a conversation it can neither fork nor read, naming both sides', () => {
    expect(plan(sealed, claude)).toEqual({
      ok: false,
      reason:
        'Personal keeps its conversations where Consola cannot read them, so this one cannot be carried to Work.',
    });
  });
});

describe('conversationSupport', () => {
  it('is read from which optional methods a driver implements', () => {
    const bare = { id: 'codex' } as HarnessDriver;
    expect(conversationSupport(bare)).toEqual({
      driverId: 'codex',
      transplant: false,
      readable: false,
    });
    const full = {
      id: 'claude',
      transplantConversation: async () => {},
      readConversation: async () => null,
    } as unknown as HarnessDriver;
    expect(conversationSupport(full)).toEqual({
      driverId: 'claude',
      transplant: true,
      readable: true,
    });
  });
});

describe('describeSwitch', () => {
  it('tells the person what each mode keeps', () => {
    expect(describeSwitch('native', 'Work')).toMatch(/full history, tool results included/);
    expect(describeSwitch('handoff', 'Codex')).toMatch(/not what those tools returned/);
    expect(describeSwitch('unstarted', 'Work')).toMatch(/Nothing has been said yet/);
  });
});
