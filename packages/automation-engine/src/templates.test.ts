import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from '@consola/factory-spec';
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
        expect(view(workspace({ actions: [] }), 'review-assigned-prs').missing).toBe('Add an action for pull requests');
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
            { label: 'Action for pull requests', met: false, fix: { label: 'Add an action for pull requests', section: 'actions' } },
        ]);
        // Each need says whether this workspace has it, not only the first missing one.
        expect(view(workspace({ actions: [] }), 'review-assigned-prs').needs.map((need) => need.met)).toEqual([true, false]);
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
        // Filled in for this workspace: its scope, its pull request action.
        expect(views.find((template) => template.id === 'morning-inbox-digest')?.preview?.entry).toContain(
            'scope: catalog-portal',
        );
        expect(views.find((template) => template.id === 'review-assigned-prs')?.preview?.runs).toBe('Review action');
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
      run: |
        git fetch origin
        git status
`;
        const preview = previewOf(entry, new Date(2026, 10, 13, 10, 0))!;
        expect(preview.runs).toBe('Steps: review \u2192 fresh');
        expect(preview.steps).toEqual([
            { id: 'review', kind: 'agent', summary: 'Review action' },
            { id: 'fresh', kind: 'run', if: "steps.review.verdict == 'request-changes'", summary: 'git fetch origin' },
        ]);
        // A legacy entry has none.
        const legacy = AUTOMATION_TEMPLATES.find((template) => template.id === 'clean-up-stale-sessions')!.entry(workspace());
        expect(previewOf(legacy, new Date())).not.toHaveProperty('steps');
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
