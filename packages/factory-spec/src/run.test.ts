import { describe, expect, it } from 'vitest';
import { parseAutomationEntry } from './entry';
import { automationVersion, stableStringify } from './run';
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

    it('keeps every hash taken before steps existed', () => {
        expect(automationVersion(tool)).toBe('9c2fbd9ab4277088');
        expect(automationVersion(review, 'Review the changes.')).toBe('95ff957e059f7860');
        const digest: Automation = {
            name: 'digest',
            trigger: { kind: 'cron', cron: '30 8 * * 1-5' },
            run: { kind: 'prompt', ref: 'prompt', prompt: 'Summarise my Inbox.' },
            scope: 'api',
            mode: 'auto',
        };
        expect(automationVersion(digest)).toBe('d86952669c9b0419');

        // And the same through the parser, so a change to how a legacy entry parses cannot hide.
        const hashOf = (yaml: string, body?: string) => {
            const parsed = parseAutomationEntry(yaml);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
            // A legacy entry carries no `steps` key at all, not even an undefined one.
            expect('steps' in parsed.automation).toBe(false);
            return automationVersion(parsed.automation, body);
        };
        expect(
            hashOf(
                [
                    '- name: review-assigned-prs',
                    '  on: { github: [pull_request.review_requested, pull_request.assigned] }',
                    '  filter: { authors_not: ["dependabot[bot]"] }',
                    '  run: { action: Review }',
                    '  mode: auto',
                ].join('\n'),
                'Review the changes.'
            )
        ).toBe('4436964dc0db9065');
        expect(
            hashOf('- name: digest\n  on: { cron: "30 8 * * 1-5" }\n  run: { prompt: "Summarise my Inbox." }\n  scope: api\n  mode: auto')
        ).toBe('d86952669c9b0419');
        expect(
            hashOf(
                '- name: clean-up\n  on: { cron: "0 9 * * *" }\n  run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed] } }\n  mode: auto'
            )
        ).toBe('9c2fbd9ab4277088');
    });

    describe('with steps', () => {
        const ENTRY = [
            '- name: review-assigned-prs',
            '  on: { github: [pull_request.review_requested] }',
            '  mode: auto',
            '  steps:',
            '    - id: fresh',
            '      run: |',
            '        echo "needed=true" >> "$CONSOLA_OUTPUT"',
            '      env: { PR: "{{item.url}}" }',
            '      outputs: { needed: boolean }',
            '      dry_run: run',
            '    - id: review',
            '      if: steps.fresh.needed',
            '      prompt: Review this pull request.',
            '      outputs:',
            '        verdict: { enum: [approve, comment] }',
            '    - id: publish',
            '      if: steps.fresh.needed',
            '      run: echo "$VERDICT"',
            '      env: { VERDICT: "{{steps.review.verdict}}" }',
        ].join('\n');
        const READER = '\n    - id: summary\n      prompt: Summarise.\n      reads: [review.notes]';
        const versionOf = (yaml: string, body?: string) => {
            const parsed = parseAutomationEntry(yaml);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
            return automationVersion(parsed.automation, body);
        };
        const edit = (from: string, to: string) => {
            expect(ENTRY).toContain(from);
            return ENTRY.replace(from, to);
        };

        it('a one-character change to a command asks again', () => {
            expect(versionOf(ENTRY)).toMatch(/^[0-9a-f]{16}$/);
            expect(versionOf(ENTRY)).toBe(versionOf(ENTRY));
            expect(versionOf(edit('echo "$VERDICT"', 'echo "$VERDICT";'))).not.toBe(versionOf(ENTRY));
            expect(versionOf(edit('echo "$VERDICT"', 'echo "$VERDICt"'))).not.toBe(versionOf(ENTRY));
        });

        it('a cron-only change to a steps entry does not', () => {
            const cron = ENTRY.replace('on: { github: [pull_request.review_requested] }', 'on: { cron: "0 9 * * *" }').replace(
                '  steps:',
                '  scope: api\n  steps:'
            );
            const later = cron.replace('0 9 * * *', '30 10 * * 1');
            expect(versionOf(cron.replace('{{item.url}}', 'x'))).toBe(versionOf(later.replace('{{item.url}}', 'x')));
        });

        // That an entry naming no action hashes no body is the service's to show ("hashes no body when no step names an action").
        it('an action body changes it for an entry whose step names that action', () => {
            const named = '- name: r\n  on: { github: [pull_request.opened] }\n  mode: auto\n  steps:\n    - id: review\n      action: Review';
            const body = (text: string) => stableStringify({ review: text });
            expect(versionOf(named, body('A'))).toBe(versionOf(named, body('A')));
            expect(versionOf(named, body('A'))).not.toBe(versionOf(named, body('B')));
        });

        it('if, outputs, artifacts, reads, env, timeout and dry_run each change it', () => {
            const base = versionOf(ENTRY);
            const changed = [
                edit('if: steps.fresh.needed\n      prompt', 'if: "!steps.fresh.needed"\n      prompt'),
                edit('verdict: { enum: [approve, comment] }', 'verdict: { enum: [approve, comment, other] }'),
                edit('outputs: { needed: boolean }', 'outputs: { needed: boolean, extra: string }'),
                edit('prompt: Review this pull request.', 'prompt: Review this pull request.\n      artifacts: [notes]'),
                edit('prompt: Review this pull request.', 'prompt: Review this pull request.\n      artifacts: [notes]') + READER,
                edit('env: { PR: "{{item.url}}" }', 'env: { PR: "{{item.title}}" }'),
                edit('dry_run: run', 'dry_run: report'),
                edit('dry_run: run', 'dry_run: run\n      timeout: 5m'),
                edit('prompt: Review this pull request.', 'prompt: Review this pull request, kindly.'),
            ];
            for (const yaml of changed) {
                const parsed = parseAutomationEntry(yaml);
                if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
                expect(versionOf(yaml)).not.toBe(base);
            }
            const withNotes = edit('prompt: Review this pull request.', 'prompt: Review this pull request.\n      artifacts: [notes]');
            expect(versionOf(withNotes + READER)).not.toBe(versionOf(withNotes + READER.replace('\n      reads: [review.notes]', '')));
            expect(new Set(changed.map((yaml) => versionOf(yaml))).size).toBe(changed.length);
        });
    });
});
