import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';
import { automationVersion, parseFactorySpec } from '@consola/factory-spec';
import type { Workspace } from '../../shared/workspace';
import { defineTool, ToolRegistry, type ToolContext } from '../tools/Tool';
import { AutomationService, type AutomationNotice } from './AutomationService';
import { RunStore, type AutomationStateFile } from './RunStore';

function memoryFile(initial: AutomationStateFile | null = null) {
    let stored = initial;
    return {
        read: () => stored,
        write: (value: AutomationStateFile) => {
            stored = JSON.parse(JSON.stringify(value));
        },
        get stored() {
            return stored;
        },
    };
}

const entry = (fields: string, cron = '0 9 * * *') => `version: 1
automations:
  - name: sweep
    on: { cron: "${cron}" }
    run: consola#sweep
${fields}`;

interface Setup {
    yaml?: string;
    /** Local wall-clock start. */
    now?: Date;
    state?: AutomationStateFile | null;
    actionable?: number;
    runFails?: boolean;
    /** Pretend a person already approved the file's `auto` entry at this version. */
    accepted?: boolean;
    workspaces?: Workspace[];
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function setup({
    yaml = entry('    mode: auto\n'),
    now = new Date(2026, 10, 4, 8, 0),
    state = null,
    actionable = 2,
    runFails = false,
    accepted = false,
    workspaces = [{ id: 'ws-1', name: 'Acme', sessions: [] } as unknown as Workspace],
}: Setup = {}) {
    let clock = now;
    const notices: AutomationNotice[] = [];
    const calls: Array<{ mode: string; context: ToolContext; args: Record<string, unknown> }> = [];
    let gate: Promise<void> | null = null;
    const registry = new ToolRegistry();
    registry.register(
        defineTool({
            name: 'sweep',
            description: '',
            input: { level: z.number().int().default(1), only: z.array(z.string()).optional() },
            mutating: true,
            automatable: true,
            preview: async (args, context) => {
                calls.push({ mode: 'preview', context, args });
                return {
                    summary: `Would sweep ${actionable}.`,
                    data: { would: actionable },
                    actionable,
                    approvalArgs: { ...args, only: ['a', 'b'] },
                };
            },
            run: async (args, context) => {
                calls.push({ mode: 'run', context, args });
                if (gate) await gate;
                if (runFails) throw new Error('disk on fire');
                return { summary: `Swept ${actionable}.`, data: { swept: actionable }, actionable };
            },
        })
    );
    registry.register(
        defineTool({
            name: 'peek',
            description: '',
            input: {},
            mutating: false,
            automatable: false,
            run: async () => ({ summary: '', data: null }),
        })
    );
    if (accepted) {
        const [automation] = parseFactorySpec(yaml).automations;
        state = {
            ...(state ?? { version: 1, lastFired: {}, runs: [] }),
            accepted: { [automation.name]: automationVersion(automation) },
        };
    }
    const store = new RunStore(memoryFile(state));
    let text = yaml;
    let id = 0;
    const service = new AutomationService({
        file: {
            filePath: '/home/me/.consola/factory.yml',
            load: async () => ({ exists: true, spec: parseFactorySpec(text) }),
            watch: () => {},
            unwatch: () => {},
            ensureExists: async () => '/home/me/.consola/factory.yml',
        },
        store,
        registry,
        getWorkspaces: () => workspaces,
        now: () => clock,
        newId: () => `run-${++id}`,
        notify: (notice) => notices.push(notice),
        broadcast: vi.fn(),
        every: () => () => {},
    });
    const t = {
        service,
        store,
        notices,
        calls,
        setClock: (date: Date) => {
            clock = date;
        },
        async edit(next: string) {
            text = next;
            await service.reload();
        },
        /** Hold every `run` until the returned release is called. */
        holdRuns() {
            const held = deferred();
            gate = held.promise;
            return () => {
                gate = null;
                held.resolve();
            };
        },
        start: () => service.start(),
    };
    return t;
}

describe('scheduling', () => {
    it('never fires a new automation for an occurrence before it existed, then fires when due', async () => {
        const t = setup({ now: new Date(2026, 10, 4, 10, 0), accepted: true });
        await t.start();
        expect(t.store.runs()).toEqual([]);
        expect(t.service.list()[0].nextRunAt).toBe(new Date(2026, 10, 5, 9, 0).toISOString());

        t.setClock(new Date(2026, 10, 5, 9, 0, 10));
        await t.service.tick();
        expect(t.store.runs()).toHaveLength(1);
        expect(t.store.runs()[0]).toMatchObject({
            status: 'completed',
            trigger: { kind: 'cron', at: new Date(2026, 10, 5, 9, 0).toISOString() },
            attribution: { automationId: 'sweep', actionName: 'consola#sweep', triggerKind: 'cron' },
        });

        // The same occurrence never fires twice.
        await t.service.tick();
        expect(t.store.runs()).toHaveLength(1);
    });

    it('catches up once on launch for occurrences missed while closed', async () => {
        const t = setup({
            accepted: true,
            now: new Date(2026, 10, 7, 12, 0),
            state: {
                version: 1,
                lastFired: { 'sweep 0 9 * * *': new Date(2026, 10, 4, 9, 0).toISOString() },
                runs: [],
            },
        });
        await t.start();
        expect(t.store.runs()).toHaveLength(1);
        expect(t.store.runs()[0].trigger).toEqual({
            kind: 'cron',
            at: new Date(2026, 10, 5, 9, 0).toISOString(),
            catchUp: true,
        });
        await t.service.tick();
        expect(t.store.runs()).toHaveLength(1);
    });

    it('restarts the schedule when the cron changes, instead of catching up', async () => {
        const t = setup({ accepted: true, now: new Date(2026, 10, 4, 10, 0) });
        await t.start();
        await t.edit(entry('    mode: auto\n', '0 8 * * *'));
        await t.service.tick();
        expect(t.store.runs()).toEqual([]);
        expect(t.service.list()[0].nextRunAt).toBe(new Date(2026, 10, 5, 8, 0).toISOString());
    });

    it('keeps an occurrence for later when a run of the same automation is still going', async () => {
        const t = setup({ accepted: true, now: new Date(2026, 10, 4, 8, 59) });
        await t.start();
        const release = t.holdRuns();
        const manual = t.service.trigger('sweep');
        await vi.waitFor(() => expect(t.calls).toHaveLength(1));

        t.setClock(new Date(2026, 10, 4, 9, 0, 5));
        await t.service.tick();
        expect(t.store.runs()).toHaveLength(1);

        release();
        await manual;
        await t.service.tick();
        expect(t.store.runs()).toHaveLength(2);
        expect(t.store.runs()[0].trigger.kind).toBe('cron');
    });
});

describe('modes', () => {
    it('auto: runs the tool with the automation’s scope and arguments, and notifies about changes', async () => {
        const t = setup({ accepted: true, yaml: entry('    mode: auto\n    with: { level: 3 }\n    workspace: acme\n') });
        await t.start();
        const run = await t.service.trigger('sweep');
        expect(run).toMatchObject({
            status: 'completed',
            summary: 'Swept 2.',
            trigger: { kind: 'manual', by: 'person' },
            result: { swept: 2 },
            attribution: { workspaceId: 'ws-1' },
        });
        expect(t.calls).toEqual([
            {
                mode: 'run',
                args: { level: 3 },
                context: {
                    caller: { kind: 'automation', automation: 'sweep' },
                    scope: { workspaceIds: ['ws-1'], excludeSessionIds: [] },
                },
            },
        ]);
        expect(t.notices).toEqual([{ title: 'sweep', body: 'Swept 2.', runId: run.id, needsApproval: false }]);
    });

    it('auto: stays quiet when nothing changed', async () => {
        const t = setup({ accepted: true, actionable: 0 });
        await t.start();
        await t.service.trigger('sweep');
        expect(t.notices).toEqual([]);
    });

    it('auto: a new or edited automation asks once, then runs on its own', async () => {
        const t = setup({ yaml: entry('    mode: auto\n') });
        await t.start();
        expect(t.service.list()[0].asksFirst).toBe(true);

        const first = await t.service.trigger('sweep');
        expect(first).toMatchObject({ status: 'needs-approval', mode: 'confirm' });
        expect(first.summary).toMatch(/Approve once/);
        await t.service.approve(first.id);
        expect(t.service.list()[0].asksFirst).toBeUndefined();

        expect(await t.service.trigger('sweep')).toMatchObject({ status: 'completed', mode: 'auto' });

        // Editing what it does — anyone can write the file — asks again.
        await t.edit(entry('    mode: auto\n    with: { level: 9 }\n'));
        expect(await t.service.trigger('sweep')).toMatchObject({ status: 'needs-approval' });
    });

    it('confirm: previews, waits, then runs exactly what was previewed', async () => {
        const t = setup({ yaml: entry('') });
        await t.start();
        const waiting = await t.service.trigger('sweep');
        expect(waiting).toMatchObject({
            status: 'needs-approval',
            mode: 'confirm',
            summary: 'Would sweep 2.',
            approval: { args: { level: 1, only: ['a', 'b'] } },
        });
        expect(t.notices[0]).toMatchObject({ needsApproval: true, title: 'sweep needs your approval' });

        const done = await t.service.approve(waiting.id);
        expect(done).toMatchObject({ status: 'completed', summary: 'Swept 2.' });
        expect(t.calls.map((call) => [call.mode, call.args])).toEqual([
            ['preview', { level: 1 }],
            ['run', { level: 1, only: ['a', 'b'] }],
        ]);
        await expect(t.service.approve(waiting.id)).rejects.toThrow(/not waiting for approval/);
    });

    it('confirm: refuses to approve a preview of a definition that changed since', async () => {
        const t = setup({ yaml: entry('') });
        await t.start();
        const waiting = await t.service.trigger('sweep');
        await t.edit(entry('    with: { level: 5 }\n'));
        await expect(t.service.approve(waiting.id)).rejects.toThrow(/changed since this preview/);
        expect(t.store.get(waiting.id)).toMatchObject({ status: 'failed' });
        expect(t.calls.map((call) => call.mode)).toEqual(['preview']);
    });

    it('confirm: finishes quietly when there is nothing to approve', async () => {
        const t = setup({ yaml: entry(''), actionable: 0 });
        await t.start();
        expect(await t.service.trigger('sweep')).toMatchObject({ status: 'completed' });
        expect(t.notices).toEqual([]);
    });

    it('confirm: dismissing changes nothing, and a newer plan supersedes an older one', async () => {
        const t = setup({ yaml: entry('    mode: confirm\n') });
        await t.start();
        const first = await t.service.trigger('sweep');
        const second = await t.service.trigger('sweep');
        expect(t.store.get(first.id)).toMatchObject({ status: 'rejected', summary: 'Superseded by a newer run.' });
        expect(t.service.dismiss(second.id)).toMatchObject({ status: 'rejected' });
        expect(t.calls.every((call) => call.mode === 'preview')).toBe(true);
    });

    it('notify: previews and reports, never runs', async () => {
        const t = setup({ yaml: entry('    mode: notify\n') });
        await t.start();
        expect(await t.service.trigger('sweep')).toMatchObject({ status: 'completed', summary: 'Would sweep 2.' });
        expect(t.calls.map((call) => call.mode)).toEqual(['preview']);
        expect(t.notices).toHaveLength(1);
    });

    it('an agent asking for an auto automation gets confirm, even an approved one', async () => {
        const t = setup({ accepted: true, yaml: entry('    mode: auto\n') });
        await t.start();
        const run = await t.service.trigger('sweep', { sessionId: 's-9' });
        expect(run).toMatchObject({
            status: 'needs-approval',
            mode: 'confirm',
            trigger: { kind: 'manual', by: 'agent', actorId: 's-9' },
            attribution: { actorId: 's-9' },
        });
        expect(t.calls.map((call) => call.mode)).toEqual(['preview']);
    });

    it('records a failing run and says so', async () => {
        const t = setup({ accepted: true, runFails: true });
        await t.start();
        expect(await t.service.trigger('sweep')).toMatchObject({ status: 'failed', error: 'disk on fire' });
        expect(t.notices[0]).toMatchObject({ title: 'sweep failed', body: 'disk on fire' });
    });
});

describe('problems', () => {
    it('reports entries that parsed but cannot run, and never schedules them', async () => {
        const yaml = `version: 1
automations:
  - name: unknown-tool
    on: { cron: "0 9 * * *" }
    run: consola#nope
  - name: read-only
    on: { cron: "0 9 * * *" }
    run: consola#peek
  - name: bad-args
    on: { cron: "0 9 * * *" }
    run: consola#sweep
    with: { level: "high" }
  - name: no-such-workspace
    on: { cron: "0 9 * * *" }
    run: consola#sweep
    workspace: Nowhere
  - name: plugin
    on: { cron: "0 9 * * *" }
    run: plugin:x#y
`;
        const t = setup({ yaml });
        await t.start();
        const problems = Object.fromEntries(t.service.list().map((view) => [view.name, view.problem]));
        expect(problems).toEqual({
            'unknown-tool': 'there is no Consola tool named "nope"',
            'read-only': 'consola#peek cannot be run by an automation',
            'bad-args': expect.stringMatching(/^with: level: Expected number/),
            'no-such-workspace': 'no workspace named "Nowhere"',
            plugin: 'unknown tool namespace "plugin:x"; only consola# tools exist today',
        });
        expect(t.service.list().every((view) => view.nextRunAt === null)).toBe(true);
        await expect(t.service.trigger('bad-args')).rejects.toThrow(/cannot run/);
        await expect(t.service.trigger('missing')).rejects.toThrow(/No automation named "missing"/);
    });

    it('refuses a workspace name two workspaces share, but accepts the id', async () => {
        const twins = [
            { id: 'ws-1', name: 'Acme', sessions: [] },
            { id: 'ws-2', name: 'acme', sessions: [] },
        ] as unknown as Workspace[];
        const t = setup({ workspaces: twins, yaml: entry('    workspace: Acme\n') });
        await t.start();
        expect(t.service.list()[0].problem).toMatch(/2 workspaces are named "Acme"; use the workspace id/);
        await t.edit(entry('    workspace: ws-2\n'));
        expect(t.service.list()[0].problem).toBeUndefined();
    });

    it('carries file issues into the snapshot and reloads on change', async () => {
        const t = setup({ yaml: 'version: 1\nautomations:\n  - name: x\n    mode: sometimes\n' });
        await t.start();
        expect(t.service.snapshot().issues.length).toBeGreaterThan(0);
        await t.edit(entry(''));
        expect(t.service.snapshot()).toMatchObject({ issues: [], automations: [{ name: 'sweep', mode: 'confirm' }] });
    });
});

describe('RunStore', () => {
    it('marks runs cut off by a quit as failed when it loads', () => {
        const file = memoryFile({ version: 1, lastFired: {}, runs: [{ id: 'r', status: 'running' } as never] });
        const store = new RunStore(file);
        store.load('2026-11-04T10:00:00.000Z');
        expect(store.get('r')).toMatchObject({ status: 'failed', error: expect.stringMatching(/Interrupted/) });
        expect(file.stored?.runs[0].status).toBe('failed');
    });

    it('starts empty, without throwing, when the file is unreadable', () => {
        const store = new RunStore({
            read: () => {
                throw new Error('corrupt');
            },
            write: () => {},
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => store.load('2026-11-04T10:00:00.000Z')).not.toThrow();
        expect(store.runs()).toEqual([]);
    });

    it('never drops a run waiting for approval to make room', () => {
        const store = new RunStore(memoryFile());
        store.load('2026-11-04T10:00:00.000Z');
        store.add({ id: 'waiting', status: 'needs-approval' } as never);
        for (let index = 0; index < 120; index++) store.add({ id: `done-${index}`, status: 'completed' } as never);
        expect(store.runs()).toHaveLength(100);
        expect(store.get('waiting')).toBeDefined();
    });
});
