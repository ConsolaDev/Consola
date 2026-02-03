import { EventEmitter } from 'events';

// Types only - actual SDK loaded dynamically
type SDKMessage = any;
type Options = any;
type PreToolUseHookInput = { tool_name: string; tool_input: unknown };
type PostToolUseHookInput = { tool_name: string; tool_input: unknown; tool_response: unknown };
type NotificationHookInput = { message: string; title?: string };

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

  constructor(private cwd: string) {
    super();
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
      hooks: {
        PreToolUse: [{
          hooks: [async (input: PreToolUseHookInput) => {
            this.emit('tool-pending', {
              toolName: input.tool_name,
              toolInput: input.tool_input
            });
            return {};
          }]
        }],
        PostToolUse: [{
          hooks: [async (input: PostToolUseHookInput) => {
            this.emit('tool-complete', {
              toolName: input.tool_name,
              toolInput: input.tool_input,
              toolResponse: input.tool_response
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
