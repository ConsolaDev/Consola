import { describe, expect, it, vi } from 'vitest';
import type { RunRecord, StepRun } from '@consola/factory-spec';
import { runAttention } from '@consola/automation-engine';
import { RunSource } from './RunSource';
import { AttentionService } from '../attention/AttentionService';

const run = (id: string, status: string, sessionId?: string): RunRecord =>
  ({ id, status, ...(sessionId ? { sessionId } : {}) }) as unknown as RunRecord;

describe('runAttention', () => {
  it('wants the person only for a run waiting for approval', () => {
    expect(runAttention(run('a', 'needs-approval'))).toBe('needs-attention');
    for (const status of ['queued', 'running', 'completed', 'failed', 'rejected']) {
      expect(runAttention(run('a', status))).toBeNull();
    }
  });

  it('wants the person for a run waiting at a gate, never for one waiting out a retry (slice 3)', () => {
    const waiting = (step: Partial<StepRun>): RunRecord =>
      ({
        id: 'a',
        status: 'waiting',
        steps: [{ id: 'decide', kind: 'gate', status: 'waiting', attempt: 1, ...step }],
      }) as unknown as RunRecord;
    expect(runAttention(waiting({ gate: { askedAt: '2026-11-22T09:00:00.000Z' } }))).toBe(
      'needs-attention',
    );
    expect(
      runAttention(waiting({ kind: 'agent', retryAt: '2026-11-22T09:01:00.000Z' })),
    ).toBeNull();
    // A loop's row at its exhaustion gate asks the person too.
    expect(
      runAttention(waiting({ kind: 'repeat', gate: { askedAt: '2026-11-22T09:00:00.000Z' } })),
    ).toBe('needs-attention');
    const source = new RunSource(() => [
      waiting({ gate: { askedAt: '2026-11-22T09:00:00.000Z' } }),
    ]);
    expect([...source.read()]).toEqual([['run:a', 'needs-attention']]);
  });

  it('answers null, not an error, for a status this build does not know', () => {
    expect(runAttention(run('a', 'paused-for-gate'))).toBeNull();
  });
});

describe('RunSource', () => {
  it('emits only runs with attention, keyed run:<id>, with or without a session', () => {
    const source = new RunSource(() => [
      run('1', 'needs-approval'),
      run('2', 'needs-approval', 's2'),
      run('3', 'running', 's3'),
      run('4', 'completed', 's4'),
    ]);
    expect([...source.read()]).toEqual([
      ['run:1', 'needs-attention'],
      ['run:2', 'needs-attention'],
    ]);
  });

  it('holds exactly the sessions of open runs', () => {
    const source = new RunSource(() => [
      run('1', 'queued', 's1'),
      run('2', 'running', 's2'),
      run('3', 'needs-approval', 's3'),
      run('4', 'needs-approval'),
      run('5', 'completed', 's5'),
      run('6', 'failed', 's6'),
      run('7', 'rejected', 's7'),
    ]);
    expect([...source.holds()]).toEqual([
      ['s1', ['run:1']],
      ['s2', ['run:2']],
      ['s3', ['run:3']],
    ]);
  });

  it('reports a session held by an open run through the AttentionService', () => {
    const service = new AttentionService();
    service.register(new RunSource(() => [run('1', 'running', 's1')]));
    expect(service.holds().get('s1')).toEqual(['run:1']);
  });

  it('counts a pending approval toward the badge and never a finished run', () => {
    const service = new AttentionService();
    service.register(new RunSource(() => [run('1', 'needs-approval'), run('2', 'completed', 's')]));
    expect(service.needsAttentionCount()).toBe(1);
  });

  it('tells subscribers when refreshed', () => {
    const source = new RunSource(() => []);
    const cb = vi.fn();
    const off = source.subscribe(cb);
    source.refresh();
    off();
    source.refresh();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
