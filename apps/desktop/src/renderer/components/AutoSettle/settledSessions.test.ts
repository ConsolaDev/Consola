import { describe, expect, it } from 'vitest';
import { makeSession, makeWorkspace } from '../../../main/conductor/ConductorTools.test';
import { settledSessionsFor } from './settledSessions';

describe('settledSessionsFor', () => {
  it('names the moved sessions that still exist, across workspaces, and drops deleted ones', () => {
    const w1 = makeWorkspace({
      id: 'w1',
      name: 'One',
      sessions: [makeSession({ id: 'a', name: 'Alpha' })],
    });
    const w2 = makeWorkspace({
      id: 'w2',
      name: 'Two',
      sessions: [makeSession({ id: 'b', name: '' })],
    });
    expect(settledSessionsFor(['a', 'gone', 'b'], [w1, w2])).toEqual([
      { id: 'a', name: 'Alpha', workspaceName: 'One' },
      { id: 'b', name: 'Untitled session', workspaceName: 'Two' },
    ]);
  });
});
