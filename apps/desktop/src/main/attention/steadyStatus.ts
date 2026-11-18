import type { TerminalStatus } from '../../shared/terminalStatus';
import type { HookInputs } from './hookSignals';

/**
 * How long a session that was working must read `ready` before it is shown
 * as stopped, when nothing has said its turn ended.
 *
 * The screen calls a terminal `ready` after half a second without output,
 * and takes a full second of output to call it `working` again. So a turn
 * that pauses — and one whose menu was just answered — reads `ready` for a
 * second or so in the middle of work, and the row left Working and came
 * straight back. A turn the CLI reported over (a hook's `Stop`) does not
 * wait this out.
 */
export const DROP_HOLD_MS = 2_000;

/**
 * How long output must last, after the CLI said the turn was over and before
 * it said another began, to be shown as work.
 *
 * Recorded against Claude Code 2.1.327: with the turn over, a background
 * agent's tool calls and a woken agent's panel paint in bursts the screen
 * reads as `working` for 0.5–1 s at a time, several times a minute. None of
 * that is a turn — a turn starts with a submitted prompt, which the hooks
 * report — so each burst sent the row to Working and back. Only output that
 * outlasts every such burst counts, which still catches work no hook
 * announces.
 */
export const UNTURNED_WORK_MS = 3_000;

type Turn = HookInputs['turn'];

interface State {
  /** What the terminal last reported. */
  raw: TerminalStatus;
  /** What everything deciding attention is told. */
  shown: TerminalStatus;
  timer?: NodeJS.Timeout;
}

/**
 * A terminal's status with the flicker taken out, for everything that decides
 * attention.
 *
 * `TerminalService` infers `working` from output flow, which is right for
 * delivering a prompt and too twitchy to file a row by: the sidebar moves a
 * row between sections on every change, and the ledger counts each as
 * activity. This passes the same four statuses on, holding back only the two
 * changes that are usually noise — a brief `ready` inside a turn, and a brief
 * `working` outside one — for a bounded time each. `needs-attention` and
 * `exited` are never delayed.
 *
 * The hooks' turn boundaries decide which side of a turn a change is on. With
 * no hooks (another CLI, a managed policy, an untrusted folder) nothing is
 * known to be outside a turn, so `working` shows at once as it always did and
 * only the drop is held.
 */
export class SteadyStatus {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly deps: {
      /** Where the hooks say this terminal's turn stands, if they have said. */
      turn(instanceId: string): Turn;
      /** A status worth acting on: called once per change of what is shown. */
      emit(instanceId: string, status: TerminalStatus): void;
    },
  ) {}

  /** What is currently shown for a terminal, or undefined before it has reported. */
  public get(instanceId: string): TerminalStatus | undefined {
    return this.states.get(instanceId)?.shown;
  }

  /** The terminal reported a status. */
  public observe(instanceId: string, raw: TerminalStatus): void {
    const state = this.states.get(instanceId);
    if (!state) {
      // The first report is where the terminal starts, not a change to doubt.
      this.states.set(instanceId, { raw, shown: raw });
      this.deps.emit(instanceId, raw);
      return;
    }
    state.raw = raw;
    // A menu answered inside a turn: the turn goes on, and the screen needs a
    // second of output to say so. Shown as the work it is, then held like any
    // other pause, so an answer that ended the turn instead still lands.
    if (
      raw === 'ready' &&
      state.shown === 'needs-attention' &&
      this.deps.turn(instanceId) === 'open'
    ) {
      this.show(instanceId, state, 'working');
    }
    this.settle(instanceId, state);
  }

  /** The hooks said something new: a change being held back may no longer need to be. */
  public hookChanged(instanceId: string): void {
    const state = this.states.get(instanceId);
    if (state) this.settle(instanceId, state);
  }

  /** A destroyed terminal's next life starts from nothing. */
  public forget(instanceId: string): void {
    const state = this.states.get(instanceId);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(instanceId);
  }

  private settle(instanceId: string, state: State): void {
    if (state.raw === state.shown) {
      this.clearTimer(state);
      return;
    }
    const delay = this.delayFor(state, this.deps.turn(instanceId));
    if (delay === 0) {
      this.show(instanceId, state, state.raw);
      return;
    }
    // Already counting towards this change. Never restarted: what is being
    // waited out is how long the terminal has said so, not how often.
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.states.get(instanceId) === state) this.show(instanceId, state, state.raw);
    }, delay);
    state.timer.unref?.();
  }

  private delayFor(state: State, turn: Turn): number {
    if (state.raw === 'working' && turn === 'over') return UNTURNED_WORK_MS;
    if (state.raw === 'ready' && state.shown === 'working' && turn !== 'over') return DROP_HOLD_MS;
    return 0;
  }

  private show(instanceId: string, state: State, status: TerminalStatus): void {
    this.clearTimer(state);
    if (state.shown === status) return;
    state.shown = status;
    this.deps.emit(instanceId, status);
  }

  private clearTimer(state: State): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
  }
}
