/**
 * The commands of t3's chat RPC that one Consola session runs. Everything else t3 can do to a
 * thread (fork, rollback, archive, rename) is the product's, not this host's.
 */
export const OFFERED_COMMANDS: ReadonlySet<string> = new Set([
  'message.dispatch',
  'run.interrupt',
  'runtime-request.respond',
  'thread.model-selection.set',
]);

export function decideCommand(type: string): 'run' | 'not-offered' {
  return OFFERED_COMMANDS.has(type) ? 'run' : 'not-offered';
}

/**
 * The prefix of every command and message id an agent run's host dispatches itself
 * (`runtime/agentRun.ts`): its prompt, its reports, a person's follow-up, and its dispatched
 * agents' threads, briefs, follow-ups and cancels. t3 runs a command id once, whatever thread it
 * names, so a client that took one of these ids first would make the host's own command read as
 * already run, or as a conflict. t3's client makes its ids from UUIDs, so it never names one.
 */
export const HOST_ID_PREFIX = 'consola-host:';

/** The id of a command the host dispatches itself into `threadId`, for `key`. */
export const hostCommandId = (threadId: string, key: string): string =>
  `${HOST_ID_PREFIX}command:${threadId}:${key}`;

/** The id of a message the host dispatches itself into `threadId`, for `key`. */
export const hostMessageId = (threadId: string, key: string): string =>
  `${HOST_ID_PREFIX}message:${threadId}:${key}`;

/**
 * Whether a client's command takes an id the host keeps for its own (`HOST_ID_PREFIX`), as its
 * command id or its message's: such a command is refused, whatever its type.
 */
export function claimsHostId(command: {
  readonly commandId: string;
  readonly messageId?: string | undefined;
}): boolean {
  return (
    command.commandId.startsWith(HOST_ID_PREFIX) ||
    (command.messageId?.startsWith(HOST_ID_PREFIX) ?? false)
  );
}
