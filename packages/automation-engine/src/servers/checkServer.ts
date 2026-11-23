/**
 * Check server: a person's own allowing of one start of a factory server,
 * to see its tools and whether the calls of an entry fit them. It calls no
 * tool, accepts nothing and records no run; what it found lives in memory.
 */
import type { McpSession } from '../ports';

/** Refused for a version that is not the entry's current one. */
export const CHECK_STALE =
  "Check server is for this automation's current version; reload its page.";

/** Refused for a server the entry's calls do not use. */
export function checkNotUsed(name: string, server: string): string {
  return `\`${name}\` does not use a server called \`${server}\`.`;
}

/** Refused while the same entry's server is being checked. */
export function checkUnderWay(server: string): string {
  return `\`${server}\` is being checked already.`;
}

export interface ServerCheckView {
  server: string;
  /** When it was checked (ISO). */
  at: string;
  /** Its tools' names, as it listed them; absent when it could not be reached. */
  tools?: string[];
  /** Per call of the entry to this server, in file order. */
  steps: Array<{ step: string; tool: string; verdict: 'fits' | 'missing' | { problem: string } }>;
  /** Why it could not be checked: a secret not read, or the server not reached. */
  problem?: string;
  /** Processes it started still alive after it was stopped. */
  survivors?: number;
}

/** Whether a value holds a `{{ }}` anywhere, in a list or a mapping too: only the run knows what it renders to. */
function templated(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{');
  if (typeof value === 'object' && value !== null) return Object.values(value).some(templated);
  return false;
}

/** Each call's verdict: its tool listed, and its literal arguments (no `{{ }}` in them) fit with the rest left out. */
export function checkServerVerdicts(
  calls: ReadonlyArray<{ step: string; tool: string; with: Record<string, unknown> }>,
  session: Pick<McpSession, 'tools' | 'checkArguments'>,
): ServerCheckView['steps'] {
  return calls.map(({ step, tool, with: args }) => {
    const info = session.tools.find((candidate) => candidate.name === tool);
    if (!info) return { step, tool, verdict: 'missing' as const };
    const literal: Record<string, unknown> = {};
    for (const name of Object.keys(args)) if (!templated(args[name])) literal[name] = args[name];
    const problem = session.checkArguments(info, literal, { partial: true });
    return { step, tool, verdict: problem === null ? ('fits' as const) : { problem } };
  });
}
