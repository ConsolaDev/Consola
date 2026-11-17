import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@consola/factory-spec';
import { runAttention } from './AutomationService';
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
