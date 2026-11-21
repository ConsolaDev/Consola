import { describe, expect, it } from 'vitest';
import { singleFlight } from './singleFlight';

describe('singleFlight', () => {
  it('ignores a second call while the first is pending, then runs again', async () => {
    const run = singleFlight();
    let release: () => void = () => {};
    let started = 0;
    const start = async () => {
      started += 1;
    };
    const first = run(
      () =>
        new Promise<void>((resolve) => {
          started += 1;
          release = resolve;
        }),
    );
    expect(await run(start)).toBe(false);
    expect(started).toBe(1);
    release();
    expect(await first).toBe(true);
    expect(await run(start)).toBe(true);
    expect(started).toBe(2);
  });

  it('frees the guard when the task throws', async () => {
    const run = singleFlight();
    await expect(
      run(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(await run(async () => {})).toBe(true);
  });
});
