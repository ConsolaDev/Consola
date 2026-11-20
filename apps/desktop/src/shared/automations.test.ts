import { describe, expect, it } from 'vitest';
import {
  isAgentRunPreview,
  isAssistantRequest,
  isStepsRunPreview,
  runTitle,
  waitingAssistantRequests,
  type RunRecord,
} from './automations';

function run(id: string, fields: Partial<RunRecord> & { actorId?: string } = {}): RunRecord {
  const { actorId, ...rest } = fields;
  return {
    id,
    runner: 'local',
    source: 'manual',
    automationId: 'consola#delete_session',
    actionName: 'consola#delete_session',
    actionVersion: 'v1',
    mode: 'confirm',
    trigger: {
      kind: 'manual',
      at: '2026-11-12T10:00:00Z',
      by: 'agent',
      ...(actorId ? { actorId } : {}),
    },
    status: 'needs-approval',
    attribution: {
      automationId: 'consola#delete_session',
      actionName: 'consola#delete_session',
      triggerKind: 'manual',
    },
    createdAt: '2026-11-12T10:00:00Z',
    updatedAt: '2026-11-12T10:00:00Z',
    ...rest,
  } as RunRecord;
}

describe('the Assistant’s requests', () => {
  const runs = [
    run('a1', { actorId: 'asst' }),
    run('a2', { actorId: 'asst', status: 'completed' }),
    run('o1', { actorId: 's-2' }),
    run('c1', {
      source: 'personal',
      automationId: 'sweep',
      trigger: { kind: 'cron', at: '2026-11-12T10:00:00Z' } as RunRecord['trigger'],
    }),
  ];

  it('is a run the Assistant asked for', () => {
    expect(isAssistantRequest(runs[0]!, 'asst')).toBe(true);
    expect(isAssistantRequest(runs[2]!, 'asst')).toBe(false);
    expect(isAssistantRequest(runs[3]!, 'asst')).toBe(false);
  });

  it('keeps only the Assistant’s runs still waiting for a person', () => {
    expect(waitingAssistantRequests(runs, 'asst').map((candidate) => candidate.id)).toEqual(['a1']);
  });

  it('is nothing before the workspace has an Assistant', () => {
    expect(waitingAssistantRequests(runs, undefined)).toEqual([]);
  });
});

describe('a run’s result, as the renderer tells them apart', () => {
  const stepsRun = {
    kind: 'steps-run',
    steps: [
      { id: 'review', kind: 'agent' },
      { id: 'publish', kind: 'run' },
    ],
    scope: 'api',
  };
  const agentRun = { kind: 'agent-run', runs: 'Review action', prompt: 'Review it.' };

  it('is a steps run’s preview', () => {
    expect(isStepsRunPreview(stepsRun)).toBe(true);
    expect(isAgentRunPreview(stepsRun)).toBe(false);
    expect(isStepsRunPreview(agentRun)).toBe(false);
  });

  it('is not a tool’s result, nothing, or a preview without its steps', () => {
    for (const value of [
      { swept: 2 },
      null,
      undefined,
      'steps-run',
      { kind: 'steps-run' },
      { kind: 'steps-run', steps: 'review' },
    ]) {
      expect(isStepsRunPreview(value)).toBe(false);
    }
  });
});

describe('runTitle', () => {
  it('names an agent’s request by what it asks to do', () => {
    expect(runTitle(run('r1'))).toBe('Delete session');
  });

  it('names an automation’s run by the automation', () => {
    expect(runTitle(run('r2', { source: 'personal', automationId: 'sweep' }))).toBe('sweep');
  });
});
