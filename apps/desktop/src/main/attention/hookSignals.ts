import type { TerminalStatus } from '../../shared/terminalStatus';

/**
 * What an agent CLI's own hooks can tell Consola, in no CLI's vocabulary.
 *
 * A driver translates its hook payloads into these (`AttentionHooks.parse`),
 * so nothing here or downstream knows which CLI spoke.
 */
export type AttentionSignal =
  /** The agent is parked on the person: a permission menu, a question, or a subagent's question. */
  | {
      kind: 'needs-input';
      origin: 'menu' | 'question' | 'subagent';
      /**
       * Reported only after the prompt had already waited a while (Claude's
       * `permission_prompt` notification, ~6s). Output flowing when one lands
       * means the prompt was answered in the meantime, so it is stale.
       */
      lagging?: true;
      /** Which tool call the prompt is for, when the CLI says: what lets that call's completion end it, and no other's. */
      tool?: string;
    }
  /**
   * The agent got an answer and moved on: the person submitted a prompt, or
   * (with `tool`) one tool call completed. A completion ends only the prompt
   * for that same call; parallel calls and subagents complete all the time
   * while a menu is still up. `agent` marks one that came from a subagent,
   * which says nothing about whether the session's own turn is running.
   */
  | { kind: 'resumed'; tool?: string; agent?: true }
  /** The agent has been idle, waiting for the person to type. Whatever it was asking is over. */
  | { kind: 'idle' }
  /** A subagent finished. */
  | { kind: 'subagent-finished' }
  /**
   * The turn ended. `backgroundWork` counts tasks the agent still has running;
   * `backgroundAgents` counts those that are its own subagents, which it waits
   * for and takes a turn on when they finish.
   */
  | { kind: 'turn-ended'; backgroundWork: number; backgroundAgents: number }
  /**
   * The turn ended on an error instead of finishing: `limit` when the error
   * was a usage limit. Ends a turn as `turn-ended` does, with nothing left
   * running (the CLI reports this instead of a normal stop).
   */
  | { kind: 'turn-failed'; limit: boolean }
  /** A usage limit's wait is over: the CLI resumed by itself, or gave up waiting. */
  | { kind: 'limit-over' };

/** What the hooks currently say about one terminal. Only ever an input to `deriveAttention`. */
export interface HookInputs {
  /** The agent said it is waiting on the person, and nothing has said otherwise since. */
  needsInput: boolean;
  /** The last turn ended with background work still running: not a finished turn. */
  holdingBackgroundWork: boolean;
  /**
   * Some of that work is the agent's own subagents. It waits on them and
   * resumes when they finish, so the session is still working, whatever its
   * screen shows in the meantime.
   */
  awaitingAgents: boolean;
  /**
   * Where the session's own turn stands, once a hook has said: `open` from a
   * submitted prompt (or a tool call of its own completing) until the stop
   * that ends it, `over` from then on. Undefined until a hook speaks, and
   * `open` outlives an interrupted turn, which reports no stop — so `open`
   * never proves work is happening. `over` is the one that says something:
   * no turn has begun since the last one ended.
   */
  turn?: 'open' | 'over';
}

interface State {
  needsInput: false | (AttentionSignal & { kind: 'needs-input' });
  holdingBackgroundWork: boolean;
  awaitingAgents: boolean;
  turn?: 'open' | 'over';
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
  private readonly subscribers = new Set<(instanceId: string) => void>();

  public get(instanceId: string): HookInputs | undefined {
    const state = this.states.get(instanceId);
    if (!state) return undefined;
    return {
      needsInput: state.needsInput !== false,
      holdingBackgroundWork: state.holdingBackgroundWork,
      awaitingAgents: state.awaitingAgents,
      turn: state.turn,
    };
  }

  public apply(instanceId: string, signal: AttentionSignal): void {
    const state = this.state(instanceId);
    const before = this.get(instanceId);
    switch (signal.kind) {
      case 'needs-input':
        // A lagging report landing while output flows describes a prompt that
        // has since been answered; latching it would show "needs you" on a
        // working session with no later edge to clear it.
        if (signal.lagging && state.status === 'working') break;
        state.needsInput = signal;
        break;
      case 'resumed': {
        // Only the session's own turn submits prompts and completes its calls.
        if (!signal.agent) state.turn = 'open';
        const pending = state.needsInput;
        if (!pending) break;
        // A completed call ends a prompt only when it is shown to be that
        // prompt's own call. Otherwise it is kept: a stale "needs you" costs
        // a glance, a missed one is an unbounded wait, and the prompt still
        // ends on a working edge, a Stop, idle, or the next submitted prompt.
        if (signal.tool !== undefined) {
          if (pending.tool === signal.tool) state.needsInput = false;
        } else if (pending.origin !== 'subagent') {
          // The person sent something. A subagent's question is ended by the subagent.
          state.needsInput = false;
        }
        break;
      }
      case 'idle':
        state.needsInput = false;
        break;
      case 'subagent-finished':
        // Only the subagent's own question ends with it; a menu on the main thread does not.
        if (state.needsInput && state.needsInput.origin === 'subagent') state.needsInput = false;
        break;
      case 'turn-ended':
        state.needsInput = false;
        state.turn = 'over';
        // Every turn ends with its own report, so each stop replaces the last
        // one's hold outright; nothing else ends it but the process exiting.
        state.holdingBackgroundWork = signal.backgroundWork > 0;
        state.awaitingAgents = signal.backgroundAgents > 0;
        break;
      case 'turn-failed':
        // Without this, a turn that died on an API error left whatever it
        // had latched (a question, a hold) in place: no Stop ever came.
        state.needsInput = false;
        state.turn = 'over';
        state.holdingBackgroundWork = false;
        state.awaitingAgents = false;
        break;
      case 'limit-over':
        // Says nothing about the screen; the usage-limit service hears it.
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
      // The background-work hold stays. Output after a turn is no new turn:
      // a waiting agent's panel of subagents repaints (observed live,
      // 2.1.326), and reads as `working` and quiet again for as long as they
      // run. A real turn replaces the hold when it stops.
    } else if (status === 'exited') {
      state.needsInput = false;
      state.holdingBackgroundWork = false;
      state.awaitingAgents = false;
      state.turn = undefined;
    }
    this.notifyIfChanged(instanceId, before);
  }

  /** A destroyed terminal's next life starts from nothing. */
  public forget(instanceId: string): void {
    if (this.states.delete(instanceId)) this.notify(instanceId);
  }

  /** Hear that what hooks say about a terminal changed. */
  public subscribe(cb: (instanceId: string) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private state(instanceId: string): State {
    let state = this.states.get(instanceId);
    if (!state) {
      state = { needsInput: false, holdingBackgroundWork: false, awaitingAgents: false };
      this.states.set(instanceId, state);
    }
    return state;
  }

  private notifyIfChanged(instanceId: string, before: HookInputs | undefined): void {
    const after = this.get(instanceId);
    if (
      before?.needsInput === after?.needsInput &&
      before?.holdingBackgroundWork === after?.holdingBackgroundWork &&
      before?.awaitingAgents === after?.awaitingAgents &&
      before?.turn === after?.turn
    ) {
      return;
    }
    this.notify(instanceId);
  }

  private notify(instanceId: string): void {
    for (const cb of [...this.subscribers]) cb(instanceId);
  }
}
