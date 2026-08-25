import { describe, expect, it } from 'vitest';
import { rankSearchableItems, type SearchableListItem } from './rankSearchableItems';

const memory: SearchableListItem = { id: 's1', label: 'memory axis investigation', context: 'forum-admin' };
const scratch: SearchableListItem = { id: 's2', label: 'scratch: grafana panels', context: 'memory-tools' };
const renovate: SearchableListItem = { id: 's3', label: 'renovate triage', context: 'sprocket' };
const linked: SearchableListItem = {
  id: 's4',
  label: 'PR #4118 · Fix CI',
  context: 'forum-admin',
  disabled: true,
  disabledHint: 'already linked',
};
const items = [scratch, renovate, memory, linked];

describe('rankSearchableItems', () => {
  it('keeps the caller order for an empty or blank query', () => {
    expect(rankSearchableItems(items, '')).toEqual(items);
    expect(rankSearchableItems(items, '   ')).toEqual(items);
  });

  it('drops items that match neither label nor context', () => {
    expect(rankSearchableItems(items, 'memory').map((item) => item.id)).not.toContain('s3');
  });

  it('ranks a label hit above a context-only hit', () => {
    expect(rankSearchableItems(items, 'memory').map((item) => item.id)).toEqual(['s1', 's2']);
  });

  it('keeps disabled items in the ranking — they are shown greyed, not hidden', () => {
    expect(rankSearchableItems(items, 'fix ci').map((item) => item.id)).toEqual(['s4']);
  });

  it('preserves caller order between equal scores', () => {
    const a = { id: 'a', label: 'Review' };
    const b = { id: 'b', label: 'Review' };
    expect(rankSearchableItems([a, b], 'rev')).toEqual([a, b]);
  });
});
