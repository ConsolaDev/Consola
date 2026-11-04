import { describe, expect, it } from 'vitest';
import { automationVersion } from './run';
import { parseRunTarget } from './runTarget';

const base = {
    run: parseRunTarget('consola#cleanup_stale_sessions')!,
    with: { pr_states: ['merged', 'closed'], session_ids: undefined },
    mode: 'auto' as const,
};

describe('automationVersion', () => {
    it('is stable across key order and absent values', () => {
        expect(automationVersion(base)).toBe(
            automationVersion({ ...base, with: { pr_states: ['merged', 'closed'] } })
        );
        expect(automationVersion({ ...base, with: { b: 1, a: 2 } })).toBe(
            automationVersion({ ...base, with: { a: 2, b: 1 } })
        );
        expect(automationVersion(base)).toMatch(/^[0-9a-f]{16}$/);
    });

    it('changes with what the automation does: target, arguments, workspace, mode', () => {
        const version = automationVersion(base);
        expect(automationVersion({ ...base, with: { pr_states: ['merged'] } })).not.toBe(version);
        expect(automationVersion({ ...base, workspace: 'Acme' })).not.toBe(version);
        expect(automationVersion({ ...base, mode: 'confirm' })).not.toBe(version);
        expect(automationVersion({ ...base, run: parseRunTarget('consola#other')! })).not.toBe(version);
    });
});
