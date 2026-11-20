/**
 * Compact age of a moment: 'now', '7m', '3h', '2d', '4w', '6mo', '2y'.
 *
 * One rule, shared by every surface that shows "how long ago" in a tight
 * column — the sidebar row and the Inbox. Compact rather than "ago"-suffixed
 * because it sits right-aligned against a title that wants the width.
 */
export function relativeSince(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
