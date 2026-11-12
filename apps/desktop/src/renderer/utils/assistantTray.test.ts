import { describe, expect, it } from 'vitest';
import { nextTrayState } from './assistantTray';

describe('nextTrayState', () => {
  it('opens on first sight of a request', () => {
    expect(nextTrayState(undefined, ['r1'])).toEqual({ hidden: false, known: ['r1'] });
  });

  it('stays hidden while nothing new arrives, however often it is asked', () => {
    expect(nextTrayState({ hidden: true, known: ['r1'] }, ['r1'])).toEqual({ hidden: true, known: ['r1'] });
  });

  it('reopens when a request it has not shown arrives', () => {
    expect(nextTrayState({ hidden: true, known: ['r1'] }, ['r1', 'r2'])).toEqual({ hidden: false, known: ['r1', 'r2'] });
  });

  it('stays hidden when one is decided elsewhere', () => {
    expect(nextTrayState({ hidden: true, known: ['r1', 'r2'] }, ['r1'])).toEqual({ hidden: true, known: ['r1'] });
  });

  it('keeps its hidden choice once nothing waits', () => {
    expect(nextTrayState({ hidden: true, known: ['r1'] }, [])).toEqual({ hidden: true, known: [] });
    expect(nextTrayState({ hidden: false, known: ['r1'] }, [])).toEqual({ hidden: false, known: [] });
  });
});
