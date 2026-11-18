import type { TerminalStatus } from '../../shared/terminalStatus';
import type { AttentionLedger } from './AttentionLedger';

/**
 * Turns terminal status edges into ledger activity.
 *
 * Activity is a turn starting (into `working`) or finishing (`working` to
 * `ready`). Not keystrokes, resizes or output chunks: those would keep every
 * session permanently recent. A status listener only fires on a change, so
 * the previous status per instance is all the memory this needs.
 */
export class TurnActivity {
  private readonly previous = new Map<string, TerminalStatus>();

  constructor(
    private readonly ledger: Pick<AttentionLedger, 'touch'>,
    /** The ledger is keyed by session, a terminal by its per-launch instance. */
    private readonly resolve: (
      instanceId: string,
    ) => { sessionId: string; workspaceId: string } | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  public statusChanged(instanceId: string, status: TerminalStatus): void {
    const before = this.previous.get(instanceId);
    this.previous.set(instanceId, status);

    const started = status === 'working' && before !== 'working';
    const finished = before === 'working' && status === 'ready';
    if (!started && !finished) return;

    const located = this.resolve(instanceId);
    if (located) this.ledger.touch(located.sessionId, located.workspaceId, this.now());
  }

  /** A destroyed terminal's next life starts from nothing. */
  public forget(instanceId: string): void {
    this.previous.delete(instanceId);
  }
}
