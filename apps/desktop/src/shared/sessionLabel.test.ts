import { describe, expect, it } from 'vitest';
import type { WorkItemRef } from './workItems';
import { sessionLabel } from './sessionLabel';

const pr4118: WorkItemRef = { provider: 'github', repo: 'sprocket/forum-admin', type: 'pr', number: 4118 };
const issue212: WorkItemRef = { ...pr4118, repo: 'sprocket/schedule-api', type: 'issue', number: 212 };

describe('sessionLabel', () => {
  it('names a launched PR session by item and action, not by name', () => {
    expect(
      sessionLabel({ workItem: pr4118, workItemAction: 'Review', name: 'LC-416: fix memory axis' })
    ).toBe('PR #4118 · Review');
  });

  it('names a launched issue session the same way', () => {
    expect(
      sessionLabel({ workItem: issue212, workItemAction: 'Implement', name: 'DST drift' })
    ).toBe('Issue #212 · Implement');
  });

  it('keeps the custom-prompt snapshot as the action', () => {
    expect(
      sessionLabel({ workItem: pr4118, workItemAction: 'Custom prompt', name: 'whatever' })
    ).toBe('PR #4118 · Custom prompt');
  });

  it('marks a linked session with the fork glyph and keeps its own name', () => {
    expect(sessionLabel({ workItem: pr4118, name: 'memory axis investigation' })).toBe(
      '⑂ memory axis investigation'
    );
  });

  it('is the plain name for an ordinary session', () => {
    expect(sessionLabel({ name: 'scratch: grafana panels' })).toBe('scratch: grafana panels');
  });
});
