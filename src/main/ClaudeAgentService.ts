import { EventEmitter } from 'events';

// Types only - actual SDK loaded dynamically
type SDKMessage = any;
type Options = any;
type PreToolUseHookInput = { tool_name: string; tool_input: unknown; tool_use_id?: string };
type PostToolUseHookInput = { tool_name: string; tool_input: unknown; tool_response: unknown; tool_use_id?: string };
type NotificationHookInput = { message: string; title?: string };

// Permission request types
interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

interface PermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

// Question request types (for AskUserQuestion tool)
interface PendingQuestion {
  requestId: string;
  questions: any[];
  resolve: (answers: Record<string, string>) => void;
}

// PreToolUse hook output type
interface PreToolUseHookOutput {
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}

export interface AgentQueryOptions {
  prompt: string;
  allowedTools?: string[];
  maxTurns?: number;
  resume?: string;
  continue?: boolean;
}

export interface AgentStatus {
  isRunning: boolean;
  sessionId: string | null;
  model: string | null;
  permissionMode: string | null;
}

export interface ClaudeAgentServiceEvents {
  'init': (data: {
    sessionId: string;
    model: string;
    tools: string[];
    mcpServers: { name: string; status: string }[];
  }) => void;
  'assistant-message': (data: {
    uuid: string;
    sessionId: string;
    content: unknown;
  }) => void;
  'stream': (data: {
    event: unknown;
    uuid: string;
  }) => void;
  'tool-pending': (data: {
    toolName: string;
    toolInput: unknown;
  }) => void;
  'tool-complete': (data: {
    toolName: string;
    toolInput: unknown;
    toolResponse: unknown;
  }) => void;
  'result': (data: {
    subtype: string;
    sessionId: string;
    result: string | null;
    isError: boolean;
    numTurns: number;
    totalCostUsd: number;
    usage: {
      input_tokens: number | null;
      output_tokens: number | null;
    };
  }) => void;
  'error': (error: Error) => void;
  'status-changed': (status: AgentStatus) => void;
  'notification': (data: {
    message: string;
    title?: string;
  }) => void;
  'message': (message: SDKMessage) => void;
}

// SDK type
type SDK = { query: (opts: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage> };

// Lazy-loaded SDK module
let sdkModule: SDK | null = null;

// Use Function constructor to prevent TypeScript from transforming import() to require()
const dynamicImport = new Function('modulePath', 'return import(modulePath)') as (modulePath: string) => Promise<SDK>;

async function getSDK(): Promise<SDK> {
  if (!sdkModule) {
    // Dynamic import for ESM module compatibility
    sdkModule = await dynamicImport('@anthropic-ai/claude-agent-sdk');
  }
  return sdkModule!;
}

export class ClaudeAgentService extends EventEmitter {
  private currentQuery: AsyncIterable<SDKMessage> | null = null;
  private abortController: AbortController | null = null;
  private status: AgentStatus = {
    isRunning: false,
    sessionId: null,
    model: null,
    permissionMode: null
  };
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private pendingQuestions: Map<string, PendingQuestion> = new Map();

  constructor(private cwd: string) {
    super();
  }

  // Respond to a pending permission or question request
  respondToPermission(requestId: string, action: 'approve' | 'reject' | 'modify', options?: {
    modifiedInput?: Record<string, unknown>;
    feedback?: string;
    answers?: Record<string, string>;
  }): void {
    // Check if this is a question request
    const pendingQuestion = this.pendingQuestions.get(requestId);
    if (pendingQuestion) {
      if (action === 'approve' && options?.answers) {
        pendingQuestion.resolve(options.answers);
      } else {
        // User cancelled/rejected - provide empty answers
        pendingQuestion.resolve({});
      }
      this.pendingQuestions.delete(requestId);
      return;
    }

    // Otherwise it's a permission request
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      console.warn(`No pending request found for requestId: ${requestId}`);
      return;
    }

    if (action === 'approve') {
      pending.resolve({
        behavior: 'allow',
        updatedInput: options?.modifiedInput ?? pending.toolInput
      });
    } else if (action === 'modify' && options?.modifiedInput) {
      pending.resolve({
        behavior: 'allow',
        updatedInput: options.modifiedInput
      });
    } else {
      pending.resolve({
        behavior: 'deny',
        message: options?.feedback || 'User denied the action'
      });
    }

    this.pendingPermissions.delete(requestId);
  }

  async startQuery(options: AgentQueryOptions): Promise<void> {
    if (this.status.isRunning) {
      throw new Error('Query already in progress');
    }

    const sdk = await getSDK();

    this.abortController = new AbortController();
    this.status.isRunning = true;
    this.emit('status-changed', { ...this.status });

    const sdkOptions: Options = {
      cwd: this.cwd,
      abortController: this.abortController,
      allowedTools: options.allowedTools,
      maxTurns: options.maxTurns,
      resume: options.resume,
      continue: options.continue,
      includePartialMessages: true,
      // Permission callback - asks user for approval
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        opts: { signal: AbortSignal; toolUseID: string; decisionReason?: string }
      ): Promise<PermissionResult> => {
        const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        // Create a promise that will be resolved when user responds
        return new Promise<PermissionResult>((resolve) => {
          this.pendingPermissions.set(requestId, {
            requestId,
            toolName,
            toolInput: input,
            resolve
          });

          // Emit event to UI
          this.emit('input-request', {
            requestId,
            type: 'permission',
            toolName,
            toolInput: input,
            description: opts.decisionReason || `Allow ${toolName}?`
          });

          // Handle abort signal
          opts.signal.addEventListener('abort', () => {
            if (this.pendingPermissions.has(requestId)) {
              this.pendingPermissions.delete(requestId);
              resolve({ behavior: 'deny', message: 'Operation cancelled' });
            }
          });
        });
      },
      hooks: {
        PreToolUse: [{
          hooks: [async (input: PreToolUseHookInput): Promise<PreToolUseHookOutput> => {
            // Intercept AskUserQuestion tool to show UI
            if (input.tool_name === 'AskUserQuestion') {
              const toolInput = input.tool_input as { questions?: any[] };
              const questions = toolInput?.questions || [];

              if (questions.length > 0) {
                const requestId = `question-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

                // Wait for user response
                const answers = await new Promise<Record<string, string>>((resolve) => {
                  this.pendingQuestions.set(requestId, {
                    requestId,
                    questions,
                    resolve
                  });

                  // Emit event to UI with questions
                  this.emit('input-request', {
                    requestId,
                    type: 'question',
                    toolName: input.tool_name,
                    toolInput: input.tool_input,
                    questions: questions.map((q: any) => ({
                      question: q.question,
                      header: q.header,
                      options: q.options || [],
                      multiSelect: q.multiSelect || false
                    }))
                  });
                });

                // Check if user cancelled/rejected
                if (Object.keys(answers).length === 0) {
                  return {
                    permissionDecision: 'deny' as const,
                    permissionDecisionReason: 'User cancelled the question dialog.'
                  };
                }

                // Deny the tool execution but pass answers back to Claude
                // This prevents the tool from outputting its question text (since we already showed the UI)
                const answersText = Object.entries(answers)
                  .map(([q, a]) => `Q: ${q}\nA: ${a}`)
                  .join('\n\n');
                return {
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: `User answered the question(s):\n\n${answersText}`
                };
              }
            }

            // For all other tools, just emit pending event
            this.emit('tool-pending', {
              toolName: input.tool_name,
              toolInput: input.tool_input,
              toolUseId: input.tool_use_id
            });
            return {};
          }]
        }],
        PostToolUse: [{
          hooks: [async (input: PostToolUseHookInput) => {
            this.emit('tool-complete', {
              toolName: input.tool_name,
              toolInput: input.tool_input,
              toolResponse: input.tool_response,
              toolUseId: input.tool_use_id
            });
            return {};
          }]
        }],
        Notification: [{
          hooks: [async (input: NotificationHookInput) => {
            this.emit('notification', {
              message: input.message,
              title: input.title
            });
            return {};
          }]
        }]
      }
    };

    try {
      this.currentQuery = sdk.query({ prompt: options.prompt, options: sdkOptions });

      for await (const message of this.currentQuery) {
        this.handleMessage(message);
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.status.isRunning = false;
      this.currentQuery = null;
      this.abortController = null;
      this.emit('status-changed', { ...this.status });
    }
  }

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.status.sessionId = message.session_id;
          this.status.model = message.model;
          this.status.permissionMode = message.permissionMode;
          this.emit('init', {
            sessionId: message.session_id,
            model: message.model,
            tools: message.tools,
            mcpServers: message.mcp_servers
          });
        }
        break;

      case 'assistant':
        this.emit('assistant-message', {
          uuid: message.uuid,
          sessionId: message.session_id,
          content: message.message.content
        });
        break;

      case 'stream_event':
        this.emit('stream', {
          event: message.event,
          uuid: message.uuid
        });
        break;

      case 'result':
        this.emit('result', {
          subtype: message.subtype,
          sessionId: message.session_id,
          result: 'result' in message ? message.result : null,
          isError: message.is_error,
          numTurns: message.num_turns,
          totalCostUsd: message.total_cost_usd,
          usage: message.usage
        });
        break;
    }

    this.emit('message', message);
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
  }

  getStatus(): AgentStatus {
    return { ...this.status };
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  destroy(): void {
    this.interrupt();
    this.removeAllListeners();
  }
}
