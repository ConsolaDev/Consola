/**
 * An agent step's conversation as the runner drives it through t3's RPC: the messages it sends
 * (the prompt, then at most one reminder), and what it reads of a turn from the thread's
 * projection (whether it is over, how it failed, what the agent said). Pure.
 */
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  MessageId,
  ProviderDriverKind,
  ThreadId,
} from '@t3tools/contracts';
import type {
  ModelSelection,
  OrchestrationV2Command,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RuntimeRequestId,
} from '@t3tools/contracts';
import type { StepIdentity } from './ports.ts';
import type { StepApproval } from './stepApproval.ts';

/** t3's driver for Claude, the one harness stage 1 runs steps on. */
const CLAUDE_DRIVER = ProviderDriverKind.make('claudeAgent');

/**
 * The step's model on the host's Claude instance (the only one it hydrates): the request's, or
 * t3's default for Claude.
 */
export function stepModelSelection(model: string | null): ModelSelection {
  return {
    instanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
    model: model ?? DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER] ?? 'default',
  };
}

/**
 * The session id of an attempt's host, and its thread's: one per attempt, so a retry never meets
 * an earlier attempt's thread. Only letters, digits, `.`, `_` and `-`, at most 200 characters.
 */
export function stepSessionId(identity: StepIdentity): string {
  const safe = (text: string) => text.replaceAll(/[^A-Za-z0-9._-]/g, '_');
  return `step-${safe(identity.runId)}-${safe(identity.stepId)}-${identity.attempt}`.slice(0, 200);
}

/** The id of the step's `index`th message (1 the prompt, 2 the reminder). */
export const stepMessageId = (sessionId: string, index: number): MessageId =>
  MessageId.make(`message:${sessionId}:${index}`);

/** The step's `index`th message, as t3's chat sends one: a user's, to start at once. */
export function stepMessage(
  sessionId: string,
  index: number,
  text: string,
  modelSelection: ModelSelection,
): OrchestrationV2Command {
  return {
    type: 'message.dispatch',
    createdBy: 'user',
    creationSource: 'web',
    commandId: CommandId.make(`command:${sessionId}:message-${index}`),
    threadId: ThreadId.make(sessionId),
    messageId: stepMessageId(sessionId, index),
    text,
    attachments: [],
    modelSelection,
    dispatchMode: { type: 'start_immediately' },
  };
}

/** The runner's answer to one request, as the command that carries it. */
export function approvalCommand(
  sessionId: string,
  requestId: RuntimeRequestId,
  approval: StepApproval,
): OrchestrationV2Command {
  return {
    type: 'runtime-request.respond',
    commandId: CommandId.make(`command:${sessionId}:respond:${requestId}`),
    threadId: ThreadId.make(sessionId),
    requestId,
    decision: approval.decision,
  };
}

/** The statuses a run ends in. */
const OVER: ReadonlySet<OrchestrationV2Run['status']> = new Set([
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
]);

/** The run the step's `index`th message started, once t3 has filed it. */
export function stepRunOf(
  projection: Pick<OrchestrationV2ThreadProjection, 'runs'>,
  sessionId: string,
  index: number,
): OrchestrationV2Run | undefined {
  const messageId = stepMessageId(sessionId, index);
  return projection.runs.find((run) => run.userMessageId === messageId);
}

export const isRunOver = (run: OrchestrationV2Run): boolean => OVER.has(run.status);

/**
 * Why a run ended without completing, in one sentence: its error item's message where t3 wrote
 * one, else its status. Null for a completed run. The message is t3's, which the runner scrubs
 * before it goes anywhere.
 */
export function runFailure(
  projection: Pick<OrchestrationV2ThreadProjection, 'turnItems'>,
  run: OrchestrationV2Run,
): string | null {
  if (run.status === 'completed') return null;
  const error = projection.turnItems.find((item) => item.runId === run.id && item.type === 'error');
  const said = error?.type === 'error' ? error.failure.message.trim() : '';
  return said === ''
    ? `The step's turn ended ${run.status === 'failed' ? 'in a failure' : run.status.replace('_', ' ')}.`
    : `The step's turn failed: ${said}`;
}

/** What the agent said in the thread, its messages in order, for the end the run's page shows. */
export function assistantText(
  projection: Pick<OrchestrationV2ThreadProjection, 'messages'>,
): string {
  return projection.messages
    .filter((message) => message.role === 'assistant' && message.text.trim() !== '')
    .map((message) => message.text.trim())
    .join('\n\n');
}
