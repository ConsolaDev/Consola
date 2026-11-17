/**
 * How long something has been doing what it is doing: '0s', '12s', '4m', '2h', '3d'.
 *
 * The companion to `relativeSince`, and deliberately not the same function.
 * An age answers "when was this?" and rounds the first minute away as 'now',
 * which is right for a row that has finished and wrong for one that is
 * running: a turn's first thirty seconds are exactly when a person wants to
 * see the number move. So this counts seconds from the first one.
 */
export function elapsedLabel(from: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
