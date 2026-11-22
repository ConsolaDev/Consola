/**
 * Whether the host has had nothing to do for long enough to stop. A connected client keeps it
 * alive however quiet the session is.
 */
export function isIdle(input: {
  lastActivityMs: number;
  connectedClients: number;
  nowMs: number;
  idleMinutes: number;
}): boolean {
  if (input.connectedClients > 0) return false;
  return input.nowMs - input.lastActivityMs >= input.idleMinutes * 60_000;
}
