import { describe, expect, it } from 'vitest';
import {
  approverWords,
  messageForApproveAnswer,
  promptFirstLine,
  receiptWords,
  willRunAnything,
} from './runApproval';
import type { ApproveAnswer } from './runApproval';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const team = { team: { id: 't-1', name: 'Core' } };
const workspace = { name: 'Acme', region: 'eu' };
const alice = {
  id: 'p-alice',
  name: 'Alice',
  email: 'a@acme.test',
  image: null,
  role: 'member' as const,
};

describe('the card’s words', () => {
  it('says who may approve', () => {
    expect(approverWords(team)).toBe('Anyone on Core can approve this.');
  });

  it('says what an agent is asked, by its prompt’s first line', () => {
    expect(promptFirstLine('\n  Review the pull request.\nThen comment.')).toBe(
      'Review the pull request.',
    );
    expect(promptFirstLine(null)).toBeNull();
    expect(promptFirstLine('   \n')).toBeNull();
    expect(promptFirstLine('x'.repeat(200))).toHaveLength(120);
  });

  it('knows a request’s approval lets nothing it can name run', () => {
    expect(willRunAnything({ commands: [], agents: [] })).toBe(false);
    expect(
      willRunAnything({ commands: [{ step: 'build', command: 'pnpm build' }], agents: [] }),
    ).toBe(true);
  });
});

describe('receiptWords', () => {
  it('says the person’s own answer', () => {
    expect(
      receiptWords({ decision: 'approved', by: 'p-me', at: ago(120_000) }, 'p-me', [alice], NOW),
    ).toBe('Approved by you · 2m ago. It starts when its runner picks it up.');
  });

  it('names a member, someone who left, or someone while the members are not known', () => {
    const dismissed = { decision: 'dismissed' as const, by: 'p-alice', at: ago(300_000) };
    expect(receiptWords(dismissed, 'p-me', [alice], NOW)).toBe(
      'Dismissed by Alice · 5m ago. Its runner won’t start it.',
    );
    expect(receiptWords(dismissed, 'p-me', [], NOW)).toBe(
      'Dismissed by someone who left · 5m ago. Its runner won’t start it.',
    );
    expect(receiptWords(dismissed, 'p-me', null, NOW)).toBe(
      'Dismissed by someone · 5m ago. Its runner won’t start it.',
    );
  });
});

describe('messageForApproveAnswer', () => {
  const said = (kind: Exclude<ApproveAnswer, { kind: 'answered' }>['kind']) =>
    messageForApproveAnswer({ kind }, team, workspace);

  it('has its own sentence for every refusal', () => {
    const kinds = [
      'invalid',
      'not-allowed',
      'not-found',
      'not-waiting',
      'already-answered',
      'version-moved',
      'pending',
      'switched',
      'signed-out',
      'unavailable',
    ] as const;
    const sentences = kinds.map(said);
    expect(new Set(sentences).size).toBe(kinds.length);
    expect(said('not-allowed')).toBe(
      'Only people on Core can answer this run, and you’re not on it now.',
    );
    expect(said('pending')).toBe(
      'Acme is still being set up in its region. Try again in a moment.',
    );
  });
});
