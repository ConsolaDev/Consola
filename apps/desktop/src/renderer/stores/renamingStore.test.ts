import { beforeEach, describe, expect, it } from 'vitest';
import { markRenaming, useRenamingStore } from './renamingStore';

describe('renamingStore', () => {
  beforeEach(() => useRenamingStore.setState({ sessionId: null }));

  it('names the row being renamed until its field closes', () => {
    const unmark = markRenaming('s1');
    expect(useRenamingStore.getState().sessionId).toBe('s1');
    unmark();
    expect(useRenamingStore.getState().sessionId).toBeNull();
  });

  it('leaves a later row’s mark alone when an earlier field closes', () => {
    const unmarkFirst = markRenaming('s1');
    markRenaming('s2');
    unmarkFirst();
    expect(useRenamingStore.getState().sessionId).toBe('s2');
  });
});
