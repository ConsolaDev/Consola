/**
 * One session's status, at the coarseness the fleet UI needs.
 *
 * The four states the design promotes to a first-class event:
 * `working` — output is flowing; `ready` — quiet, composer available;
 * `needs-attention` — a confirmation marker or permission prompt is on
 * screen; `exited` — the CLI process is gone.
 *
 * Shared between main (which derives and emits it) and the renderer (which
 * derives an initial value from the status snapshot), so the two can never
 * disagree about what the flags mean.
 */
export type TerminalStatus = 'working' | 'ready' | 'needs-attention' | 'exited';

export interface TerminalStatusFlags {
    /** Output is flowing. */
    busy: boolean;
    /** A confirmation menu or permission prompt is on screen. */
    awaitingConfirmation: boolean;
    /** The CLI process is gone. */
    exited: boolean;
}

export function deriveTerminalStatus(flags: TerminalStatusFlags): TerminalStatus {
    if (flags.exited) return 'exited';
    if (flags.awaitingConfirmation) return 'needs-attention';
    if (flags.busy) return 'working';
    return 'ready';
}
