import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from '@consola/factory-spec';
import { ASSIGNED_REVIEWS_NAME, assignedReviewsEntry, factoryTemplate } from './factoryTemplates';

/**
 * What an editor's "toggle comment" does to a selection that is all comments:
 * removes one level from each line. Editors differ on the space after `#` —
 * VS Code takes it, Xcode leaves it — so both are exercised.
 */
function uncommentFrom(template: string, firstLine: string, marker: RegExp): string {
    const lines = template.split('\n');
    const start = lines.findIndex((line) => line.trim() === firstLine);
    expect(start).toBeGreaterThan(0);
    return lines.map((line, index) => (index >= start ? line.replace(marker, '$1') : line)).join('\n');
}

const TOGGLES = [
    ['removing "# " (VS Code)', /^(\s*)# ?/],
    ['removing only "#" (Xcode)', /^(\s*)#/],
] as const;

describe('factoryTemplate', () => {
    it('the template with a PR action loads review-assigned-prs live, in auto, on both events', () => {
        const result = parseFactorySpec(factoryTemplate('Review'));
        expect(result.issues).toEqual([]);
        expect(result.automations).toHaveLength(1);
        expect(result.automations[0]).toMatchObject({
            name: ASSIGNED_REVIEWS_NAME,
            mode: 'auto',
            trigger: { kind: 'event', connection: 'github', events: ['pull_request.review_requested', 'pull_request.assigned'] },
            run: { kind: 'action', ref: 'Review' },
            filter: { authors_not: ['dependabot[bot]'] },
        });
        // Says what it does before it does it.
        expect(factoryTemplate('Review')).toMatch(/asks for your review or is assigned to you/);
        expect(factoryTemplate('Review')).toMatch(/asks you once/);
    });

    it('the template without one loads no automations', () => {
        const text = factoryTemplate(null);
        expect(parseFactorySpec(text)).toEqual({ automations: [], issues: [] });
        expect(text).toContain('Add an action for pull requests in Settings › Actions, then uncomment this and name it under run.');
    });

    it.each(TOGGLES)('turns its examples on when they are all uncommented by %s', (_label, marker) => {
        const without = parseFactorySpec(uncommentFrom(factoryTemplate(null), '# - name: review-assigned-prs', marker));
        expect(without.issues).toEqual([]);
        expect(without.automations.map((automation) => automation.name)).toEqual([ASSIGNED_REVIEWS_NAME, 'clean-up-stale-sessions']);
    });

    it('turns the cleanup example on beside the live entry when "# " is removed', () => {
        // Removing only "#" leaves it one column right of the live entry, and
        // no layout lines up under both editors once an entry is live.
        const live = parseFactorySpec(uncommentFrom(factoryTemplate('Review'), '# - name: clean-up-stale-sessions', TOGGLES[0][1]));
        expect(live.issues).toEqual([]);
        expect(live.automations.map((automation) => automation.name)).toEqual([ASSIGNED_REVIEWS_NAME, 'clean-up-stale-sessions']);
    });

    it('an action name that needs quoting round-trips', () => {
        for (const action of ['Review: deep', 'Review #2', '"Quoted"', 'Re-view_2']) {
            const result = parseFactorySpec(factoryTemplate(action));
            expect(result.issues).toEqual([]);
            expect(result.automations[0].run).toMatchObject({ kind: 'action', ref: action });
        }
        // A plain name stays plain.
        expect(assignedReviewsEntry('Review code')).toContain('run: { action: Review code }');
    });
});
