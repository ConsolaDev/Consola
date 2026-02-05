import { EventEmitter } from 'events';

// Type-only imports - completely erased at compile time, works across ESM/CJS boundary
import type {
  SDKMessage,
  Options,
  PreToolUseHookInput,
  PreToolUseHookSpecificOutput,
  PostToolUseHookInput,
  NotificationHookInput,
  PermissionResult,
  Query,
  query as queryFn,
} from '@anthropic-ai/claude-agent-sdk';

// Permission request types
interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

// Question request types (for AskUserQuestion tool)
interface PendingQuestion {
  requestId: string;
  questions: unknown[];
  resolve: (answers: Record<string, string>) => void;
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
    skills: string[];
    slashCommands: string[];
    plugins: { name: string; path: string }[];
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
    modelUsage?: Record<string, {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      contextWindow: number;
      maxOutputTokens: number;
      costUSD: number;
    }>;
  }) => void;
  'error': (error: Error) => void;
  'status-changed': (status: AgentStatus) => void;
  'notification': (data: {
    message: string;
    title?: string;
  }) => void;
  'message': (message: SDKMessage) => void;
  'session-end': (data: {
    reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other';
    sessionId: string;
  }) => void;
  'session-start': (data: {
    source: 'startup' | 'resume' | 'clear' | 'compact';
    sessionId: string;
    model?: string;
  }) => void;
}

// SDK module type - matches the actual exports from @anthropic-ai/claude-agent-sdk
type SDK = { query: typeof queryFn };

// Lazy-loaded SDK module
let sdkModule: SDK | null = null;

// Use Function constructor to prevent TypeScript from transforming import() to require()
// This is necessary because the SDK is ESM-only and our main process compiles to CommonJS
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
  private additionalDirectories: string[] = [];

  constructor(private cwd: string) {
    super();
  }

  setAdditionalDirectories(dirs: string[]): void {
    this.additionalDirectories = dirs;
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
      additionalDirectories: this.additionalDirectories,
      settingSources: ['user', 'project', 'local'],
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
          hooks: [async (input) => {
            // Type guard for PreToolUse hook
            if (input.hook_event_name !== 'PreToolUse') return { continue: true };

            // Intercept AskUserQuestion tool to show UI
            if (input.tool_name === 'AskUserQuestion') {
              const toolInput = input.tool_input as { questions?: unknown[] };
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
                    questions: (questions as Array<{ question: string; header: string; options?: unknown[]; multiSelect?: boolean }>).map((q) => ({
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
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse' as const,
                      permissionDecision: 'deny' as const,
                      permissionDecisionReason: 'User cancelled the question dialog.'
                    }
                  };
                }

                // Deny the tool execution but pass answers back to Claude
                // This prevents the tool from outputting its question text (since we already showed the UI)
                const answersText = Object.entries(answers)
                  .map(([q, a]) => `Q: ${q}\nA: ${a}`)
                  .join('\n\n');
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'deny' as const,
                    permissionDecisionReason: `User answered the question(s):\n\n${answersText}`
                  }
                };
              }
            }

            // For all other tools, just emit pending event
            this.emit('tool-pending', {
              toolName: input.tool_name,
              toolInput: input.tool_input,
              toolUseId: input.tool_use_id
            });
            return { continue: true };
          }]
        }],
        PostToolUse: [{
          hooks: [async (input) => {
            // Type guard for PostToolUse hook
            if (input.hook_event_name !== 'PostToolUse') return { continue: true };

            this.emit('tool-complete', {
              toolName: input.tool_name,
              toolInput: input.tool_input,
              toolResponse: input.tool_response,
              toolUseId: input.tool_use_id
            });
            return { continue: true };
          }]
        }],
        Notification: [{
          hooks: [async (input) => {
            // Type guard for Notification hook
            if (input.hook_event_name !== 'Notification') return { continue: true };

            this.emit('notification', {
              message: input.message,
              title: input.title
            });
            return { continue: true };
          }]
        }],
        SessionEnd: [{
          hooks: [async (input: any) => {
            if (input.hook_event_name !== 'SessionEnd') return { continue: true };

            this.emit('session-end', {
              reason: input.reason || 'other',
              sessionId: input.session_id
            });

            return { continue: true };
          }]
        }],
        SessionStart: [{
          hooks: [async (input: any) => {
            if (input.hook_event_name !== 'SessionStart') return { continue: true };

            this.emit('session-start', {
              source: input.source || 'startup',
              sessionId: input.session_id,
              model: input.model
            });

            return { continue: true };
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
            mcpServers: message.mcp_servers,
            skills: (message as any).skills || [],
            slashCommands: (message as any).slash_commands || [],
            plugins: (message as any).plugins || []
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
          usage: message.usage,
          modelUsage: message.modelUsage
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

  /**
   * Initialize session without sending a prompt.
   * Returns available skills, commands, and models.
   * Used to pre-populate the command palette before user sends their first message.
   */
  async initializeSession(): Promise<{
    skills: string[];
    slashCommands: string[];
    plugins: { name: string; path: string }[];
  }> {
    console.log('[ClaudeAgentService] initializeSession called, cwd:', this.cwd);
    const sdk = await getSDK();

    // Create a minimal query with empty prompt and maxTurns=0
    // This triggers SDK initialization without executing any turns
    const query = sdk.query({
      prompt: '',
      options: {
        cwd: this.cwd,
        additionalDirectories: this.additionalDirectories,
        settingSources: ['user', 'project', 'local'],
        maxTurns: 0
      }
    }) as Query;

    let skills: string[] = [];
    let slashCommands: string[] = [];
    let plugins: { name: string; path: string }[] = [];

    try {
      // Iterate through messages to get the init message
      console.log('[ClaudeAgentService] Starting to iterate query messages...');
      for await (const message of query) {
        console.log('[ClaudeAgentService] Got message:', message.type, (message as any).subtype);
        if (message.type === 'system' && message.subtype === 'init') {
          skills = (message as any).skills || [];
          slashCommands = (message as any).slash_commands || [];
          plugins = (message as any).plugins || [];
          console.log('[ClaudeAgentService] Init message received:', { skills, slashCommands, plugins });
          break;
        }
      }
      console.log('[ClaudeAgentService] Query iteration complete');
    } catch (error) {
      console.warn('[ClaudeAgentService] Failed to initialize session:', error);
    }

    console.log('[ClaudeAgentService] Returning:', { skills, slashCommands, plugins });
    return {
      skills,
      slashCommands,
      plugins
    };
  }

  destroy(): void {
    this.interrupt();
    this.removeAllListeners();
  }
}
