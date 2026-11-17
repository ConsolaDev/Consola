import { describe, expect, it } from 'vitest';
import { TurnActivity } from './TurnActivity';

function setup() {
  const touches: Array<[string, string, number]> = [];
  const activity = new TurnActivity(
    { touch: (sessionId, workspaceId, at) => touches.push([sessionId, workspaceId, at]) },
    (instanceId) => (instanceId === 'inst-1' ? { sessionId: 's1', workspaceId: 'w1' } : undefined),
    () => 1000
  );
  return { activity, touches };
}

describe('TurnActivity', () => {
  it('records a turn starting and finishing against the session, not the instance', () => {
    const { activity, touches } = setup();
    activity.statusChanged('inst-1', 'working');
    activity.statusChanged('inst-1', 'ready');
    expect(touches).toEqual([
      ['s1', 'w1', 1000],
      ['s1', 'w1', 1000],
    ]);
  });

  it('does not count a session settling into ready, or exiting, as activity', () => {
    const { activity, touches } = setup();
    activity.statusChanged('inst-1', 'ready');
    activity.statusChanged('inst-1', 'needs-attention');
    activity.statusChanged('inst-1', 'exited');
    expect(touches).toEqual([]);
  });

  it('counts the turn resuming after a confirmation as a new start', () => {
    const { activity, touches } = setup();
    activity.statusChanged('inst-1', 'working');
    activity.statusChanged('inst-1', 'needs-attention');
    activity.statusChanged('inst-1', 'working');
    expect(touches).toHaveLength(2);
  });

  it('treats the first working after a destroy as a start, even if it was destroyed mid-turn', () => {
    const { activity, touches } = setup();
    activity.statusChanged('inst-1', 'working');
    activity.forget('inst-1');
    activity.statusChanged('inst-1', 'working');
    expect(touches).toHaveLength(2);
  });

  it('ignores a terminal whose session is gone', () => {
    const { activity, touches } = setup();
    activity.statusChanged('inst-unknown', 'working');
    expect(touches).toEqual([]);
  });
});
