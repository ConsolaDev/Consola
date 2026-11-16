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
  if (terminal === 'exited') return settled ? 'settled' : unseenFinish ? 'done' : 'exited';
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

describe('deriveAttention with hooks', () => {
  const inputs = (terminal: TerminalStatus, hook?: { needsInput: boolean; holdingBackgroundWork: boolean }) => ({
    terminal,
    record: record(),
    isViewedInFocusedWindow: false,
    heldByOpenRun: false,
    hook,
  });
  const says = { needsInput: true, holdingBackgroundWork: false };
  const quiet = { needsInput: false, holdingBackgroundWork: false };

  it('lets a hook that says the agent is waiting win over a screen showing nothing recognisable', () => {
    expect(deriveAttention(inputs('ready', says))).toBe('needs-attention');
    expect(deriveAttention(inputs('working', says))).toBe('needs-attention'); // a subagent asking, main thread busy
  });

  it('never calls an exited process needs-attention', () => {
    expect(deriveAttention(inputs('exited', says))).toBe('exited');
  });

  it('answers exactly as without hooks when they say nothing, or there are none', () => {
    for (const terminal of TERMINALS) {
      expect(deriveAttention(inputs(terminal, quiet))).toBe(deriveAttention(inputs(terminal)));
    }
  });

  it('keeps the screen’s answer when hooks have not arrived: the heuristic is the fast path', () => {
    expect(deriveAttention(inputs('needs-attention'))).toBe('needs-attention');
  });
});

describe('deriveAttention for held and finished sessions', () => {
  const base = { isViewedInFocusedWindow: false };
  it('does not settle a session an open run holds', () => {
    const settled = record(undefined, undefined, 300);
    expect(deriveAttention({ ...base, terminal: 'ready', record: settled, heldByOpenRun: false })).toBe('settled');
    expect(deriveAttention({ ...base, terminal: 'ready', record: settled, heldByOpenRun: true })).toBe('ready');
    expect(deriveAttention({ ...base, terminal: 'exited', record: settled, heldByOpenRun: true })).toBe('exited');
  });

  it('calls an exited process with an unseen finish done', () => {
    expect(deriveAttention({ ...base, terminal: 'exited', record: record(FINISHED), heldByOpenRun: false })).toBe('done');
    expect(deriveAttention({ ...base, terminal: 'exited', record: record(FINISHED, 250), heldByOpenRun: false })).toBe('exited');
  });
});
