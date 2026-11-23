import type { CellConfig } from './config.js';

const HIDDEN = '<hidden>';

/** The most specific message an error carries: a failed query's database answer, say. */
function innermostMessage(error: unknown): string | undefined {
  let message: string | undefined;
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message.trim() !== '') {
      message = current.message;
    } else if (current instanceof AggregateError) {
      // A host with several addresses that all refuse rejects with one of these, unworded.
      const first = current.errors.find((each) => each instanceof Error && each.message !== '');
      if (first) message = first.message;
    }
    current = current.cause;
  }
  return message;
}

function secretsOf(config: CellConfig): string[] {
  const secrets = [config.databaseUrl];
  try {
    const { password } = new URL(config.databaseUrl);
    if (password) secrets.push(password, decodeURIComponent(password));
  } catch {
    // A pglite: address has no password.
  }
  if (config.runner) {
    secrets.push(config.runner.secret);
    // The pass key's private part, however the rest of the key is written out.
    const { d } = config.runner.passPrivateKey;
    if (typeof d === 'string') secrets.push(d);
  }
  // Longest first, so a secret inside another is hidden by the longer one.
  return secrets.filter((secret) => secret !== '').sort((a, b) => b.length - a.length);
}

/**
 * One plain line for a failure while the cell starts: the error's own words, never the database
 * address or its password, the runner's secret or the pass key.
 */
export function describeStartupFailure(error: unknown, config: CellConfig): string {
  const message =
    error instanceof Error ? innermostMessage(error) : String(error).trim() || undefined;
  const firstLine = message?.split('\n')[0]?.trim();
  if (!firstLine) return 'An unexpected error occurred.';
  return secretsOf(config).reduce((line, secret) => line.split(secret).join(HIDDEN), firstLine);
}
