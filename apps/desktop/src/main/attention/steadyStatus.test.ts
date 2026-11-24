import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatus } from '../../shared/terminalStatus';
import { deriveAttention } from './deriveAttention';
import { HookSignals } from './hookSignals';
import type { AttentionSignal, HookInputs } from './hookSignals';
import { DROP_HOLD_MS, SteadyStatus, UNTURNED_WORK_MS } from './steadyStatus';

function setup() {
  const seen: TerminalStatus[] = [];
  const turn: { now: HookInputs['turn'] } = { now: undefined };
  const steady = new SteadyStatus({
    turn: () => turn.now,
    emit: (_id, status) => seen.push(status),
  });
  return { seen, turn, steady, say: (status: TerminalStatus) => steady.observe('t', status) };
}

describe('SteadyStatus', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes the first report and every change to needs-attention or exited on at once', () => {
    const { seen, say } = setup();
    say('ready');
    say('working');
    say('needs-attention');
    say('exited');
    expect(seen).toEqual(['ready', 'working', 'needs-attention', 'exited']);
  });

  describe('a pause inside a turn', () => {
    it('is not shown when the terminal is working again before the hold ends', () => {
      const { seen, steady, say } = setup();
      say('working');
      say('ready');
      vi.advanceTimersByTime(DROP_HOLD_MS - 1);
      say('working');
      vi.advanceTimersByTime(DROP_HOLD_MS * 2);
      expect(seen).toEqual(['working']);
      expect(steady.get('t')).toBe('working');
    });

    it('is shown once it has lasted the hold: an interrupt reports no end of turn', () => {
      const { seen, turn, say } = setup();
      turn.now = 'open';
      say('working');
      say('ready');
      vi.advanceTimersByTime(DROP_HOLD_MS);
      expect(seen).toEqual(['working', 'ready']);
    });

    it('is shown at once when the CLI already said the turn was over', () => {
      const { seen, turn, say } = setup();
      turn.now = 'open';
      say('working');
      turn.now = 'over';
      say('ready');
      expect(seen).toEqual(['working', 'ready']);
    });

    it('stops being held the moment the CLI says the turn is over', () => {
      const { seen, turn, steady, say } = setup();
      turn.now = 'open';
      say('working');
      say('ready');
      turn.now = 'over';
      steady.hookChanged('t');
      expect(seen).toEqual(['working', 'ready']);
    });
  });

  describe('output after the turn ended', () => {
    // Recorded live (2.1.327): a background agent's tool calls read as
    // working for 0.5 s, 1 s and 0.5 s within nine seconds of a finished turn.
    it('is not shown as work while it stays a burst', () => {
      const { seen, turn, say } = setup();
      say('ready');
      turn.now = 'over';
      for (const burst of [500, 1_000, 500]) {
        say('working');
        vi.advanceTimersByTime(burst);
        say('ready');
        vi.advanceTimersByTime(3_500);
      }
      expect(seen).toEqual(['ready']);
    });

    it('is shown as work once it outlasts any burst', () => {
      const { seen, turn, say } = setup();
      say('ready');
      turn.now = 'over';
      say('working');
      vi.advanceTimersByTime(UNTURNED_WORK_MS);
      expect(seen).toEqual(['ready', 'working']);
    });

    it('is shown at once when a prompt was submitted', () => {
      const { seen, turn, steady, say } = setup();
      say('ready');
      turn.now = 'over';
      say('working');
      turn.now = 'open';
      steady.hookChanged('t');
      expect(seen).toEqual(['ready', 'working']);
    });

    it('is shown at once with no hooks to say a turn ever ended', () => {
      const { seen, say } = setup();
      say('ready');
      say('working');
      expect(seen).toEqual(['ready', 'working']);
    });
  });

  describe('a menu answered inside a turn', () => {
    it('goes back to working, not through ready', () => {
      const { seen, turn, say } = setup();
      turn.now = 'open';
      say('working');
      say('needs-attention');
      say('ready');
      vi.advanceTimersByTime(1_200);
      say('working');
      vi.advanceTimersByTime(DROP_HOLD_MS * 2);
      expect(seen).toEqual(['working', 'needs-attention', 'working']);
    });

    it('lands on ready when the answer ended the turn instead', () => {
      const { seen, turn, say } = setup();
      turn.now = 'open';
      say('needs-attention');
      say('ready');
      vi.advanceTimersByTime(DROP_HOLD_MS);
      expect(seen).toEqual(['needs-attention', 'working', 'ready']);
    });

    it('is left alone when no hook said a turn is open: the trust gate precedes them all', () => {
      const { seen, say } = setup();
      say('needs-attention');
      say('ready');
      expect(seen).toEqual(['needs-attention', 'ready']);
    });
  });

  it('never holds back a menu or an exit that arrives during a hold', () => {
    const { seen, say } = setup();
    say('working');
    say('ready');
    say('needs-attention');
    vi.advanceTimersByTime(DROP_HOLD_MS * 2);
    expect(seen).toEqual(['working', 'needs-attention']);
  });

  it('forgets a destroyed terminal, pending change included', () => {
    const { seen, steady, say } = setup();
    say('working');
    say('ready');
    steady.forget('t');
    vi.advanceTimersByTime(DROP_HOLD_MS * 2);
    expect(seen).toEqual(['working']);
    expect(steady.get('t')).toBeUndefined();
  });
});

/**
 * A real session, replayed: what `TerminalService` derived from the output of
 * Claude Code 2.1.327 and what its hooks posted, at the times they happened.
 * The prompt launched one background agent and ended its turn; the agent ran
 * a shell command in the background, handed back, and was woken when the
 * command finished. Milliseconds from launch.
 */
describe('a recorded session with a background agent', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const stop = (backgroundWork: number, backgroundAgents: number): AttentionSignal => ({
    kind: 'turn-ended',
    backgroundWork,
    backgroundAgents,
  });
  const subagentCall: AttentionSignal = { kind: 'resumed', tool: 'Bash:{}', agent: true };
  const recording: Array<[number, TerminalStatus | AttentionSignal]> = [
    [8_814, { kind: 'resumed' }],
    [9_689, 'working'],
    [11_701, { kind: 'resumed', tool: 'Agent:{}' }],
    [12_361, stop(1, 1)],
    [13_644, 'ready'],
    // The agent works; its panel and tool calls paint in bursts.
    [21_824, 'working'],
    [22_324, 'ready'],
    [25_828, 'working'],
    [26_810, 'ready'],
    [29_395, subagentCall],
    [30_185, 'working'],
    [30_685, 'ready'],
    // It hands back, which wakes the session for a short turn.
    [33_659, { kind: 'resumed' }],
    [34_681, 'working'],
    [35_864, stop(1, 0)],
    [36_786, 'ready'],
    // The shell command ends and the agent is woken to report.
    [77_552, subagentCall],
    [80_287, subagentCall],
    [80_291, { kind: 'resumed' }],
    [81_281, 'working'],
    [81_648, stop(0, 0)],
    [82_623, 'ready'],
  ];

  it('is working while the agent works and stopped once, not eight times', () => {
    const hooks = new HookSignals();
    const told: TerminalStatus[] = [];
    const steady = new SteadyStatus({
      turn: (id) => hooks.get(id)?.turn,
      emit: (_id, status) => told.push(status),
    });
    hooks.subscribe((id) => steady.hookChanged(id));
    const attention: Array<[number, string]> = [];
    const read = (at: number) => {
      const now = deriveAttention({
        terminal: steady.get('t')!,
        record: undefined,
        isViewedInFocusedWindow: false,
        heldByOpenRun: false,
        hook: hooks.get('t'),
        now: at,
      });
      if (attention.at(-1)?.[1] !== now) attention.push([at, now]);
    };

    hooks.statusChanged('t', 'ready');
    steady.observe('t', 'ready');
    read(0);
    let clock = 0;
    for (const [at, event] of recording) {
      // Step through the gap so a held change that comes due is read when it does.
      for (; clock < at; clock += 100) {
        vi.advanceTimersByTime(Math.min(100, at - clock));
        read(Math.min(clock + 100, at));
      }
      clock = at;
      if (typeof event === 'string') {
        hooks.statusChanged('t', event);
        steady.observe('t', event);
      } else {
        hooks.apply('t', event);
      }
      read(at);
    }

    expect(attention).toEqual([
      [0, 'ready'],
      [9_689, 'working'],
      [36_786, 'ready'],
      [81_281, 'working'],
      [82_623, 'ready'],
    ]);
    // Each of these is also one write of the session's last activity: the
    // bursts no longer count as any.
    expect(told).toEqual(['ready', 'working', 'ready', 'working', 'ready', 'working', 'ready']);
  });
});
