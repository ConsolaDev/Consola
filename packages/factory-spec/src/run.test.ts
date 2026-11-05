import { describe, expect, it } from 'vitest';
import { automationVersion } from './run';
import type { Automation } from './schema';

const tool: Automation = {
    name: 'clean-up',
    trigger: { kind: 'cron', cron: '0 9 * * *' },
    run: {
        kind: 'tool',
        ref: 'consola#cleanup_stale_sessions',
        namespace: 'consola',
        tool: 'cleanup_stale_sessions',
        with: { pr_states: ['merged', 'closed'], session_ids: undefined },
    },
    mode: 'auto',
};

const review: Automation = {
    name: 'review-requests',
    trigger: { kind: 'event', connection: 'github', events: ['pull_request.review_requested'], params: {} },
    run: { kind: 'action', ref: 'Review', name: 'Review' },
    filter: { repos: ['acme/*'] },
    mode: 'auto',
};

const withArgs = (args: Record<string, unknown>): Automation => ({
    ...tool,
    run: { ...(tool.run as Extract<Automation['run'], { kind: 'tool' }>), with: args },
});

describe('automationVersion', () => {
    it('is stable across key order and absent values', () => {
        expect(automationVersion(tool)).toBe(automationVersion(withArgs({ pr_states: ['merged', 'closed'] })));
        expect(automationVersion(withArgs({ b: 1, a: 2 }))).toBe(automationVersion(withArgs({ a: 2, b: 1 })));
        expect(automationVersion(tool)).toMatch(/^[0-9a-f]{16}$/);
    });

    it('changes with what the automation does: target, arguments, mode', () => {
        const version = automationVersion(tool);
        expect(automationVersion(withArgs({ pr_states: ['merged'] }))).not.toBe(version);
        expect(automationVersion({ ...tool, mode: 'confirm' })).not.toBe(version);
        expect(
            automationVersion({ ...tool, run: { ...(tool.run as Extract<Automation['run'], { kind: 'tool' }>), tool: 'other', ref: 'consola#other' } })
        ).not.toBe(version);
    });

    it('does not change with a cron schedule', () => {
        expect(automationVersion({ ...tool, trigger: { kind: 'cron', cron: '0 10 * * *' } })).toBe(automationVersion(tool));
    });

    it('changes with the resolved action body, the filter, the scope and the event', () => {
        const version = automationVersion(review, 'Review the changes.');
        expect(automationVersion(review, 'Review the changes.')).toBe(version);
        expect(automationVersion(review, 'Review the changes, then approve.')).not.toBe(version);
        expect(automationVersion({ ...review, filter: { repos: ['*'] } }, 'Review the changes.')).not.toBe(version);
        expect(automationVersion({ ...review, scope: 'api' }, 'Review the changes.')).not.toBe(version);
        expect(
            automationVersion(
                { ...review, trigger: { kind: 'event', connection: 'github', events: ['pull_request.opened'], params: {} } },
                'Review the changes.'
            )
        ).not.toBe(version);
    });

    it('changes when the listed events change', () => {
        const on = (events: string[]): Automation => ({ ...review, trigger: { kind: 'event', connection: 'github', events, params: {} } });
        expect(automationVersion(on(['a.b']))).toBe(automationVersion(on(['a.b'])));
        expect(automationVersion(on(['a.b']))).not.toBe(automationVersion(on(['a.b', 'c.d'])));
    });
});
