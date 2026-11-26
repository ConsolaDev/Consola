import { describe, expect, it } from 'vitest';
import type { Attention } from '../../shared/attention';
import { entry, keyOf, node } from './entryFixtures';
import { createWorkingExits, EXIT_GRACE_MS } from './workingExits';

const one = (attention: Attention, activityAt = 0) => [node(entry('a', attention, { activityAt }))];
const A = keyOf('a');

describe('createWorkingExits', () => {
  it('keeps a tree that stopped on its own in Working for its grace, then lets it go', () => {
    const exits = createWorkingExits();
    exits.observe(one('working'), 1000);

    const stopped = exits.observe(one('done'), 2000);
    expect(stopped.lingering.has(A)).toBe(true);
    expect(stopped.nextDeadline).toBe(2000 + EXIT_GRACE_MS);
    expect(stopped.returnedAt.has(A)).toBe(false);

    const still = exits.observe(one('ready'), 2000 + EXIT_GRACE_MS - 1);
    expect(still.lingering.has(A)).toBe(true);

    const gone = exits.observe(one('ready'), 2000 + EXIT_GRACE_MS);
    expect(gone.lingering.has(A)).toBe(false);
    expect(gone.workingSince.has(A)).toBe(false);
    expect(gone.returnedAt.get(A)).toBe(2000 + EXIT_GRACE_MS);
    expect(gone.nextDeadline).toBeNull();
  });

  it('dates a return by when the grace ran out, however late the next look is', () => {
    const exits = createWorkingExits();
    exits.observe(one('working'), 1000);
    exits.observe(one('done'), 2000);
    expect(exits.observe(one('done'), 60_000).returnedAt.get(A)).toBe(2000 + EXIT_GRACE_MS);
  });

  it('never moves a tree that starts again before its grace runs out', () => {
    const exits = createWorkingExits();
    exits.observe(one('ready'), 500);
    exits.observe(one('working'), 1000);
    exits.observe(one('done'), 2000);
    const again = exits.observe(one('working'), 3000);
    expect(again.lingering.has(A)).toBe(false);
    expect(again.returnedAt.has(A)).toBe(false);
    // Still the run it was in: it never left.
    expect(again.workingSince.get(A)).toBe(1000);
    // And a later stop gets a whole grace of its own.
    expect(exits.observe(one('done'), 9000).nextDeadline).toBe(9000 + EXIT_GRACE_MS);
  });

  it.each(['needs-attention', 'exited', 'settled'] as const)(
    'lets a tree that went %s leave at once',
    (attention) => {
      const exits = createWorkingExits();
      exits.observe(one('working'), 1000);
      const left = exits.observe(one(attention), 2000);
      expect(left.lingering.has(A)).toBe(false);
      expect(left.returnedAt.get(A)).toBe(2000);
    },
  );

  it('lets a lingering tree that starts asking leave at once, dated by the question', () => {
    const exits = createWorkingExits();
    exits.observe(one('working'), 1000);
    exits.observe(one('done'), 2000);
    expect(exits.observe(one('needs-attention'), 2500).returnedAt.get(A)).toBe(2500);
  });

  it('dates a start it saw by the clock, and one already running when it first looked by the ledger', () => {
    const exits = createWorkingExits();
    expect(exits.observe(one('working', 400), 1000).workingSince.get(A)).toBe(400);

    const later = createWorkingExits();
    later.observe(one('ready', 400), 1000);
    expect(later.observe(one('working', 400), 5000).workingSince.get(A)).toBe(5000);
  });

  it('takes a new tree that is already running from its latest member', () => {
    const exits = createWorkingExits();
    exits.observe([], 1000);
    const tree = node(
      entry('p', 'working', { activityAt: 10 }),
      entry('c', 'working', { activityAt: 30 }),
    );
    expect(exits.observe([tree], 2000).workingSince.get(keyOf('p'))).toBe(30);
  });

  it('follows a tree by its aggregate attention', () => {
    const exits = createWorkingExits();
    const tree = (child: Attention) => [node(entry('p', 'ready'), entry('c', child))];
    exits.observe(tree('working'), 1000);
    expect(exits.observe(tree('ready'), 2000).lingering.has(keyOf('p'))).toBe(true);
  });

  it('forgets a tree that is gone, so its return does not outlive it', () => {
    const exits = createWorkingExits();
    exits.observe(one('working'), 1000);
    exits.observe(one('needs-attention'), 2000);
    exits.observe([], 3000);
    const back = exits.observe(one('needs-attention'), 4000);
    expect(back.returnedAt.has(A)).toBe(false);
  });

  it('changes nothing when it looks at the same trees twice', () => {
    const exits = createWorkingExits();
    exits.observe(one('working'), 1000);
    const first = exits.observe(one('done'), 2000);
    const second = exits.observe(one('done'), 2000);
    expect(second).toEqual(first);
  });

  it('ignores a tree that was never seen working', () => {
    const exits = createWorkingExits();
    const seen = exits.observe(one('done'), 1000);
    expect(seen.lingering.size).toBe(0);
    expect(seen.returnedAt.size).toBe(0);
    expect(seen.nextDeadline).toBeNull();
  });
});
