import { describe, expect, it } from 'vitest';
import type { HarnessUpdates } from '../../shared/harness';
import { allowedHarnessUpdates, allowedWorkspaceUpdates } from './updateFilters';

describe('allowedHarnessUpdates', () => {
  it('passes through a normal update', () => {
    const result = allowedHarnessUpdates({ name: 'Work', accentColor: '#3b82f6' });

    expect(result).toEqual({ name: 'Work', accentColor: '#3b82f6' });
  });

  it('preserves an explicit binaryPath: undefined as an own key, so a clear reaches the service', () => {
    const result = allowedHarnessUpdates({ binaryPath: undefined });

    // Not `result.binaryPath === undefined` — that also passes when the key was
    // dropped entirely, which is exactly the bug that shipped.
    expect('binaryPath' in result).toBe(true);
    expect(result.binaryPath).toBeUndefined();
  });

  it('omits binaryPath entirely when the key is absent from the input', () => {
    const result = allowedHarnessUpdates({ name: 'Work' });

    expect('binaryPath' in result).toBe(false);
  });

  it('drops every forbidden field', () => {
    // Cast through `as unknown as HarnessUpdates` to model what IPC can
    // deliver once TypeScript's `Pick<>` is gone: a stale or untrusted
    // renderer is not held to the compile-time contract.
    const payload = {
      id: 'attacker-controlled',
      driverId: 'claude',
      isBuiltIn: true,
      archived: true,
      name: 'Legit rename',
    } as unknown as HarnessUpdates;

    const result = allowedHarnessUpdates(payload);

    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('driverId');
    expect(result).not.toHaveProperty('isBuiltIn');
    expect(result).not.toHaveProperty('archived');
    expect(result.name).toBe('Legit rename');
  });

  it('drops an explicit name: undefined rather than clobbering a real name', () => {
    const result = allowedHarnessUpdates({ name: undefined });

    expect('name' in result).toBe(false);
  });
});

describe('allowedWorkspaceUpdates', () => {
  it('drops forbidden fields', () => {
    const payload = {
      id: 'attacker-controlled',
      sessions: [],
      name: 'Legit rename',
    } as unknown as Parameters<typeof allowedWorkspaceUpdates>[0];

    const result = allowedWorkspaceUpdates(payload);

    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('sessions');
    expect(result.name).toBe('Legit rename');
  });

  it('drops an explicit name: undefined rather than clobbering a real name', () => {
    const result = allowedWorkspaceUpdates({ name: undefined });

    expect('name' in result).toBe(false);
  });
});
