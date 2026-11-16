import type { TerminalStatus } from '../../shared/terminalStatus';

/**
 * What an agent CLI's own hooks can tell Consola, in no CLI's vocabulary.
 *
 * A driver translates its hook payloads into these (`AttentionHooks.parse`),
 * so nothing here or downstream knows which CLI spoke.
 */
export type AttentionSignal =
  /** The agent is parked on the person: a permission menu, a question, or a subagent's question. */
  | { kind: 'needs-input'; origin: 'menu' | 'question' | 'subagent' }
  /** The agent has been idle, waiting for the person to type. Whatever it was asking is over. */
  | { kind: 'idle' }
  /** A subagent finished. */
  | { kind: 'subagent-finished' }
  /** The turn ended. `backgroundWork` counts tasks the agent still has running. */
  | { kind: 'turn-ended'; backgroundWork: number };

/** What the hooks currently say about one terminal. Only ever an input to `deriveAttention`. */
export interface HookInputs {
  /** The agent said it is waiting on the person, and nothing has said otherwise since. */
  needsInput: boolean;
  /** The last turn ended with background work still running: not a finished turn. */
  holdingBackgroundWork: boolean;
}

interface State {
  needsInput: false | AttentionSignal & { kind: 'needs-input' };
  holdingBackgroundWork: boolean;
  status?: TerminalStatus;
}

/**
 * The latest word of each terminal's hooks.
 *
 * A hook is a *signal*, not a status: it never writes one. This remembers
 * what was last said and for how long that still holds, and `SessionSource`
 * hands it to `deriveAttention` with everything else. Keyed by instance,
 * because hooks arrive from a process and a process is one instance.
 *
 * What was said lapses when the person plainly acted on it, so a hook that
 * never gets a follow-up (a user interrupt fires no `Stop`) cannot hold a
 * session at "needs you" forever: the terminal going to `working` after
 * being quiet, the turn ending, the agent idling, or the process exiting.
 */
export class HookSignals {
  private readonly states = new Map<string, State>();
  private readonly subscribers = new Set<() => void>();

  public get(instanceId: string): HookInputs | undefined {
    const state = this.states.get(instanceId);
    if (!state) return undefined;
    return { needsInput: state.needsInput !== false, holdingBackgroundWork: state.holdingBackgroundWork };
  }

  public apply(instanceId: string, signal: AttentionSignal): void {
    const state = this.state(instanceId);
    const before = this.get(instanceId);
    switch (signal.kind) {
      case 'needs-input':
        state.needsInput = signal;
        break;
      case 'idle':
        state.needsInput = false;
        break;
      case 'subagent-finished':
        // Only the subagent's own question ends with it; a menu on the main thread does not.
        if (state.needsInput && state.needsInput.origin === 'subagent') state.needsInput = false;
        break;
      case 'turn-ended':
        state.needsInput = false;
        state.holdingBackgroundWork = signal.backgroundWork > 0;
        break;
    }
    this.notifyIfChanged(instanceId, before);
  }

  /** A terminal's status changed: the person acting on a prompt shows up as output starting again. */
  public statusChanged(instanceId: string, status: TerminalStatus): void {
    // Remembered even before any hook speaks: whether output was already
    // flowing when one arrives decides whether the next `working` is news.
    const state = this.state(instanceId);
    const before = this.get(instanceId);
    const wasQuiet = state.status !== 'working';
    state.status = status;
    if (status === 'working' && wasQuiet) {
      state.needsInput = false;
      // A new turn is under way and will end with its own report.
      state.holdingBackgroundWork = false;
    } else if (status === 'exited') {
      state.needsInput = false;
      state.holdingBackgroundWork = false;
    }
    this.notifyIfChanged(instanceId, before);
  }

  /** A destroyed terminal's next life starts from nothing. */
  public forget(instanceId: string): void {
    if (this.states.delete(instanceId)) this.notify();
  }

  public subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private state(instanceId: string): State {
    let state = this.states.get(instanceId);
    if (!state) {
      state = { needsInput: false, holdingBackgroundWork: false };
      this.states.set(instanceId, state);
    }
    return state;
  }

  private notifyIfChanged(instanceId: string, before: HookInputs | undefined): void {
    const after = this.get(instanceId);
    if (before?.needsInput === after?.needsInput && before?.holdingBackgroundWork === after?.holdingBackgroundWork) return;
    this.notify();
  }

  private notify(): void {
    for (const cb of [...this.subscribers]) cb();
  }
}
