import { describe, expect, it } from 'vitest';
import {
    appendAutomationEntry,
    parseAutomationEntry,
    parseFactorySpec,
    replaceAutomationEntry,
} from '@consola/factory-spec';
import type { Workspace } from '../../shared/workspace';
import { consolaTools, type ConsolaToolDeps } from '../tools/consolaTools';
import { ToolRegistry } from '../tools/Tool';
import { AutomationService } from './AutomationService';
import { RunStore } from './RunStore';
import { memoryHistory } from './runHistory.test-helpers';
import { AUTOMATION_TEMPLATES, templateViews } from './templates';

/** A workspace with everything the templates say they need, unless told otherwise. */
function workspace(overrides: Partial<Workspace> = {}): Workspace {
    return {
        id: 'ws-1',
        name: 'Sprocket',
        defaultHarnessId: 'claude',
        provider: { id: 'github', accountLogin: 'alice', org: 'sprocket' },
        actions: [
            { id: 'a-review', name: 'Review', appliesTo: ['pr'], prompt: 'Review the changes and summarise your findings.' },
        ],
        sectionDefaults: {},
        scopes: [{ id: 'scope-portal', name: 'catalog-portal', path: '/code/catalog-portal', isGitRepo: true, createdAt: 0 }],
        groups: [],
        sessions: [],
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

/** The runner over one in-memory factory.yml, with Consola's real tools. */
async function runner(owner: Workspace, initial: string | null = null) {
    let text = initial;
    const registry = new ToolRegistry();
    for (const tool of consolaTools({} as ConsolaToolDeps)) registry.register(tool);
    let id = 0;
    const service = new AutomationService({
        fileFor: (workspaceId) => ({
            filePath: `/home/alice/.consola/workspaces/${workspaceId}/factory.yml`,
            load: async () =>
                text === null ? { exists: false, spec: { automations: [], issues: [] } } : { exists: true, spec: parseFactorySpec(text) },
            watch: () => {},
            unwatch: () => {},
            ensureExists: async (template) => {
                text ??= template;
                return `/home/alice/.consola/workspaces/${workspaceId}/factory.yml`;
            },
            appendAutomation: async (entryYaml) => {
                text = appendAutomationEntry(text!, entryYaml);
            },
            replaceAutomation: async (name, entryYaml) => {
                text = replaceAutomationEntry(text!, name, entryYaml);
            },
            readText: async () => text,
        }),
        store: new RunStore({ read: () => null, write: () => {} }, memoryHistory()),
        registry,
        getWorkspaces: () => [owner],
        now: () => new Date(2026, 10, 4, 8, 0),
        newId: () => `run-${++id}`,
        notify: () => {},
        broadcast: () => {},
        every: () => () => {},
        inboxSnapshot: () => null,
        refreshInbox: async () => {},
        launchAgent: async () => {
            throw new Error('Nothing launches in these tests.');
        },
        resumeAgent: async () => {},
        hasLiveTerminal: () => false,
        agentHarness: () => ({ name: 'Claude', problem: null }),
        stopAgent: () => false,
    });
    await service.start();
    return { service, text: () => text };
}

const view = (owner: Workspace, id: string, text = 'version: 1\nautomations: []\n') =>
    templateViews(owner, parseFactorySpec(text).automations).find((candidate) => candidate.id === id)!;

describe('templates', () => {
    it('every template runs as-is in a workspace that has what it needs', async () => {
        const owner = workspace();
        expect(AUTOMATION_TEMPLATES.map((template) => template.id)).toEqual([
            'review-assigned-prs',
            'clean-up-stale-sessions',
            'morning-inbox-digest',
            'brief-review-requests',
        ]);
        for (const template of AUTOMATION_TEMPLATES) {
            expect(template.missing(owner), template.id).toBeNull();
            const parsed = parseAutomationEntry(template.entry(owner));
            if (!parsed.ok) throw new Error(`${template.id}: ${parsed.issues[0].message}`);
            // Added under its own id, so the card can say "Added as" that name.
            expect(parsed.automation.name).toBe(template.id);
            expect(template.matches(parsed.automation), template.id).toBe(true);
            // A prompt runs read-only: Consola's own tools are all it has.
            if (parsed.automation.run.kind === 'prompt') {
                expect(parsed.automation.run.prompt).toMatch(/list_inbox|work_item_context/);
                expect(parsed.automation.run.prompt).not.toMatch(/\bgh\b|\bgit\b|\bcurl\b|\bbash\b|\bshell\b/i);
            }
        }

        const t = await runner(owner);
        for (const template of AUTOMATION_TEMPLATES) {
            await t.service.saveEntry(owner.id, template.entry(owner), { replace: false });
        }
        expect(t.service.list(owner.id).map((automation) => [automation.name, automation.problem])).toEqual(
            AUTOMATION_TEMPLATES.map((template) => [template.id, undefined])
        );
        expect(t.service.snapshot(owner.id).templates.map((template) => template.addedAs)).toEqual(
            AUTOMATION_TEMPLATES.map((template) => template.id)
        );
    });

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
            'A GitHub connection',
            'An action for pull requests',
        ]);
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

    it('addTemplate writes a template through the runner’s checks, and refuses one with something missing', async () => {
        const unbound = workspace({ provider: undefined });
        const t = await runner(unbound);
        await expect(t.service.addTemplate(unbound.id, 'review-assigned-prs')).rejects.toThrow(
            /Connect a GitHub account in Workspace settings/
        );
        await expect(t.service.addTemplate(unbound.id, 'no-such-template')).rejects.toThrow(/no-such-template/);
        expect(t.text()).toBeNull();

        await t.service.addTemplate(unbound.id, 'clean-up-stale-sessions');
        expect(t.service.list(unbound.id)).toMatchObject([
            { name: 'clean-up-stale-sessions', mode: 'confirm', schedule: '0 9 * * 1-5', target: 'consola#cleanup_stale_sessions' },
        ]);
        expect(t.service.snapshot(unbound.id).templates.find((template) => template.id === 'clean-up-stale-sessions')).toMatchObject({
            addedAs: 'clean-up-stale-sessions',
        });
        // Added twice is a taken name, not a second entry.
        await expect(t.service.addTemplate(unbound.id, 'clean-up-stale-sessions')).rejects.toThrow(/already has an automation/);
    });
});
