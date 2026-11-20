import type { BrowserWindow, WebContents } from 'electron';
import {
  TerminalService,
  type TerminalExitInfo,
  type TerminalServiceOptions,
  type RelaunchFields,
  type TerminalHarnessSwitch,
} from './TerminalService';
import { IPC_CHANNELS } from '../shared/constants';
import type { HarnessDriverId, TerminalSnapshot, TerminalStatusSnapshot } from '../shared/types';
import type { TerminalStatus } from '../shared/terminalStatus';
import type { AttentionEndpoint } from './attention/AttentionEndpoint';
import { getDriver } from './drivers';

/**
 * How long a terminal's output gathers before it crosses to its window.
 *
 * A PTY hands over at most 1 KiB per read, so one repaint of a fullscreen
 * CLI — a wheel tick, a keystroke — arrives as five to thirty reads within
 * a fraction of a millisecond. Sent one by one they cost as many IPC
 * messages and renderer tasks, and a frame boundary can fall between them,
 * painting half a repaint. Gathered for 2 ms they cross as one, which is
 * still far below a frame.
 */
export const OUTPUT_BATCH_MS = 2;

/**
 * Owns one TerminalService per session tab and forwards its events.
 *
 * Terminals are kept alive for every open session, not just the visible one, so
 * background work keeps running and switching tabs is instant. A window is a
 * view over that: closing one orphans its terminals without stopping them, and
 * the next window to open the workspace reattaches and repaints from the
 * replay buffer.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalService>();
  /**
   * Where this instance's output goes: the window whose view is mounted.
   * Set on every attach, cleared when the view unmounts. Without one,
   * output stays in the terminal's screen, which the next mount repaints.
   */
  private readonly owners = new Map<string, WebContents>();
  /** Output gathered for the next send, per instance. See OUTPUT_BATCH_MS. */
  private readonly pendingOutput = new Map<string, string[]>();
  private outputFlush: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly getWindows: () => BrowserWindow[]) {}

  private readonly statusListeners = new Set<
    (instanceId: string, status: TerminalStatus) => void
  >();
  private readonly exitListeners = new Set<(instanceId: string, info: TerminalExitInfo) => void>();
  private readonly limitNoticeListeners = new Set<(instanceId: string, showing: boolean) => void>();

  /**
   * Hear every status transition, after the broadcast. Many listeners may
   * subscribe (OS notifications, attention), so none displaces another.
   * Returns the unsubscribe.
   */
  public addStatusListener(
    listener: (instanceId: string, status: TerminalStatus) => void,
  ): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Hear a session's process exit, after the broadcast: an unattended turn
   * ending is an automation run finishing. Never called for a terminal
   * `destroy` removed, whose listeners go with it. Returns the unsubscribe.
   */
  public addExitListener(
    listener: (instanceId: string, info: TerminalExitInfo) => void,
  ): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /**
   * Hear a session's screen start or stop showing its CLI's usage-limit
   * notice, as its driver recognises it. Returns the unsubscribe.
   */
  public addLimitNoticeListener(
    listener: (instanceId: string, showing: boolean) => void,
  ): () => void {
    this.limitNoticeListeners.add(listener);
    return () => {
      this.limitNoticeListeners.delete(listener);
    };
  }

  /**
   * Called when a session's CLI says it now works somewhere else — an
   * agent that entered a worktree on its own. Main records it on the
   * session, and every window learns of it from the workspace broadcast.
   */
  /**
   * Where a driver's hooks post, when main runs an endpoint. Unset, every
   * session runs on the screen heuristic alone.
   */
  public attentionEndpoint?: AttentionEndpoint;

  /** Options with the hook URL a driver with `attentionHooks` wants, asked for at launch. */
  private withAttention(
    instanceId: string,
    options: TerminalServiceOptions,
  ): TerminalServiceOptions {
    const attentionUrl = this.attentionUrlFor(instanceId, options.driverId);
    return attentionUrl ? { ...options, attentionUrl } : options;
  }

  private attentionUrlFor(instanceId: string, driverId: HarnessDriverId | undefined) {
    const hooks = getDriver(driverId).attentionHooks;
    const endpoint = this.attentionEndpoint;
    if (!hooks || !endpoint) return undefined;
    return () => endpoint.urlFor(instanceId, (body) => hooks.parse(body));
  }

  public onWorkingDirectory?: (instanceId: string, cwd: string) => void;

  /**
   * Get the terminal for a session, starting it if needed.
   *
   * @returns The screen to repaint and its size, plus the terminal's current state.
   */
  public ensure(
    instanceId: string,
    options: TerminalServiceOptions,
    owner: WebContents,
  ): TerminalSnapshot {
    // Set before starting: a terminal that emits during start() would
    // otherwise have nowhere to send its first bytes.
    this.owners.set(instanceId, owner);
    // What was gathered but not sent is already in the screen this returns,
    // so sending it too would paint it twice. The view drops anything that
    // reaches it before this snapshot does.
    this.pendingOutput.delete(instanceId);

    let terminal = this.terminals.get(instanceId);

    if (!terminal) {
      terminal = new TerminalService(this.withAttention(instanceId, options));
      this.terminals.set(instanceId, terminal);
      this.wireEvents(instanceId, terminal);
      terminal.start();
    } else if (options.initialPrompt) {
      // Terminal already running — queue the prompt rather than dropping it.
      terminal.queuePrompt(options.initialPrompt);
    }

    return {
      ...terminal.getReplay(),
      exited: terminal.hasClaudeExited(),
    };
  }

  /**
   * Start a session's terminal with no view attached.
   *
   * Fan-out and conductors create sessions before any pane exists. This is
   * ensure() minus the owner: output lands in the ScreenModel, status
   * broadcasts to every window, and the first pane to mount goes through
   * ensure(), takes ownership, and repaints from the replay buffer.
   * "Terminals outlive their views" gains "…and can be born without one."
   */
  public startHeadless(instanceId: string, options: TerminalServiceOptions): void {
    const existing = this.terminals.get(instanceId);
    if (existing) {
      // An unattended turn needs a process of its own: queued into the
      // terminal a person opened, it would be typed into their composer,
      // and its run would wait for an exit that is not its.
      if (options.unattended)
        throw new Error('This session already has a terminal, so its turn cannot run unattended.');
      // Asked for a new conversation while a pane, mounted during the
      // caller's await, started the old one: the record names the new
      // one, so the terminal moves to it rather than taking a prompt
      // that was written for a fresh context.
      if (!options.resume && existing.conversationId() !== options.claudeSessionId) {
        existing.startFreshConversation(options.claudeSessionId, options.initialPrompt);
        return;
      }
      // Already running — the start is idempotent, but a prompt that
      // rode in with the call must not be dropped.
      if (options.initialPrompt) existing.queuePrompt(options.initialPrompt);
      return;
    }
    const terminal = new TerminalService(this.withAttention(instanceId, options));
    this.terminals.set(instanceId, terminal);
    this.wireEvents(instanceId, terminal);
    terminal.start();
  }

  public get(instanceId: string): TerminalService | undefined {
    return this.terminals.get(instanceId);
  }

  /** Whether a session has a terminal, live or exited. */
  public has(instanceId: string): boolean {
    return this.terminals.has(instanceId);
  }

  /**
   * The current status of every live terminal.
   *
   * The three status channels are edge-triggered — they fire on change and
   * never repeat — so a window born after an edge has no way to learn about
   * it. A session parked at a permission prompt is the case that hurts: it
   * will not emit again until a human answers, so without this the new
   * window would show no attention dot for exactly as long as it matters.
   */
  public statusSnapshot(): TerminalStatusSnapshot {
    const snapshot: TerminalStatusSnapshot = {};
    for (const [instanceId, terminal] of this.terminals) {
      snapshot[instanceId] = {
        isBusy: terminal.busy(),
        isAwaitingConfirmation: terminal.awaitingConfirmation(),
        hasExited: terminal.hasClaudeExited(),
      };
    }
    return snapshot;
  }

  /**
   * Start an exited terminal again, in place, resuming its conversation.
   * The instance stays, so a window showing it keeps streaming and its
   * "exited" overlay clears when the status moves.
   */
  public relaunch(instanceId: string, launch: RelaunchFields): void {
    const terminal = this.terminals.get(instanceId);
    if (!terminal) throw new Error(`No terminal for ${instanceId}.`);
    terminal.relaunch(launch);
  }

  /**
   * Move a session's terminal onto another harness, in place
   * (`TerminalService.switchHarness`). The hook URL is the new driver's
   * business: one with `attentionHooks` gets this instance's, and one
   * without leaves nothing registered for the old CLI to post to.
   */
  public switchHarness(
    instanceId: string,
    change: Omit<TerminalHarnessSwitch, 'attentionUrl'>,
  ): void {
    const terminal = this.terminals.get(instanceId);
    if (!terminal) throw new Error(`No terminal for ${instanceId}.`);
    const attentionUrl = this.attentionUrlFor(instanceId, change.launch.driverId);
    if (!attentionUrl) this.attentionEndpoint?.unregister(instanceId);
    terminal.switchHarness({ ...change, attentionUrl });
  }

  /**
   * A view of this terminal unmounted: stop sending it output.
   *
   * Nothing in that window is listening any more, and a busy background
   * agent's every byte would still cross IPC to be dropped there. The next
   * view to mount goes through ensure(), takes ownership again, and repaints
   * from the screen. Only the window that owns the terminal can release it:
   * a view that moved to another window has already taken it over.
   */
  public release(instanceId: string, owner: WebContents): void {
    if (this.owners.get(instanceId) !== owner) return;
    this.owners.delete(instanceId);
    this.pendingOutput.delete(instanceId);
  }

  public destroy(instanceId: string): void {
    const terminal = this.terminals.get(instanceId);
    if (!terminal) return;
    terminal.destroy();
    this.attentionEndpoint?.unregister(instanceId);
    this.terminals.delete(instanceId);
    this.owners.delete(instanceId);
    this.pendingOutput.delete(instanceId);
    // destroy() removes the terminal's listeners in the same tick, so no
    // status edge follows. Whoever derives from terminals (the attention
    // service) is told by the caller that destroyed it.
  }

  public destroyAll(): void {
    for (const instanceId of [...this.terminals.keys()]) {
      this.destroy(instanceId);
    }
  }

  /** Output goes only to the window rendering this pane. */
  private sendToOwner(instanceId: string, channel: string, payload: unknown): void {
    const owner = this.owners.get(instanceId);
    if (owner && !owner.isDestroyed()) {
      owner.send(channel, payload);
    }
  }

  /** Gather output for its view; none mounted, and the screen alone keeps it. */
  private queueOutput(instanceId: string, data: string): void {
    if (!this.owners.has(instanceId)) return;
    const parts = this.pendingOutput.get(instanceId);
    if (parts) parts.push(data);
    else this.pendingOutput.set(instanceId, [data]);
    this.outputFlush ??= setTimeout(() => {
      this.outputFlush = null;
      for (const id of [...this.pendingOutput.keys()]) this.flushOutput(id);
    }, OUTPUT_BATCH_MS);
  }

  /** Send what this instance has gathered, as one message. */
  private flushOutput(instanceId: string): void {
    const parts = this.pendingOutput.get(instanceId);
    if (!parts) return;
    this.pendingOutput.delete(instanceId);
    this.sendToOwner(instanceId, IPC_CHANNELS.TERMINAL_DATA, { instanceId, data: parts.join('') });
  }

  /**
   * Status goes to every window.
   *
   * A window scoped to one workspace still has to show that a session in
   * another one is waiting on a keypress, and these three flags are the only
   * way it can know. They are small enough that broadcasting costs nothing.
   */
  private broadcast(channel: string, payload: unknown): void {
    for (const window of this.getWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  }

  /** One listener throwing must not silence the others, or the emitter. */
  private notify<T>(listeners: Set<T>, call: (listener: T) => void): void {
    for (const listener of [...listeners]) {
      try {
        call(listener);
      } catch (error) {
        console.error('A terminal listener failed:', error);
      }
    }
  }

  private wireEvents(instanceId: string, terminal: TerminalService): void {
    terminal.on('data', (data: string) => this.queueOutput(instanceId, data));

    terminal.on('activity', (busy: boolean) => {
      this.broadcast(IPC_CHANNELS.TERMINAL_ACTIVITY, { instanceId, busy });
    });

    terminal.on('awaiting-confirmation', (awaiting: boolean) => {
      this.broadcast(IPC_CHANNELS.TERMINAL_AWAITING_CONFIRMATION, { instanceId, awaiting });
    });

    terminal.on('limit-notice', (showing: boolean) => {
      this.notify(this.limitNoticeListeners, (listener) => listener(instanceId, showing));
    });

    terminal.on('exit', (info: TerminalExitInfo) => {
      // The pane shows the last thing the CLI printed before it says it exited.
      this.flushOutput(instanceId);
      this.broadcast(IPC_CHANNELS.TERMINAL_EXIT, { instanceId, ...info });
      this.notify(this.exitListeners, (listener) => listener(instanceId, info));
    });

    terminal.on('working-directory', (cwd: string) => {
      this.onWorkingDirectory?.(instanceId, cwd);
    });

    terminal.on('status', (status: TerminalStatus) => {
      // Light state, per the windows design: any window may need it for
      // group counts and attention dots, so it goes to all of them.
      this.broadcast(IPC_CHANNELS.TERMINAL_STATUS, { instanceId, status });
      this.notify(this.statusListeners, (listener) => listener(instanceId, status));
    });
  }
}
