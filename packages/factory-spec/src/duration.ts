/** `<n>s`, `<n>m` or `<n>h`, as a timeout is written. Null when it is not that shape. */
export function parseDurationMs(value: unknown): number | null {
  const match = typeof value === 'string' ? /^(\d+)([smh])$/.exec(value.trim()) : null;
  if (!match) return null;
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h'];
}
