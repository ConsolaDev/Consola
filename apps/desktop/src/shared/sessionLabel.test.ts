import { describe, expect, it } from 'vitest';
import type { WorkItemRef } from './workItems';
import { sessionLabel, sessionSubtitle } from './sessionLabel';

const pr4118: WorkItemRef = { provider: 'github', repo: 'sympower/flex-portal', type: 'pr', number: 4118 };
const issue212: WorkItemRef = { ...pr4118, repo: 'sympower/schedule-api', type: 'issue', number: 212 };

describe('sessionLabel', () => {
  it('names a launched PR session by item and action, not by name', () => {
    expect(
      sessionLabel({ workItem: pr4118, workItemAction: 'Review', name: 'LC-416: fix energy axis' })
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
    expect(sessionLabel({ workItem: pr4118, name: 'energy axis investigation' })).toBe(
      '⑂ energy axis investigation'
    );
  });

  it('is the plain name for an ordinary session', () => {
    expect(sessionLabel({ name: 'scratch: grafana panels' })).toBe('scratch: grafana panels');
  });
});

describe('sessionSubtitle', () => {
  it('shows the name under a launched session, whose label no longer shows it', () => {
    expect(
      sessionSubtitle({ workItem: pr4118, workItemAction: 'Review', name: 'LC-416: fix energy axis' })
    ).toBe('LC-416: fix energy axis');
  });

  it('is absent for linked and ordinary sessions, whose label already is the name', () => {
    expect(sessionSubtitle({ workItem: pr4118, name: 'energy axis investigation' })).toBeUndefined();
    expect(sessionSubtitle({ name: 'scratch' })).toBeUndefined();
  });
});
