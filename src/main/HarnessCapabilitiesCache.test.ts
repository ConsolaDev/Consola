import { describe, expect, it, vi } from 'vitest';
import { HarnessCapabilitiesCache } from './HarnessCapabilitiesCache';
import type { HarnessCapabilities } from '../shared/types';
import type { HarnessConfig, HarnessDriver } from './drivers';

const EMPTY: HarnessCapabilities = {
    commands: [],
    agents: [],
    models: [],
    outputStyles: [],
};

function config(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
    return { extraArgs: [], ...overrides };
}

/** A driver that only implements what the cache actually calls. */
function fakeDriver(
    probeCapabilities?: HarnessDriver['probeCapabilities']
): HarnessDriver {
    return {
        id: 'claude',
        configDirEnvVar: 'CLAUDE_CONFIG_DIR',
        resolveBinary: () => 'claude',
        buildSessionArgs: () => [],
        composeEnv: (_config, base) => base,
        probeHealth: async () => ({ available: true, resolvedBinary: 'claude' }),
        probeCapabilities,
    };
}

describe('HarnessCapabilitiesCache', () => {
    it('probes once and answers the rest from memory', async () => {
        const probe = vi.fn(async () => EMPTY);
        const cache = new HarnessCapabilitiesCache();
        const driver = fakeDriver(probe);

        await cache.get(driver, config());
        await cache.get(driver, config());

        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('coalesces callers that ask while a probe is still running', async () => {
        // The composer and a harness card can both ask on the same tick. The
        // probe starts a process and runs the user's session hooks, so a
        // second one is a real side effect, not just wasted work.
        let release: (value: HarnessCapabilities) => void = () => {};
        const probe = vi.fn(
            () => new Promise<HarnessCapabilities>((resolve) => (release = resolve))
        );
        const cache = new HarnessCapabilitiesCache();
        const driver = fakeDriver(probe);

        const both = Promise.all([cache.get(driver, config()), cache.get(driver, config())]);
        release(EMPTY);
        const [first, second] = await both;

        expect(probe).toHaveBeenCalledTimes(1);
        expect(first).toEqual(second);
    });

    it('does not remember a failure, so the next ask retries', async () => {
        // A CLI mid-upgrade or a hook that flaked must not leave the composer
        // empty for the rest of the app's life.
        const probe = vi
            .fn<NonNullable<HarnessDriver['probeCapabilities']>>()
            .mockRejectedValueOnce(new Error('spawn ENOENT'))
            .mockResolvedValueOnce(EMPTY);
        const cache = new HarnessCapabilitiesCache();
        const driver = fakeDriver(probe);

        const failed = await cache.get(driver, config());
        const retried = await cache.get(driver, config());

        expect(failed).toEqual({ supported: false, reason: 'spawn ENOENT' });
        expect(retried.supported).toBe(true);
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('reports a driver that cannot answer, without calling anything', async () => {
        const cache = new HarnessCapabilitiesCache();

        const result = await cache.get(fakeDriver(undefined), config());

        expect(result.supported).toBe(false);
    });

    it('probes separately for harnesses that launch differently', async () => {
        // Two harnesses pointed at different profiles are different accounts
        // with different plugins, so one answer must never stand for both.
        const probe = vi.fn(async () => EMPTY);
        const cache = new HarnessCapabilitiesCache();
        const driver = fakeDriver(probe);

        await cache.get(driver, config({ configDir: '/one' }));
        await cache.get(driver, config({ configDir: '/two' }));

        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('shares one probe between harnesses that launch identically', async () => {
        const probe = vi.fn(async () => EMPTY);
        const cache = new HarnessCapabilitiesCache();
        const driver = fakeDriver(probe);

        await cache.get(driver, config({ configDir: '/same', extraArgs: ['--verbose'] }));
        await cache.get(driver, config({ configDir: '/same', extraArgs: ['--verbose'] }));

        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('re-probes after a harness is edited, with no invalidation call', async () => {
        // Editing a binary or profile path changes the signature, which is
        // what makes a stale answer impossible rather than merely unlikely.
        const probe = vi.fn(async () => EMPTY);
        const cache = new HarnessCapabilitiesCache();
        const driver = fakeDriver(probe);

        await cache.get(driver, config({ binaryPath: '/old/claude' }));
        await cache.get(driver, config({ binaryPath: '/new/claude' }));

        expect(probe).toHaveBeenCalledTimes(2);
    });
});
