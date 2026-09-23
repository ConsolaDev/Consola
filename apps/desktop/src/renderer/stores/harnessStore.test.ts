import { beforeEach, expect, it, vi } from 'vitest';
import type { Harness } from '../../shared/harness';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('../services/harnessBridge', () => ({ harnessBridge: { probe } }));
import { useHarnessStore } from './harnessStore';

beforeEach(() => {
    useHarnessStore.setState({ harnesses: [], statuses: {} });
    probe.mockReset().mockResolvedValue({ available: true, resolvedBinary: 'codex' });
});

it('probes the newly saved harness before its state broadcast arrives', async () => {
    const harness: Harness = {
        id: 'codex-work', driverId: 'codex', name: 'Work', accentColor: '#22c55e',
        enabled: true, archived: false, isBuiltIn: false, extraArgs: [],
        configDir: '/codex-work', createdAt: 1, updatedAt: 1,
    };
    await useHarnessStore.getState().probeHarness(harness);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
        driverId: 'codex', configDirOverride: '/codex-work',
    }));
    expect(useHarnessStore.getState().statuses[harness.id].state).toBe('ok');
});
