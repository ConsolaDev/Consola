import { describe, expect, it } from 'vitest';
import {
    appendAutomationEntry,
    parseAutomationEntry,
    parseFactorySpec,
    replaceAutomationEntry,
} from '@consola/factory-spec';
import {
    AUTOMATION_TEMPLATES,
    AutomationService,
    RunFolder,
    RunStore,
    type RunHistory,
    type WorkspaceView,
} from '@consola/automation-engine';
import { consolaTools, type ConsolaToolDeps } from '../tools/consolaTools';
import { ToolRegistry } from '../tools/Tool';

/*
 * The runner lives in `@consola/automation-engine`, which tests it against a
 * fake tool registry. These three tests run it against the desktop's real
 * `consolaTools()`: the engine's view of a tool (`ToolsPort`) is only as good
 * as the registry the desktop hands it.
 */

/** A run history that keeps nothing: these tests read the runner, not its log. */
const noHistory: RunHistory = {
    load: () => new Map(),
    append: () => {},
    appendDurably: () => {},
    rewrite: () => {},
    remove: () => {},
};

const CODEX = { name: 'Codex', problem: 'Codex sessions cannot be made read-only yet.' };

/** One automation on a schedule, the only name this workspace has taken. */
const SWEEPING = `version: 1
automations:
  - name: sweep
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions }
    mode: auto
`;

const REVIEW_BODY = 'Review the changes and summarise your findings before writing any review comments.';

/** A GitHub-bound workspace with a scope and two actions. */
function bound(): WorkspaceView {
    return {
        id: 'ws-1',
        provider: { id: 'github', accountLogin: 'me' },
        actions: [
            { name: 'Review', appliesTo: ['pr'], prompt: REVIEW_BODY },
            { name: 'Implement', appliesTo: ['issue'], prompt: 'Plan it.' },
        ],
        scopes: [{ id: 'scope-api', name: 'api', path: '/code/api' }],
        sessions: [],
    };
}

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

/** The runner over one in-memory factory.yml, with Consola's real tools. */
async function runner(
    owner: WorkspaceView,
    initial: string | null = null,
    harness: { name: string; problem: string | null } = { name: 'Claude', problem: null }
) {
    let text = initial;
    const registry = new ToolRegistry();
    for (const tool of consolaTools({} as ConsolaToolDeps)) registry.register(tool);
    let id = 0;
    const service = new AutomationService({
        fileFor: (workspaceId) => ({
            filePath: `/home/me/.consola/workspaces/${workspaceId}/factory.yml`,
            load: async () =>
                text === null ? { exists: false, spec: { automations: [], issues: [] } } : { exists: true, spec: parseFactorySpec(text) },
            watch: () => {},
            unwatch: () => {},
            ensureExists: async (template) => {
                text ??= template;
                return `/home/me/.consola/workspaces/${workspaceId}/factory.yml`;
            },
            appendAutomation: async (entryYaml) => {
                text = appendAutomationEntry(text!, entryYaml);
            },
            replaceAutomation: async (name, entryYaml) => {
                text = replaceAutomationEntry(text!, name, entryYaml);
            },
            readText: async () => text,
        }),
        store: new RunStore({ read: () => null, write: () => {} }, noHistory),
        // Nothing here runs steps: any path it is asked for throws.
        runFolder: new RunFolder(() => {
            throw new Error('These tests have no run folder.');
        }),
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
        agentHarness: () => harness,
        stopAgent: () => false,
        platform: 'darwin',
        // Nothing here runs steps: no item run asks for a checkout.
        checkout: {
            pathFor: () => '/nowhere',
            prepare: async () => {
                throw new Error('These tests prepare no automation checkout.');
            },
        },
        checkoutBusy: () => false,
        folderExists: () => true,
    });
    await service.start();
    return { service, text: () => text };
}


describe('the runner against Consola\'s real tools', () => {
    it('capabilities lists what this workspace can use', async () => {
        const t = await runner(bound(), SWEEPING);
        const capabilities = t.service.capabilities('ws-1');
        expect(capabilities.file).toEqual({ path: '/home/me/.consola/workspaces/ws-1/factory.yml', exists: true });
        expect(capabilities.taken).toEqual(['sweep']);
        expect(capabilities.scopes).toEqual([{ name: 'api', path: '/code/api' }]);
        expect(capabilities.triggers.connections).toEqual([
            expect.objectContaining({
                id: 'github',
                bound: true,
                events: [
                    expect.objectContaining({ name: 'pull_request.review_requested', itemType: 'pr' }),
                    expect.objectContaining({ name: 'pull_request.assigned', itemType: 'pr' }),
                ],
            }),
        ]);
        const cleanup = capabilities.targets.tools.find((tool) => tool.ref === 'consola#cleanup_stale_sessions');
        expect(cleanup?.arguments).toContainEqual({ name: 'pr_states', description: expect.stringMatching(/stale/) });
        // Only what an automation may name.
        expect(capabilities.targets.tools.map((tool) => tool.ref)).not.toContain('consola#delete_session');
        expect(capabilities.targets.tools.map((tool) => tool.ref)).not.toContain('consola#list_inbox');
        expect(capabilities.targets.actions).toEqual([
            { name: 'Review', appliesTo: ['pr'] },
            { name: 'Implement', appliesTo: ['issue'] },
        ]);
        expect(capabilities.harness).toEqual({ name: 'Claude', canRunAgents: true });

        // Unbound, on a harness that cannot run agent entries.
        const other = await runner({ ...bound(), provider: undefined } as WorkspaceView, SWEEPING, CODEX);
        const theirs = other.service.capabilities('ws-1');
        expect(theirs.triggers.connections[0].bound).toBe(false);
        expect(theirs.harness).toEqual({
            name: 'Codex',
            canRunAgents: false,
            problem: 'Codex can’t run read-only automation sessions: Codex sessions cannot be made read-only yet',
        });
    });

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
            if (parsed.automation.run?.kind === 'prompt') {
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
