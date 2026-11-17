import { describe, expect, it } from 'vitest';
import { NotificationPolicy, findSessionByInstanceId, sessionsToNotify } from './attention';
import type { Workspace } from '../shared/workspace';

describe('NotificationPolicy', () => {
  it('notifies once per needs-attention episode while unfocused', () => {
    const policy = new NotificationPolicy();
    expect(policy.shouldNotify('a', 'needs-attention', false)).toBe(true);
    // Still parked on the same prompt: never a repeat.
    expect(policy.shouldNotify('a', 'needs-attention', false)).toBe(false);
    // The user dealt with it; the episode ends…
    expect(policy.shouldNotify('a', 'ready', false)).toBe(false);
    // …and the next episode rings again.
    expect(policy.shouldNotify('a', 'needs-attention', false)).toBe(true);
  });

  it('stays silent while any Consola window is focused', () => {
    const policy = new NotificationPolicy();
    expect(policy.shouldNotify('a', 'needs-attention', true)).toBe(false);
  });

  it('only needs-attention rings — working, ready and exited never do', () => {
    const policy = new NotificationPolicy();
    expect(policy.shouldNotify('a', 'working', false)).toBe(false);
    expect(policy.shouldNotify('a', 'ready', false)).toBe(false);
    expect(policy.shouldNotify('a', 'exited', false)).toBe(false);
  });

  it('tracks sessions independently', () => {
    const policy = new NotificationPolicy();
    expect(policy.shouldNotify('a', 'needs-attention', false)).toBe(true);
    expect(policy.shouldNotify('b', 'needs-attention', false)).toBe(true);
  });

  it('forget() ends an episode so a recreated terminal can ring again', () => {
    const policy = new NotificationPolicy();
    policy.shouldNotify('a', 'needs-attention', false);
    policy.forget('a');
    expect(policy.shouldNotify('a', 'needs-attention', false)).toBe(true);
  });
});

describe('findSessionByInstanceId', () => {
  it('finds the workspace and session owning an instance', () => {
    const workspaces = [
      { id: 'ws-1', name: 'alpha', sessions: [{ id: 's1', name: 'one', instanceId: 'i1' }] },
      { id: 'ws-2', name: 'beta', sessions: [{ id: 's2', name: 'two', instanceId: 'i2' }] },
    ] as unknown as Workspace[];

    const found = findSessionByInstanceId(workspaces, 'i2');
    expect(found?.workspace.id).toBe('ws-2');
    expect(found?.session.id).toBe('s2');
    expect(findSessionByInstanceId(workspaces, 'missing')).toBeNull();
  });
});

describe('sessionsToNotify', () => {
  it('rings for a session a hook says needs the person, though its terminal status never said so', () => {
    const policy = new NotificationPolicy();
    // The screen showed nothing recognisable: the terminal is `ready`, attention is not.
    expect(
      sessionsToNotify({ changed: { s1: 'needs-attention' }, removed: [] }, policy, false),
    ).toEqual(['s1']);
  });

  it('rings once per episode, never while a window is focused, and again after the episode ends', () => {
    const policy = new NotificationPolicy();
    expect(
      sessionsToNotify({ changed: { s1: 'needs-attention' }, removed: [] }, policy, true),
    ).toEqual([]);
    expect(
      sessionsToNotify({ changed: { s1: 'needs-attention' }, removed: [] }, policy, false),
    ).toEqual(['s1']);
    expect(
      sessionsToNotify({ changed: { s1: 'needs-attention' }, removed: [] }, policy, false),
    ).toEqual([]);
    expect(sessionsToNotify({ changed: { s1: 'working' }, removed: [] }, policy, false)).toEqual(
      [],
    );
    expect(
      sessionsToNotify({ changed: { s1: 'needs-attention' }, removed: [] }, policy, false),
    ).toEqual(['s1']);
  });

  it('forgets a removed session, so a new one under that key rings', () => {
    const policy = new NotificationPolicy();
    sessionsToNotify({ changed: { s1: 'needs-attention' }, removed: [] }, policy, false);
    sessionsToNotify({ changed: {}, removed: ['s1'] }, policy, false);
    expect(
      sessionsToNotify({ changed: { s1: 'needs-attention' }, removed: [] }, policy, false),
    ).toEqual(['s1']);
  });
});
