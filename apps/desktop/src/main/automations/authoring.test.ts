import { describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '../../shared/workspace';
import type { LaunchSessionFields } from '../SessionLauncher';
import { authoringPrompt, authoringSessionName, startAuthoring } from './authoring';

const FILE = '/home/alice/.consola/workspaces/ws-1/factory.yml';
const ENTRY = '- name: tidy\n  on: { cron: "0 9 * * 1-5" }\n  run: { tool: consola#cleanup_stale_sessions }\n  mode: confirm';

describe('authoringPrompt', () => {
    it('says what the person asked for, where the file is, and how to add to it', () => {
        const prompt = authoringPrompt({ description: 'Every weekday, summarise what asks for my review', filePath: FILE });
        expect(prompt).toContain('Every weekday, summarise what asks for my review');
        expect(prompt).toContain(FILE);
        expect(prompt).toContain('consola_automation_capabilities');
        expect(prompt).toContain('consola_save_automation');
        // The person decides what is saved.
        expect(prompt).toMatch(/confirm .*with the person before .*sav/i);
        // What a read-only run cannot do, so the agent says so rather than writing it.
        expect(prompt).toMatch(/read-only/);
        expect(prompt).toMatch(/no shell, no `?gh`?,? and no network beyond Consola’s `?list_inbox`? and `?work_item_context`?/);
        expect(prompt).toMatch(/tell the person/i);
        expect(prompt).not.toContain('```');
    });

    it('holds the starting point in a fenced yaml block', () => {
        const change = authoringPrompt({
            description: 'Run it at ten instead',
            filePath: FILE,
            basis: { kind: 'automation', name: 'tidy', entry: ENTRY },
        });
        expect(change).toContain(`\`\`\`yaml\n${ENTRY}\n\`\`\``);
        expect(change).toContain('"tidy"');
        expect(change).toMatch(/replace: true/);

        const template = authoringPrompt({
            description: '',
            filePath: FILE,
            basis: { kind: 'template', name: 'Clean up stale sessions', entry: ENTRY },
        });
        expect(template).toContain(`\`\`\`yaml\n${ENTRY}\n\`\`\``);
        expect(template).toContain('Clean up stale sessions');
    });

    it('a fence the entry cannot close', () => {
        const entry = '- name: x\n  run:\n    prompt: |\n      Put the answer in ``` fences.';
        const prompt = authoringPrompt({ description: '', filePath: FILE, basis: { kind: 'automation', name: 'x', entry } });
        expect(prompt).toContain(`\`\`\`\`yaml\n${entry}\n\`\`\`\``);
    });
});

describe('authoringSessionName', () => {
    it('names the session after the first words of the description', () => {
        expect(authoringSessionName('Every Monday summarise what my team merged last week')).toBe(
            'New automation: Every Monday summarise what my…'
        );
        expect(authoringSessionName('  Tidy   up\nnightly ')).toBe('New automation: Tidy up nightly');
        // Five long words are cut at 40 characters.
        expect(authoringSessionName('Summarise unbelievably extraordinarily comprehensive retrospectives')).toBe(
            'New automation: Summarise unbelievably extraordinarily c…'
        );
    });

    it('names what it starts from when there is no description', () => {
        expect(authoringSessionName('', { kind: 'automation', name: 'tidy' })).toBe('Change automation: tidy');
        expect(authoringSessionName('  ', { kind: 'template', name: 'Clean up stale sessions' })).toBe(
            'New automation: Clean up stale sessions'
        );
        // Changing an automation always names it.
        expect(authoringSessionName('Run it at ten', { kind: 'automation', name: 'tidy' })).toBe('Change automation: tidy');
        expect(authoringSessionName('Run it at ten', { kind: 'template', name: 'Clean up stale sessions' })).toBe(
            'New automation: Run it at ten'
        );
    });
});

describe('startAuthoring', () => {
    const owner = {
        id: 'ws-1',
        name: 'Sprocket',
        defaultHarnessId: 'work',
        scopes: [
            { id: 'scope-portal', name: 'catalog-portal', path: '/code/catalog-portal', isGitRepo: true, createdAt: 0 },
            { id: 'scope-api', name: 'api', path: '/code/api', isGitRepo: true, createdAt: 0 },
        ],
        sessions: [],
    } as unknown as Workspace;

    function deps(workspace: Workspace | undefined = owner, entry: string | null = ENTRY) {
        const launches: Array<{ workspaceId: string; fields: LaunchSessionFields }> = [];
        return {
            launches,
            getWorkspace: (id: string) => (workspace?.id === id ? workspace : undefined),
            launchSession: vi.fn(async (workspaceId: string, fields: LaunchSessionFields) => {
                launches.push({ workspaceId, fields });
                return { id: 'session-1', ...fields } as unknown as Session;
            }),
            filePath: (workspaceId: string) => `/home/alice/.consola/workspaces/${workspaceId}/factory.yml`,
            basisEntry: vi.fn(async () => entry),
        };
    }

    it('startAuthoring launches an interactive full-tools session on the workspace’s default harness in the requested scope', async () => {
        const d = deps();
        const session = await startAuthoring(d, {
            workspaceId: 'ws-1',
            description: 'Every weekday, summarise what asks for my review',
            scopeId: 'scope-api',
        });
        expect(session.id).toBe('session-1');
        expect(d.launches).toHaveLength(1);
        const [{ workspaceId, fields }] = d.launches;
        expect(workspaceId).toBe('ws-1');
        expect(fields).toMatchObject({
            name: 'New automation: Every weekday, summarise what asks…',
            nameIsUserSet: true,
            workspaceId: 'ws-1',
            harnessId: 'work',
            kind: 'interactive',
            scopeId: 'scope-api',
            instanceId: expect.stringMatching(/^workspace-ws-1-session-/),
        });
        // Full tools: nothing pinned, and the first turn is the person's to watch.
        expect(fields).not.toHaveProperty('toolPolicy');
        expect(fields).not.toHaveProperty('unattended');
        expect(fields.initialPrompt).toContain('Every weekday, summarise what asks for my review');
        expect(fields.initialPrompt).toContain(FILE);
        expect(d.basisEntry).not.toHaveBeenCalled();
    });

    it('falls back to the primary scope, and needs a description or a starting point', async () => {
        const d = deps();
        await startAuthoring(d, { workspaceId: 'ws-1', description: 'Tidy up', scopeId: 'scope-gone' });
        expect(d.launches[0].fields.scopeId).toBe('scope-portal');

        await expect(startAuthoring(d, { workspaceId: 'ws-1', description: '   ' })).rejects.toThrow(/what the automation should do/i);
        await expect(startAuthoring(d, { workspaceId: 'ws-9', description: 'Tidy up' })).rejects.toThrow(/ws-9/);
        await expect(
            startAuthoring(deps({ ...owner, scopes: [] } as Workspace), { workspaceId: 'ws-1', description: 'Tidy up' })
        ).rejects.toThrow(/Add a scope/);
        expect(d.launches).toHaveLength(1);
    });

    it('starts from an automation’s entry or a template’s', async () => {
        const d = deps();
        await startAuthoring(d, { workspaceId: 'ws-1', description: '', basis: { automation: 'tidy' } });
        expect(d.basisEntry).toHaveBeenCalledWith('ws-1', { automation: 'tidy' });
        expect(d.launches[0].fields.name).toBe('Change automation: tidy');
        expect(d.launches[0].fields.initialPrompt).toContain(`\`\`\`yaml\n${ENTRY}\n\`\`\``);

        await startAuthoring(d, { workspaceId: 'ws-1', description: '', basis: { template: 'clean-up-stale-sessions' } });
        expect(d.launches[1].fields.name).toBe('New automation: Clean up stale sessions');

        // A starting point that is not there refuses before anything is launched.
        const gone = deps(owner, null);
        await expect(startAuthoring(gone, { workspaceId: 'ws-1', description: '', basis: { automation: 'gone' } })).rejects.toThrow(
            /gone/
        );
        await expect(
            startAuthoring(gone, { workspaceId: 'ws-1', description: '', basis: { template: 'no-such-template' } })
        ).rejects.toThrow(/no-such-template/);
        expect(gone.launches).toEqual([]);
    });
});
