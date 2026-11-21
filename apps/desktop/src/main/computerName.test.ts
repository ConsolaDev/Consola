import { describe, expect, it, vi } from 'vitest';
import { createComputerNameReader } from './computerName';

type Deps = Parameters<typeof createComputerNameReader>[0];

/** A Mac named Sprocket Studio, unless `overrides` says otherwise. */
function reader(overrides: Partial<Deps> = {}) {
  const deps: Deps = {
    platform: 'darwin',
    run: vi.fn<Deps['run']>(async () => 'Sprocket Studio\n'),
    hostname: () => 'sprocket-studio.local',
    ...overrides,
  };
  return { read: createComputerNameReader(deps), run: deps.run };
}

describe('createComputerNameReader', () => {
  it("reads the Mac's own name", async () => {
    const { read, run } = reader();
    expect(await read()).toBe('Sprocket Studio');
    expect(run).toHaveBeenCalledWith('scutil', ['--get', 'ComputerName']);
  });

  it('falls back to the host name without .local when scutil fails or says nothing', async () => {
    const failing = reader({
      run: vi.fn<Deps['run']>(async () => Promise.reject(new Error('not set'))),
    });
    expect(await failing.read()).toBe('sprocket-studio');

    const silent = reader({ run: vi.fn<Deps['run']>(async () => '') });
    expect(await silent.read()).toBe('sprocket-studio');
  });

  it('uses the host name off macOS', async () => {
    const { read, run } = reader({ platform: 'linux', hostname: () => 'sprocket-build' });
    expect(await read()).toBe('sprocket-build');
    expect(run).not.toHaveBeenCalled();
  });

  it('answers null when neither has a name', async () => {
    const { read } = reader({ run: vi.fn<Deps['run']>(async () => ' \n'), hostname: () => '' });
    expect(await read()).toBeNull();
  });

  it('asks once per run', async () => {
    const { read, run } = reader();
    await read();
    await read();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
