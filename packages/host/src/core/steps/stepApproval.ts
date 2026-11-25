/**
 * Who answers an agent step's permission requests: the runner, by the step's policy. The host
 * opens every thread in `approval-required`, so the CLI asks before anything its own rules do not
 * allow, and t3 holds the request in the thread until someone answers. Nobody watches a step, so
 * the runner answers every request it finds, the moment it finds it: a step whose CLI waits on an
 * approval never hangs. Pure: what a request is, and the answer.
 */
import type {
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadProjection,
  ProviderApprovalDecision,
} from '@t3tools/contracts';
import type { StepPolicy } from './ports.ts';
import { STEP_TOOL_CLI_NAMES } from './stepTools.ts';

/** A pending request, as far as the thread says what asks. */
export type StepPermissionRequest = {
  readonly requestId: OrchestrationV2RuntimeRequest['id'];
  /** t3's kind of request: `command`, `file-read`, `file-change`, `user_input`, … */
  readonly kind: OrchestrationV2RuntimeRequest['kind'];
  /**
   * The tool's name as the CLI gives it, where t3 reports it: a `dynamic_tool` item's name (an
   * MCP tool's is `mcp__<server>__<tool>`), and `Bash` for the one tool t3 shows as a command.
   * Null where t3 keeps no name (a file change, a web request).
   */
  readonly toolName: string | null;
  /** The type of the tool call's turn item, when there is one. */
  readonly itemType: string | null;
};

/** The runner's answer to one request. */
export type StepApproval =
  | { readonly answer: 'allow'; readonly decision: Extract<ProviderApprovalDecision, 'accept'> }
  | {
      readonly answer: 'refuse';
      readonly decision: Extract<ProviderApprovalDecision, 'decline' | 'cancel'>;
      /** What was refused, for `deniedTools`. */
      readonly tool: string;
    };

/**
 * The tools a read-only step may use when the CLI asks: reading and searching files, its to-do
 * list, finding a deferred tool, and a subagent (whose own calls are asked about, and answered
 * by this same policy).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'ToolSearch',
  'Agent',
  'Task',
]);

/** What a refused request is called in `deniedTools`: the tool's name, else what t3 calls it. */
const toolLabel = (request: StepPermissionRequest): string => {
  if (request.toolName !== null) return request.toolName;
  if (request.itemType === 'file_change') return 'file-change';
  if (request.itemType === 'web_search') return 'web';
  return request.kind;
};

/**
 * The answer to one request under `policy`. For `read-only`: Consola's step tools and the tools
 * that only read are allowed; anything that runs a command, writes or edits a file, reaches the
 * network, or asks for something else (another MCP server's tool, a broader permission, an MCP
 * server's question, a sign-in) is declined; a question for the person (`user_input`) is
 * cancelled, since nobody watches.
 */
export function decideStepApproval(
  policy: StepPolicy,
  request: StepPermissionRequest,
): StepApproval {
  const refuse = (decision: 'decline' | 'cancel'): StepApproval => ({
    answer: 'refuse',
    decision,
    tool: request.kind === 'user_input' ? 'AskUserQuestion' : toolLabel(request),
  });
  switch (policy) {
    case 'read-only': {
      if (request.kind === 'user_input') return refuse('cancel');
      const name = request.toolName;
      if (name !== null && STEP_TOOL_CLI_NAMES.includes(name)) {
        return { answer: 'allow', decision: 'accept' };
      }
      if (request.kind === 'file-read') return { answer: 'allow', decision: 'accept' };
      if (
        request.kind === 'command' &&
        request.itemType === 'dynamic_tool' &&
        name !== null &&
        READ_ONLY_TOOLS.has(name)
      ) {
        return { answer: 'allow', decision: 'accept' };
      }
      return refuse('decline');
    }
  }
}

/**
 * The thread's pending requests a runner can answer now (live ones), oldest first, each with
 * the tool call it is about: the turn item that shares its native id (Claude's tool use id), as
 * t3's Claude adapter writes them.
 */
export function pendingStepRequests(
  projection: Pick<OrchestrationV2ThreadProjection, 'runtimeRequests' | 'turnItems'>,
): StepPermissionRequest[] {
  return projection.runtimeRequests
    .filter((request) => request.status === 'pending' && request.responseCapability.type === 'live')
    .map((request) => {
      const nativeId = request.nativeRequestRef?.nativeId ?? null;
      const call =
        nativeId === null
          ? undefined
          : projection.turnItems.find(
              (item) =>
                item.nativeItemRef?.nativeId === nativeId &&
                item.type !== 'approval_request' &&
                item.type !== 'user_input_request',
            );
      const toolName =
        call?.type === 'dynamic_tool'
          ? (call.toolName ?? null)
          : call?.type === 'command_execution'
            ? 'Bash'
            : null;
      return { requestId: request.id, kind: request.kind, toolName, itemType: call?.type ?? null };
    });
}
