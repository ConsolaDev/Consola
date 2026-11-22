/**
 * Sample lines of Claude's `--output-format stream-json --verbose`, for the
 * turn reader's tests and the tests of what runs it. Each is one JSON line
 * ending `\n`, as the CLI prints it into a pipe; a PTY turns that into `\r\n`.
 *
 * `INIT` and `RESULT_AUTH` are trimmed from what 2.1.330 printed for this
 * plan, not logged in, with no tokens spent; the trimming keeps their key
 * order. Every `RESULT_*` puts `duration_api_ms` first and `type` later, as
 * the CLI does, so nothing can pass by looking for `{"type"`.
 */

/** One object as a stream line. */
export function jsonLine(object: unknown): string {
  return `${JSON.stringify(object)}\n`;
}

const SESSION_ID = '994c889e-bd56-4387-8edb-925fe7b87a27';

export const INIT = jsonLine({
  type: 'system',
  subtype: 'init',
  cwd: '/tmp/sprocket/catalog-portal',
  session_id: SESSION_ID,
  tools: ['Glob', 'Grep', 'Read', 'mcp__consola__consola_set_outputs'],
  mcp_servers: [{ name: 'consola', status: 'connected' }],
  model: 'claude-opus-5-5',
  permissionMode: 'dontAsk',
  apiKeySource: 'none',
  claude_code_version: '2.1.330',
  output_style: 'default',
  agents: ['claude', 'Explore', 'general-purpose', 'Plan'],
  skills: ['dataviz'],
  uuid: 'de3b5839-151b-4cdb-9e9b-85038711140b',
});

export const TOOL_USE = jsonLine({
  type: 'assistant',
  message: {
    id: 'msg_01',
    model: 'claude-opus-5-5',
    role: 'assistant',
    type: 'message',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'mcp__consola__consola_set_outputs',
        input: { outputs: { verdict: 'approve' } },
      },
    ],
    stop_reason: 'tool_use',
  },
  parent_tool_use_id: null,
  session_id: SESSION_ID,
  uuid: '1a2b3c4d-0000-4000-8000-000000000001',
});

export const RESULT_OK = jsonLine({
  duration_api_ms: 8123,
  stop_reason: 'end_turn',
  session_id: SESSION_ID,
  total_cost_usd: 0.0412,
  permission_denials: [],
  terminal_reason: 'completed',
  is_error: false,
  num_turns: 7,
  subtype: 'success',
  api_error_status: null,
  result: 'FINDINGS: done',
  type: 'result',
  duration_ms: 9012,
  uuid: '1a2b3c4d-0000-4000-8000-000000000002',
});

/** What 2.1.330 printed with no login: `success`, yet `is_error`. */
export const RESULT_AUTH = jsonLine({
  duration_api_ms: 0,
  stop_reason: 'stop_sequence',
  session_id: SESSION_ID,
  total_cost_usd: 0,
  modelUsage: {},
  permission_denials: [],
  terminal_reason: 'api_error',
  is_error: true,
  num_turns: 1,
  subtype: 'success',
  api_error_status: null,
  result: 'Not logged in · Please run /login',
  type: 'result',
  duration_ms: 42,
  uuid: 'b2faef3e-8cbb-4112-a6fd-c834e722cf98',
});

export const RESULT_MAX_TURNS = jsonLine({
  duration_api_ms: 30211,
  stop_reason: 'tool_use',
  session_id: SESSION_ID,
  total_cost_usd: 0.0607,
  permission_denials: [],
  terminal_reason: 'max_turns',
  is_error: true,
  num_turns: 6,
  subtype: 'error_max_turns',
  api_error_status: null,
  type: 'result',
  duration_ms: 31877,
  uuid: '1a2b3c4d-0000-4000-8000-000000000003',
});

export const ASSISTANT_RATE_LIMIT = jsonLine({
  type: 'assistant',
  message: {
    id: 'msg_02',
    model: '<synthetic>',
    role: 'assistant',
    type: 'message',
    content: [{ type: 'text', text: 'You’ve hit your limit · resets 3pm (Europe/Madrid)' }],
  },
  parent_tool_use_id: null,
  session_id: SESSION_ID,
  uuid: '1a2b3c4d-0000-4000-8000-000000000004',
  error: 'rate_limit',
  is_api_error_message: true,
});

/** The 2.1.330 binary's schema for a refused request; not yet seen in a live stream. */
export const RATE_LIMIT_REJECTED = jsonLine({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: 1795000000 },
});

/** A `result` like `RESULT_OK`, with `fields` replaced (key order kept, new keys last). */
export function resultLine(fields: Record<string, unknown>): string {
  return jsonLine({ ...JSON.parse(RESULT_OK), ...fields });
}
