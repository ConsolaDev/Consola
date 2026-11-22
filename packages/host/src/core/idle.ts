/**
 * Whether the host has had nothing to do for long enough to stop. A connected client keeps it
 * alive however quiet the session is, and so does a turn that is running: a long command can run
 * for minutes without a stored event. A turn waiting on the person does not count as running.
 */
export function isIdle(input: {
  /** When the session last did anything (an event, a command, a client there), in epoch ms. */
  lastActivityMs: number;
  connectedClients: number;
  /** Whether a turn is running now. */
  turnRunning: boolean;
  nowMs: number;
  idleMinutes: number;
}): boolean {
  if (input.connectedClients > 0 || input.turnRunning) return false;
  return input.nowMs - input.lastActivityMs >= input.idleMinutes * 60_000;
}
