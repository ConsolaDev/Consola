import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from '@consola/factory-spec';
import { assignedReviewsEntry } from './factoryTemplates';
import { AUTOMATION_TEMPLATES, previewOf, templateViews } from './templates';
import type { WorkspaceView } from './views';

/** A workspace with everything the templates say they need, unless told otherwise. */
function workspace(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
    return {
        id: 'ws-1',
        provider: { id: 'github', accountLogin: 'alice', org: 'sprocket' },
        actions: [{ name: 'Review', appliesTo: ['pr'], prompt: 'Review the changes and summarise your findings.' }],
        scopes: [{ id: 'scope-portal', name: 'catalog-portal', path: '/code/catalog-portal' }],
        sessions: [],
        ...overrides,
    };
}

const view = (owner: WorkspaceView, id: string, text = 'version: 1\nautomations: []\n') =>
    templateViews(owner, parseFactorySpec(text).automations).find((candidate) => candidate.id === id)!;

describe('templates', () => {
    it('a workspace missing something sees what is missing', () => {
        expect(view(workspace({ provider: undefined }), 'review-assigned-prs').missing).toBe(
            'Connect a GitHub account in Workspace settings'
        );
        expect(view(workspace({ scopes: [] }), 'morning-inbox-digest').missing).toBe('Add a scope');
        expect(view(workspace(), 'review-assigned-prs')).not.toHaveProperty('missing');

        // A workspace with nothing at all: nothing throws, and each card says what it needs.
        const bare = workspace({ provider: undefined, actions: [], scopes: [] });
        const views = templateViews(bare, []);
        expect(views.map((template) => [template.id, template.missing])).toEqual([
            ['review-assigned-prs', 'Connect a GitHub account in Workspace settings'],
            ['clean-up-stale-sessions', undefined],
            ['morning-inbox-digest', 'Connect a GitHub account in Workspace settings'],
            ['brief-review-requests', 'Connect a GitHub account in Workspace settings'],
        ]);
        for (const template of views) {
            expect(template.title).toBeTruthy();
            expect(template.description).toBeTruthy();
        }
        expect(views.find((template) => template.id === 'review-assigned-prs')?.needs).toEqual([
            { label: 'GitHub connection', met: false, fix: { label: 'Connect a GitHub account', section: 'provider' } },
        ]);
        // Each need says whether this workspace has it, not only the first missing one.
        expect(view(workspace({ scopes: [] }), 'morning-inbox-digest').needs.map((need) => need.met)).toEqual([true, false]);
        expect(view(workspace(), 'clean-up-stale-sessions').needs).toEqual([]);
    });

    it('previews the entry Add would write, as the Automations tab would describe it', () => {
        const owner = workspace();
        const now = new Date(2026, 10, 13, 10, 0); // a Friday
        const views = templateViews(owner, [], now);
        for (const template of views) {
            expect(template.preview, template.id).toBeDefined();
            expect(template.category, template.id).toBeTruthy();
            expect(template.services.length, template.id).toBeGreaterThan(0);
            expect(template.preview?.entry).toBe(
                AUTOMATION_TEMPLATES.find((candidate) => candidate.id === template.id)!.entry(owner),
            );
        }
        const cleanup = views.find((template) => template.id === 'clean-up-stale-sessions')!;
        expect(cleanup.preview).toMatchObject({
            trigger: 'Weekdays at 9:00',
            schedule: '0 9 * * 1-5',
            onEvent: false,
            kind: 'tool',
            runs: 'Tool: cleanup_stale_sessions',
            target: 'consola#cleanup_stale_sessions',
            mode: 'confirm',
            // Friday 10:00: the next weekday at 9:00 is Monday.
            nextRunAt: new Date(2026, 10, 16, 9, 0).toISOString(),
        });
        const brief = views.find((template) => template.id === 'brief-review-requests')!;
        expect(brief.preview).toMatchObject({
            trigger: 'When a pull request asks for your review',
            onEvent: true,
            kind: 'agent',
            runs: 'Prompt',
            mode: 'auto',
            nextRunAt: null,
        });
        expect(brief.preview).not.toHaveProperty('schedule');
        // Filled in for this workspace: its scope.
        expect(views.find((template) => template.id === 'morning-inbox-digest')?.preview?.entry).toContain(
            'scope: catalog-portal',
        );
        expect(views.find((template) => template.id === 'review-assigned-prs')?.preview?.runs).toBe('Steps: fresh \u2192 review \u2192 publish');
    });

    it("a steps template's preview lists its steps", () => {
        const entry = `- name: review-and-fetch
  on: { github: pull_request.review_requested }
  mode: confirm
  steps:
    - id: review
      action: Review
      outputs: { verdict: string }
    - id: fresh
      if: steps.review.verdict == 'request-changes'
      dry_run: run
      run: |
        git fetch origin
        git status
`;
        const preview = previewOf(entry, new Date(2026, 10, 13, 10, 0))!;
        expect(preview.runs).toBe('Steps: review \u2192 fresh');
        expect(preview.steps).toEqual([
            { id: 'review', kind: 'agent', summary: 'Review action' },
            { id: 'fresh', kind: 'run', if: "steps.review.verdict == 'request-changes'", summary: 'git fetch origin', dryRun: true },
        ]);
        // A legacy entry has none.
        const legacy = AUTOMATION_TEMPLATES.find((template) => template.id === 'clean-up-stale-sessions')!.entry(workspace());
        expect(previewOf(legacy, new Date())).not.toHaveProperty('steps');
    });

    it('every preview has its source', () => {
        const views = templateViews(workspace(), [], new Date(2026, 10, 13, 10, 0));
        expect(views.map((template) => [template.id, template.preview?.source])).toEqual([
            ['review-assigned-prs', 'event'],
            ['clean-up-stale-sessions', 'cron'],
            ['morning-inbox-digest', 'cron'],
            ['brief-review-requests', 'event'],
        ]);
        const now = new Date(2026, 10, 13, 10, 0);
        const poll = previewOf(
            '- name: checker\n  on:\n    poll: { every: 30m, run: ./list-prs, item: { github: .url } }\n  run: { prompt: Look at it. }\n',
            now
        );
        expect(poll).toMatchObject({ source: 'poll', onEvent: true });
        const manual = previewOf('- name: on-demand\n  on: manual\n  applies_to: [pr]\n  run: { action: Review }\n', now);
        expect(manual).toMatchObject({ source: 'manual', onEvent: false });
    });

    it('an entry already in the file shows as added', () => {
        const file = `version: 1
automations:
  - name: tidy
    on: { cron: "0 7 * * *" }
    run: { tool: consola#cleanup_stale_sessions }
  - name: reviews
    on: { github: pull_request.assigned }
    run: { action: Review }
`;
        expect(view(workspace(), 'clean-up-stale-sessions', file).addedAs).toBe('tidy');
        // Something already reviewing assignments covers automatic reviews.
        expect(view(workspace(), 'review-assigned-prs', file).addedAs).toBe('reviews');
        expect(view(workspace(), 'morning-inbox-digest', file)).not.toHaveProperty('addedAs');
    });

    it('review-assigned-prs needs only GitHub', () => {
        // No pull request action: it inlines its prompt, so nothing is missing.
        const noActions = view(workspace({ actions: [] }), 'review-assigned-prs');
        expect(noActions).not.toHaveProperty('missing');
        expect(noActions.needs).toEqual([
            { label: 'GitHub connection', met: true, fix: { label: 'Connect a GitHub account', section: 'provider' } },
        ]);
        expect(view(workspace({ provider: undefined, actions: [] }), 'review-assigned-prs').missing).toBe(
            'Connect a GitHub account in Workspace settings'
        );
        // The same entry whatever the workspace has.
        const template = AUTOMATION_TEMPLATES.find((candidate) => candidate.id === 'review-assigned-prs')!;
        expect(template.entry(workspace({ actions: [] }))).toBe(assignedReviewsEntry());
        expect(template.entry(workspace())).toBe(assignedReviewsEntry());
        expect(noActions.preview).toMatchObject({ kind: 'agent', runs: 'Steps: fresh \u2192 review \u2192 publish', mode: 'auto' });
        expect(noActions.preview?.steps?.map((step) => step.id)).toEqual(['fresh', 'review', 'publish']);
        // The card says it posts as you, and never approves.
        expect(noActions.description).toMatch(/posts the review on GitHub as you/);
        expect(noActions.description).toMatch(/as a comment or a request for changes, never an approval/);
    });

    it('a file with the one-step entry shows it as added', () => {
        // What "Open file" and the banner wrote before review-assigned-prs had steps: it keeps running as it is.
        const oneStep = `version: 1
automations:
  - name: review-assigned-prs
    on: { github: [pull_request.review_requested, pull_request.assigned] }
    filter: { authors_not: ["dependabot[bot]"] }
    run: { action: Review }
    mode: auto
`;
        expect(parseFactorySpec(oneStep).issues).toEqual([]);
        expect(view(workspace(), 'review-assigned-prs', oneStep).addedAs).toBe('review-assigned-prs');
        // Under another name, by an action or by steps.
        const renamed = oneStep.replace('name: review-assigned-prs', 'name: my-reviews');
        expect(view(workspace(), 'review-assigned-prs', renamed).addedAs).toBe('my-reviews');
        const steps = `version: 1\nautomations:\n${assignedReviewsEntry().replace('name: review-assigned-prs', 'name: posted').replace(/^/gm, '  ')}\n`;
        expect(parseFactorySpec(steps).issues).toEqual([]);
        expect(view(workspace(), 'review-assigned-prs', steps).addedAs).toBe('posted');
    });

    it('a review request’s prompt and its action are different templates', () => {
        const on = '    on: { github: pull_request.review_requested }\n';
        const briefs = `version: 1\nautomations:\n  - name: pr-briefs\n${on}    run: { prompt: "Brief me with work_item_context." }\n`;
        expect(view(workspace(), 'brief-review-requests', briefs).addedAs).toBe('pr-briefs');
        expect(view(workspace(), 'review-assigned-prs', briefs)).not.toHaveProperty('addedAs');

        const reviews = `version: 1\nautomations:\n  - name: reviews\n${on}    run: { action: Review }\n`;
        expect(view(workspace(), 'review-assigned-prs', reviews).addedAs).toBe('reviews');
        expect(view(workspace(), 'brief-review-requests', reviews)).not.toHaveProperty('addedAs');
    });

});
