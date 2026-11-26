import type { OrchestrationV2ThreadProjection } from '@t3tools/contracts';
import { describe, expect, it } from 'vite-plus/test';
import { decideStepApproval, pendingStepRequests } from './stepApproval.ts';
import type { StepPermissionRequest } from './stepApproval.ts';

const request = (fields: Partial<StepPermissionRequest>): StepPermissionRequest => ({
  requestId: 'runtime-request:1' as StepPermissionRequest['requestId'],
  kind: 'command',
  toolName: null,
  itemType: null,
  ...fields,
});

describe('decideStepApproval, read-only', () => {
  it("allows Consola's step tools and the tools that touch nothing", () => {
    for (const toolName of [
      'mcp__consola__consola_set_outputs',
      'mcp__consola__consola_write_artifact',
      'mcp__consola__consola_read_artifact',
      'mcp__consola__consola_list_artifacts',
    ]) {
      expect(
        decideStepApproval('read-only', request({ toolName, itemType: 'dynamic_tool' })),
      ).toEqual({ answer: 'allow', decision: 'accept' });
    }
    expect(
      decideStepApproval(
        'read-only',
        request({ kind: 'command', toolName: 'TodoWrite', itemType: 'dynamic_tool' }),
      ).answer,
    ).toBe('allow');
  });

  it('declines whatever runs a command, writes, reads outside the checkout, reaches the network or asks for more', () => {
    const cases: Array<[Partial<StepPermissionRequest>, string]> = [
      // The CLI asks to read only outside the step's folders: /proc holds the API key.
      [{ kind: 'file-read', toolName: 'Read', itemType: 'dynamic_tool' }, 'Read'],
      [{ kind: 'file-read', toolName: 'Grep', itemType: 'dynamic_tool' }, 'Grep'],
      [{ kind: 'command', toolName: 'Bash', itemType: 'command_execution' }, 'Bash'],
      [{ kind: 'file-change', itemType: 'file_change' }, 'file-change'],
      [{ kind: 'command', itemType: 'web_search' }, 'web'],
      [
        { kind: 'command', toolName: 'mcp__github__create_issue', itemType: 'dynamic_tool' },
        'mcp__github__create_issue',
      ],
      [{ kind: 'command', toolName: 'Monitor', itemType: 'dynamic_tool' }, 'Monitor'],
      [{ kind: 'permission' }, 'permission'],
      [{ kind: 'mcp-elicitation' }, 'mcp-elicitation'],
      [{ kind: 'auth_refresh' }, 'auth_refresh'],
      // A step tool's name on another kind of request is still not a read: only its own call is.
      [{ kind: 'command', toolName: null, itemType: null }, 'command'],
    ];
    for (const [fields, tool] of cases) {
      expect(decideStepApproval('read-only', request(fields))).toEqual({
        answer: 'refuse',
        decision: 'decline',
        tool,
      });
    }
  });

  it('cancels a question for the person, since nobody watches a step', () => {
    expect(decideStepApproval('read-only', request({ kind: 'user_input' }))).toEqual({
      answer: 'refuse',
      decision: 'cancel',
      tool: 'AskUserQuestion',
    });
  });
});

describe('pendingStepRequests', () => {
  const at = '2026-11-25T08:00:00.000Z';
  const item = (fields: Record<string, unknown>) => ({
    id: `turn-item:${String(fields.type)}`,
    threadId: 'step-1',
    runId: 'run-1',
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    parentItemId: null,
    ordinal: 1,
    status: 'running',
    title: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
    ...fields,
  });
  const native = (nativeId: string) => ({ driver: 'claudeAgent', nativeId, strength: 'strong' });
  const runtimeRequest = (id: string, nativeId: string, fields: Record<string, unknown> = {}) => ({
    id,
    nodeId: 'node-1',
    providerTurnId: null,
    nativeRequestRef: native(nativeId),
    kind: 'command',
    status: 'pending',
    responseCapability: { type: 'live', providerSessionId: 'session-1' },
    createdAt: at,
    resolvedAt: null,
    ...fields,
  });

  it('pairs each live pending request with the tool call that shares its native id', () => {
    const projection = {
      runtimeRequests: [
        runtimeRequest('r-1', 'toolu_bash'),
        runtimeRequest('r-2', 'toolu_write', { kind: 'file-change' }),
        runtimeRequest('r-3', 'toolu_mcp'),
        runtimeRequest('r-4', 'toolu_done', { status: 'resolved' }),
        runtimeRequest('r-5', 'toolu_message', { responseCapability: { type: 'message' } }),
      ],
      turnItems: [
        item({ type: 'command_execution', input: 'rm -rf /', nativeItemRef: native('toolu_bash') }),
        item({
          type: 'approval_request',
          requestId: 'r-1',
          requestKind: 'command',
          nativeItemRef: native('toolu_bash'),
        }),
        item({ type: 'file_change', fileName: 'x', nativeItemRef: native('toolu_write') }),
        item({
          type: 'dynamic_tool',
          toolName: 'mcp__consola__consola_set_outputs',
          input: {},
          nativeItemRef: native('toolu_mcp'),
        }),
      ],
    } as unknown as Pick<OrchestrationV2ThreadProjection, 'runtimeRequests' | 'turnItems'>;
    expect(pendingStepRequests(projection)).toEqual([
      { requestId: 'r-1', kind: 'command', toolName: 'Bash', itemType: 'command_execution' },
      { requestId: 'r-2', kind: 'file-change', toolName: null, itemType: 'file_change' },
      {
        requestId: 'r-3',
        kind: 'command',
        toolName: 'mcp__consola__consola_set_outputs',
        itemType: 'dynamic_tool',
      },
    ]);
  });
});
