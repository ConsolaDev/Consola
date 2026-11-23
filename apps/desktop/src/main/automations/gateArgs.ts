/*
 * The arguments the renderer hands the gate's two channels (show a gate,
 * answer it), checked in main before anything reaches the engine: nothing
 * but strings. The engine then refuses an id it does not know, or a choice
 * the gate does not offer.
 */

export function gateArgs(runId: unknown, stepId: unknown): { runId: string; stepId: string } {
  if (typeof runId !== 'string' || typeof stepId !== 'string') {
    throw new Error('Run id and step id required.');
  }
  return { runId, stepId };
}

export function gateAnswerArgs(
  runId: unknown,
  stepId: unknown,
  decision: unknown,
): { runId: string; stepId: string; decision: string } {
  if (typeof runId !== 'string' || typeof stepId !== 'string' || typeof decision !== 'string') {
    throw new Error('Run id, step id and decision required.');
  }
  return { runId, stepId, decision };
}
