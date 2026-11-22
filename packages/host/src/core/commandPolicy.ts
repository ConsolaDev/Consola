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
