import type { AttentionSignal } from '../attention/hookSignals';
import type { AttentionHooks } from './HarnessDriver';

/**
 * Claude Code's hooks as an attention source (observed live against 2.1.325).
 *
 * Three hooks, all POSTing the event's JSON to a loopback URL:
 *
 * - `PermissionRequest` fires the moment a permission menu or an
 *   AskUserQuestion is shown. The `permission_prompt` notification reports the
 *   same menu only after it has waited about six seconds, so this is the fast
 *   one; the notification stays as a second witness.
 * - `Notification` carries `notification_type`, the field to branch on — the
 *   message text is prose and changes.
 * - `Stop` ends a turn and lists `background_tasks` still running, each with
 *   a `type` (`subagent` for the agent's own background agents).
 * - `StopFailure` fires instead of `Stop` when an API error ended the turn,
 *   with `error` naming which (`rate_limit` for a usage limit).
 *
 * Passed through `--settings`, hooks add to the user's own and managed
 * settings outrank them: nothing is written to any settings file, other
 * hooks keep running beside these, and an `allowManagedHooksOnly` policy
 * simply leaves the session on the screen heuristic. Nothing fires until the
 * folder is trusted in an interactive session, which is why the screen's
 * trust-gate markers must stay.
 */

/**
 * Every notification type that says something about attention, and the two
 * that say a usage limit's wait is over (Claude resumed by itself, or its
 * planned resume went stale).
 */
const NOTIFICATION_MATCHER =
  'permission_prompt|elicitation_dialog|agent_needs_input|agent_completed|idle_prompt|quota_auto_resume_fired|quota_auto_resume_stale';

/** A hook that must never hold the CLI up if Consola is not answering. */
const HOOK_TIMEOUT_SECONDS = 5;

/** The `--settings` JSON that registers the hooks, posting to `url`. */
export function claudeHookSettings(url: string): string {
  const handler = [{ type: 'http', url, timeout: HOOK_TIMEOUT_SECONDS }];
  return JSON.stringify({
    hooks: {
      PermissionRequest: [{ matcher: '', hooks: handler }],
      Notification: [{ matcher: NOTIFICATION_MATCHER, hooks: handler }],
      // An answered prompt: the tool ran, or the person sent something.
      PostToolUse: [{ matcher: '', hooks: handler }],
      UserPromptSubmit: [{ matcher: '', hooks: handler }],
      Stop: [{ matcher: '', hooks: handler }],
      StopFailure: [{ matcher: '', hooks: handler }],
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Identifies one tool call by what it was asked to do, or undefined when the payload does not say. */
function toolCallKey(event: Record<string, unknown>): string | undefined {
  if (typeof event.tool_name !== 'string') return undefined;
  return `${event.tool_name}:${JSON.stringify(event.tool_input ?? null)}`;
}

/** What each `notification_type` means for attention. Unlisted types say nothing. */
const NOTIFICATION_SIGNALS = new Map<string, AttentionSignal>(
  Object.entries({
    // Fires only after the prompt has waited about six seconds.
    permission_prompt: { kind: 'needs-input', origin: 'menu', lagging: true },
    elicitation_dialog: { kind: 'needs-input', origin: 'question' },
    agent_needs_input: { kind: 'needs-input', origin: 'subagent' },
    idle_prompt: { kind: 'idle' },
    agent_completed: { kind: 'subagent-finished' },
    quota_auto_resume_fired: { kind: 'limit-over' },
    quota_auto_resume_stale: { kind: 'limit-over' },
  } satisfies Record<string, AttentionSignal>),
);

export function parseClaudeHookEvent(body: unknown): AttentionSignal | null {
  const event = asRecord(body);
  if (!event) return null;
  switch (event.hook_event_name) {
    case 'PermissionRequest':
      return {
        kind: 'needs-input',
        // The prompt is a subagent's when the payload names one.
        origin: typeof event.agent_id === 'string' && event.agent_id ? 'subagent' : 'menu',
        tool: toolCallKey(event),
      };
    case 'Notification': {
      const type = event.notification_type;
      return (typeof type === 'string' && NOTIFICATION_SIGNALS.get(type)) || null;
    }
    case 'PostToolUse':
      // Observed live (2.1.325): a PermissionRequest and the PostToolUse
      // of the call it was for carry the same tool_name and tool_input,
      // and the former has no tool_use_id to match on. Without a key the
      // completion cannot be tied to any prompt and clears none.
      // A subagent's calls carry its `agent_id` (observed live, 2.1.327)
      // and keep completing after the session's own turn has ended.
      return {
        kind: 'resumed',
        tool: toolCallKey(event) ?? 'unknown-call',
        ...(typeof event.agent_id === 'string' && event.agent_id ? { agent: true as const } : {}),
      };
    case 'UserPromptSubmit':
      return { kind: 'resumed' };
    case 'Stop': {
      // Absent when the CLI could not reach its task registry: no news of
      // background work is not news of some, so it does not hold the turn.
      // Only tasks still running count; a finished one holds nothing. The
      // payload cannot say which running task the agent is awaiting and
      // which is incidental (a dev server), so the hold is bounded by
      // whoever applies it rather than decided here. A `subagent` is the
      // exception (observed live, 2.1.326): Claude shows "Waiting for N
      // background agents to finish" and takes a turn on each result,
      // so it is awaited by construction.
      const tasks = Array.isArray(event.background_tasks) ? event.background_tasks : [];
      const running = tasks.map(asRecord).filter((task) => task?.status === 'running');
      const agents = running.filter((task) => task?.type === 'subagent');
      return {
        kind: 'turn-ended',
        backgroundWork: running.length,
        backgroundAgents: agents.length,
      };
    }
    case 'StopFailure':
      // Fires instead of Stop. Which error is a word Claude defines; only
      // `rate_limit` is a usage limit, and anything else is a failed turn.
      return { kind: 'turn-failed', limit: event.error === 'rate_limit' };
    default:
      return null;
  }
}

export const claudeAttentionHooks: AttentionHooks = { parse: parseClaudeHookEvent };
