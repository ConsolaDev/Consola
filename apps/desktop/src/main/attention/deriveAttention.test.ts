import { describe, expect, it } from 'vitest';
import type { Attention, AttentionRecord } from '../../shared/attention';
import type { TerminalStatus } from '../../shared/terminalStatus';
import { deriveAttention } from './deriveAttention';

const TERMINALS: TerminalStatus[] = ['working', 'ready', 'needs-attention', 'exited'];
const LAST_ACTIVE = 100;
const FINISHED = 200;

// finished: none | at FINISHED. seen: none | before the finish | after it.
// settled: none | before activity | exactly at activity | after it.
const FINISHES = [undefined, FINISHED];
const SEENS = [undefined, 150, 250];
const SETTLES = [undefined, 50, 100, 300];

function record(finishedAt?: number, seenAt?: number, settledAt?: number): AttentionRecord {
  return { sessionId: 's', workspaceId: 'w', lastActiveAt: LAST_ACTIVE, finishedAt, seenAt, settledAt };
}

/** The same rules, written as the sentence the design gives them rather than as code order. */
function expected(terminal: TerminalStatus, finishedAt?: number, seenAt?: number, settledAt?: number): Attention {
  const settled = settledAt !== undefined && settledAt >= LAST_ACTIVE;
  const unseenFinish = finishedAt !== undefined && (seenAt === undefined || seenAt < finishedAt);
  if (terminal === 'exited') return settled ? 'settled' : 'exited';
  if (terminal === 'needs-attention') return 'needs-attention';
  if (terminal === 'working') return 'working';
  if (settled) return 'settled';
  return unseenFinish ? 'done' : 'ready';
}

describe('deriveAttention', () => {
  const cases = TERMINALS.flatMap((terminal) =>
    FINISHES.flatMap((finished) =>
      SEENS.flatMap((seen) => SETTLES.map((settled) => [terminal, finished, seen, settled] as const))
    )
  );

  it.each(cases)('terminal %s, finished %s, seen %s, settled %s', (terminal, finished, seen, settled) => {
    expect(
      deriveAttention({
        terminal,
        record: record(finished, seen, settled),
        isViewedInFocusedWindow: false,
        heldByOpenRun: false,
      })
    ).toBe(expected(terminal, finished, seen, settled));
  });

  it('is ready, never done, for a session the ledger has not heard of', () => {
    const inputs = { record: undefined, isViewedInFocusedWindow: false, heldByOpenRun: false };
    expect(deriveAttention({ ...inputs, terminal: 'ready' })).toBe('ready');
    expect(deriveAttention({ ...inputs, terminal: 'exited' })).toBe('exited');
  });

  it('never calls working or needs-attention work done or settled, however the record reads', () => {
    const everything = record(FINISHED, undefined, 300);
    const inputs = { record: everything, isViewedInFocusedWindow: false, heldByOpenRun: false };
    expect(deriveAttention({ ...inputs, terminal: 'working' })).toBe('working');
    expect(deriveAttention({ ...inputs, terminal: 'needs-attention' })).toBe('needs-attention');
  });
});
