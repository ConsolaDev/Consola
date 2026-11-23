import { describe, expect, it, vi } from 'vitest';
import type { SecretsRead } from './readSecrets';
import { RunSecrets } from './runSecrets';

const A: SecretsRead = {
  ok: true,
  values: { PAGER_TOKEN: 'stub-pager-secret-a' },
  masks: ['stub-pager-secret-a'],
  labels: { PAGER_TOKEN: 'the keychain (a)' },
};
const B: SecretsRead = {
  ok: true,
  values: { PAGER_TOKEN: 'stub-pager-secret-b' },
  masks: ['stub-pager-secret-b'],
  labels: { PAGER_TOKEN: 'the keychain (b)' },
};
const FAILED: SecretsRead = { ok: false, error: "Couldn't read `PAGER_TOKEN`: it is not bound" };

/** A read the test settles by hand. */
function pending() {
  let settle!: { resolve: (outcome: SecretsRead) => void; reject: (error: unknown) => void };
  const promise = new Promise<SecretsRead>((resolve, reject) => (settle = { resolve, reject }));
  return { promise, ...settle };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const heldOf = (outcome: SecretsRead) =>
  outcome.ok ? { values: outcome.values, masks: outcome.masks, labels: outcome.labels } : undefined;

describe('RunSecrets', () => {
  it('reads once at a time per run, then holds what it read and says so', async () => {
    const secrets = new RunSecrets();
    const first = pending();
    const onDone = vi.fn();
    const second = vi.fn(async () => B);
    secrets.read('r1', () => first.promise, onDone);
    expect(secrets.reading('r1')).toBe(true);
    secrets.read('r1', second, onDone);
    expect(second).not.toHaveBeenCalled();
    expect(secrets.held('r1')).toBeUndefined();
    first.resolve(A);
    await tick();
    expect(secrets.reading('r1')).toBe(false);
    expect(secrets.held('r1')).toEqual(heldOf(A));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(A);
  });

  it('holds nothing for a failed read, and says so', async () => {
    const secrets = new RunSecrets();
    const onDone = vi.fn();
    secrets.read('r1', async () => FAILED, onDone);
    await tick();
    expect(secrets.held('r1')).toBeUndefined();
    expect(secrets.reading('r1')).toBe(false);
    expect(onDone).toHaveBeenCalledWith(FAILED);
  });

  it('words a read that throws as a failure, naming no value', async () => {
    const secrets = new RunSecrets();
    const onDone = vi.fn();
    secrets.read(
      'r1',
      async () => {
        throw new Error('the port broke.');
      },
      onDone,
    );
    await tick();
    expect(secrets.held('r1')).toBeUndefined();
    expect(onDone).toHaveBeenCalledWith({
      ok: false,
      error: "Couldn't read this run's secrets: the port broke",
    });
  });

  it('discards what a dropped read brings back', async () => {
    const secrets = new RunSecrets();
    const read = pending();
    const onDone = vi.fn();
    secrets.read('r1', () => read.promise, onDone);
    secrets.drop('r1');
    expect(secrets.reading('r1')).toBe(false);
    read.resolve(A);
    await tick();
    expect(secrets.held('r1')).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('discards a late outcome once a newer read has started', async () => {
    const secrets = new RunSecrets();
    const a = pending();
    const b = pending();
    const onA = vi.fn();
    const onB = vi.fn();
    secrets.read('r1', () => a.promise, onA);
    secrets.drop('r1');
    const readB = vi.fn(() => b.promise);
    secrets.read('r1', readB, onB);
    expect(readB).toHaveBeenCalledTimes(1);
    a.resolve(A);
    await tick();
    expect(secrets.held('r1')).toBeUndefined();
    expect(onA).not.toHaveBeenCalled();
    expect(secrets.reading('r1')).toBe(true);
    b.resolve(B);
    await tick();
    expect(secrets.held('r1')).toEqual(heldOf(B));
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledWith(B);
  });

  it('leaves the newer read alone when the late one fails', async () => {
    const secrets = new RunSecrets();
    const a = pending();
    const b = pending();
    const onA = vi.fn();
    const onB = vi.fn();
    secrets.read('r1', () => a.promise, onA);
    secrets.drop('r1');
    secrets.read('r1', () => b.promise, onB);
    a.reject(new Error('late'));
    await tick();
    expect(onA).not.toHaveBeenCalled();
    expect(secrets.reading('r1')).toBe(true);
    b.resolve(B);
    await tick();
    expect(secrets.held('r1')).toEqual(heldOf(B));
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it('drops every run at once, and every read under way', async () => {
    const secrets = new RunSecrets();
    const onDone = vi.fn();
    secrets.read('r1', async () => A, onDone);
    await tick();
    const read = pending();
    secrets.read('r2', () => read.promise, onDone);
    onDone.mockClear();
    secrets.dropAll();
    expect(secrets.held('r1')).toBeUndefined();
    expect(secrets.reading('r2')).toBe(false);
    read.resolve(B);
    await tick();
    expect(secrets.held('r2')).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();
  });
});
