/**
 * The tools an agent run's threads are served over MCP (`adapters/mcpHttp.ts`), under the names
 * t3's orchestration instructions teach the model (`orchestrator_capabilities`, `delegate_task`,
 * `task_status`, `task_cancel`, `t3_thread_send`), plus `complete_task`. Pure: what each tool is
 * called, what it says it does, and the arguments it reads. `runtime/agentRun.ts` answers them.
 */

/** One tool as `tools/list` lists it. */
export type ToolListing = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<
      Record<string, { readonly type: 'string'; readonly description: string }>
    >;
    readonly required: readonly string[];
  };
};

/** A tool's answer: a JSON value the model reads as text, or an error in words. */
export type ToolAnswer =
  | { readonly isError: false; readonly value: Readonly<Record<string, unknown>> }
  | { readonly isError: true; readonly text: string };

export const toolError = (text: string): ToolAnswer => ({ isError: true, text });
export const toolValue = (value: Readonly<Record<string, unknown>>): ToolAnswer => ({
  isError: false,
  value,
});

const text = (description: string) => ({ type: 'string' as const, description });

/** How dispatch works here, as `orchestrator_capabilities` says it to the orchestrator. */
export const DISPATCH_GUIDE =
  'Dispatch a factory agent with delegate_task({ agent, task }): it starts a separate conversation ' +
  'for that agent, with its own standing instructions and your task as its brief, in this same ' +
  'checkout, and answers at once with its id. It works on its own; its report arrives later as a ' +
  'new message in this conversation ("Report from agent ..."), one per finished turn. If nothing ' +
  'else is left to do after dispatching, end your turn: the report wakes you. Never poll ' +
  '(task_status, sleep, watchers) and never wait in a loop. Send a follow-up into the same ' +
  "agent's conversation with t3_thread_send({ threadId, message }); its reply arrives the same way. " +
  `At most 4 dispatched agents run at once. Never use your built-in subagent tool (Agent, Task) ` +
  'for a factory agent: only delegate_task gives it its instructions. Call complete_task({ summary }) ' +
  'once the work this run covers is finished.';

/** What `orchestrator_capabilities` says to a dispatched agent. */
export const DISPATCHED_GUIDE =
  'You are a dispatched agent: do the work in your brief yourself and end your turn with your ' +
  'report as your final message. You cannot dispatch other agents.';

export const AGENT_RUN_TOOLS: readonly ToolListing[] = [
  {
    name: 'orchestrator_capabilities',
    description:
      'Lists the factory agents this conversation may dispatch (name and description) and how ' +
      'dispatch works in this run. Call it once, before your first delegate_task.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'delegate_task',
    description:
      'Dispatches a factory agent by name: starts a new conversation for it, with its own ' +
      'instructions and `task` as its brief, in this checkout. Returns at once with its taskId ' +
      '(also its threadId). The agent works on its own; its report arrives later as a new message ' +
      'in this conversation. Do not poll for it: end your turn if nothing else is left to do. At ' +
      'most 4 dispatched agents run at once.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: text(
          'The factory agent to dispatch, by name (orchestrator_capabilities lists them).',
        ),
        task: text(
          'The brief: what to do, the context it needs, and what its report must contain. It reads nothing else of this conversation.',
        ),
      },
      required: ['agent', 'task'],
    },
  },
  {
    name: 't3_thread_send',
    description:
      "Sends a follow-up message into a dispatched agent's conversation (threadId from " +
      'delegate_task), which keeps everything it already did. If its turn is over this starts a ' +
      'new one; if it is still working the message waits for its turn to end. Returns at once; ' +
      'its reply arrives later as a new message in this conversation, like a report.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: text('The dispatched agent’s id, as delegate_task answered it.'),
        message: text('The follow-up, whole: the agent sees only this and its own conversation.'),
      },
      required: ['threadId', 'message'],
    },
  },
  {
    name: 'task_status',
    description:
      "A dispatched agent's status and, once its turn is over, its last report. For recovery " +
      '(after an error, or when a report seems lost) only: never poll it, since every report ' +
      'arrives as a message by itself.',
    inputSchema: {
      type: 'object',
      properties: { taskId: text('The dispatched agent’s id, as delegate_task answered it.') },
      required: ['taskId'],
    },
  },
  {
    name: 'task_cancel',
    description:
      "Interrupts a dispatched agent's running turn. Its report then arrives with the status " +
      '`interrupted`. Use it for an agent you no longer need.',
    inputSchema: {
      type: 'object',
      properties: { taskId: text('The dispatched agent’s id, as delegate_task answered it.') },
      required: ['taskId'],
    },
  },
  {
    name: 'complete_task',
    description:
      'Records that the work this run covers is finished, with a summary of what was done (what ' +
      'you posted, decided or changed). Call it once, at the end; calling it again replaces the ' +
      'summary.',
    inputSchema: {
      type: 'object',
      properties: { summary: text('What was done, in a few sentences.') },
      required: ['summary'],
    },
  },
];

const TOOL_NAMES: ReadonlySet<string> = new Set(AGENT_RUN_TOOLS.map((tool) => tool.name));

/** A tool call read: the tool, and its arguments as strings. */
export type ToolCall =
  | { readonly tool: 'orchestrator_capabilities' }
  | { readonly tool: 'delegate_task'; readonly agent: string; readonly task: string }
  | { readonly tool: 't3_thread_send'; readonly threadId: string; readonly message: string }
  | { readonly tool: 'task_status'; readonly taskId: string }
  | { readonly tool: 'task_cancel'; readonly taskId: string }
  | { readonly tool: 'complete_task'; readonly summary: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads a call: the tool's name and its arguments. Fields a tool does not name are ignored (t3's
 * instructions teach the model fields of t3's own tools, `target` say); a field it needs that is
 * missing or not text with something in it is an error that names it.
 */
export function readToolCall(
  name: string,
  args: unknown,
): { readonly ok: true; readonly call: ToolCall } | { readonly ok: false; readonly error: string } {
  if (!TOOL_NAMES.has(name)) {
    return {
      ok: false,
      error: `There is no tool ${name.slice(0, 64)} here. The tools are: ${[...TOOL_NAMES].join(', ')}.`,
    };
  }
  const fields = isRecord(args) ? args : {};
  const need = (field: string): string | null => {
    const value = fields[field];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };
  const missing = (field: string) => ({
    ok: false as const,
    error: `${name} needs \`${field}\`, as text.`,
  });
  switch (name) {
    case 'orchestrator_capabilities':
      return { ok: true, call: { tool: 'orchestrator_capabilities' } };
    case 'delegate_task': {
      const agent = need('agent');
      if (agent === null) return missing('agent');
      const task = need('task');
      if (task === null) return missing('task');
      return { ok: true, call: { tool: 'delegate_task', agent: agent.trim(), task } };
    }
    case 't3_thread_send': {
      const threadId = need('threadId');
      if (threadId === null) return missing('threadId');
      const message = need('message');
      if (message === null) return missing('message');
      return { ok: true, call: { tool: 't3_thread_send', threadId: threadId.trim(), message } };
    }
    case 'task_status':
    case 'task_cancel': {
      const taskId = need('taskId');
      if (taskId === null) return missing('taskId');
      return { ok: true, call: { tool: name, taskId: taskId.trim() } };
    }
    default: {
      const summary = need('summary');
      if (summary === null) return missing('summary');
      return { ok: true, call: { tool: 'complete_task', summary } };
    }
  }
}
