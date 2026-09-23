import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessCapabilitiesResult } from '../../shared/types';

const getCapabilities = vi.fn<() => Promise<HarnessCapabilitiesResult>>();

vi.mock('../services/harnessBridge', () => ({
    harnessBridge: { getCapabilities: () => getCapabilities() },
}));

const { useHarnessCapabilitiesStore } = await import('./harnessCapabilitiesStore');

const READY: HarnessCapabilitiesResult = {
    supported: true,
    commands: [],
    agents: [],
    models: [],
    outputStyles: [],
};

const CLAUDE = { driverId: 'claude' as const, extraArgs: [] };

beforeEach(() => {
    getCapabilities.mockReset();
    getCapabilities.mockResolvedValue(READY);
    useHarnessCapabilitiesStore.setState({ byHarness: {} });
});

describe('harnessCapabilitiesStore', () => {
    it('asks once for an unchanged harness', async () => {
        const { ensure } = useHarnessCapabilitiesStore.getState();

        await ensure('h1', CLAUDE);
        await ensure('h1', CLAUDE);

        expect(getCapabilities).toHaveBeenCalledTimes(1);
    });

    it('asks again once the harness launches differently', async () => {
        // The bug this guards: main caches by what a harness launches as, so
        // an edit re-probes there on its own — but only if this side actually
        // sends the request. Keying on the id alone meant a harness repointed
        // at another install kept serving the old one's commands and account
        // until the app restarted.
        const { ensure } = useHarnessCapabilitiesStore.getState();

        await ensure('h1', { ...CLAUDE, binaryOverride: '/old/claude' });
        await ensure('h1', { ...CLAUDE, binaryOverride: '/new/claude' });

        expect(getCapabilities).toHaveBeenCalledTimes(2);
    });

    it('notices a config directory change, which is a different account', async () => {
        const { ensure } = useHarnessCapabilitiesStore.getState();

        await ensure('h1', { ...CLAUDE, configDirOverride: '~/.claude' });
        await ensure('h1', { ...CLAUDE, configDirOverride: '~/.claude-work' });

        expect(getCapabilities).toHaveBeenCalledTimes(2);
    });

    it('retries after a failure rather than holding on to it', async () => {
        getCapabilities.mockResolvedValueOnce({ supported: false, reason: 'spawn ENOENT' });
        const { ensure } = useHarnessCapabilitiesStore.getState();

        await ensure('h1', CLAUDE);
        await ensure('h1', CLAUDE);

        expect(getCapabilities).toHaveBeenCalledTimes(2);
    });

    it('reports a rejected call as a reason instead of throwing', async () => {
        getCapabilities.mockRejectedValueOnce(new Error('ipc gone'));
        const { ensure } = useHarnessCapabilitiesStore.getState();

        await ensure('h1', CLAUDE);

        expect(useHarnessCapabilitiesStore.getState().get('h1').result).toEqual({
            supported: false,
            reason: 'ipc gone',
        });
    });

    it('refreshes even when the answer is already good', async () => {
        const { ensure, refresh } = useHarnessCapabilitiesStore.getState();

        await ensure('h1', CLAUDE);
        await refresh('h1', CLAUDE);

        expect(getCapabilities).toHaveBeenCalledTimes(2);
    });
});
