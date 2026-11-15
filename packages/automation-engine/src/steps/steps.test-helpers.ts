import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { onTestFinished } from 'vitest';
import { appendAutomationEntry, parseFactorySpec, replaceAutomationEntry } from '@consola/factory-spec';
import { AutomationService, type AutomationNotice, type AutomationServiceDeps } from '../AutomationService';
import { RunFolder } from '../node/runFolder';
import type { AgentLaunchRequest, FactoryFileHandle } from '../ports';
import { RunStore, type AutomationStateFile } from '../RunStore';
import { memoryHistory } from '../runHistory.test-helpers';
import { FakeToolRegistry } from '../tools.test-helpers';
import type { InboxItemView, ItemSnapshot, SessionView, WorkspaceView } from '../views';

/*
 * The one harness every steps test runs through: a real `AutomationService`
 * over a memory `RunStore` and a disk `RunFolder` in a temp root (removed when
 * the test finishes), and a fake host whose every dependency records each call
 * in `world`. A task that adds a dependency adds its fake to `deps` below and
 * what it records to `StepsWorld`; nothing else changes, so earlier tests keep
 * working as written. `relaunch` quits the service and starts another over the
 * same state, history, run folder, files, clock and world, as reopening
 * Consola would.
 */

export const WORKSPACE_ID = 'ws-1';

/** The Review action's body: what an action step on a pull request runs. */
export const REVIEW_BODY = 'Review {{title}} and say what should change before it merges.';
export const TRIAGE_BODY = 'Triage {{title}}: say what it needs and who should look at it.';

export interface StepsHarnessOptions {
    /** ws-1's factory.yml; without one, the workspace has no file. */
    yaml?: string;
    /** What `process.platform` would say on the host. Default `darwin`. */
    platform?: NodeJS.Platform;
    /** The default harness, as the agent check sees it. Default: Claude, able to run read-only. */
    harness?: { name: string; problem: string | null };
    /** Local wall-clock start. */
    now?: Date;
}

/** What the fake host holds and recorded. A test edits the first part to move the world, then resyncs. */
export interface StepsWorld {
    /** ws-1, "Sprocket". Edit its actions, scopes or provider, then `service.syncWorkspaces()`. */
    workspace: WorkspaceView & { name: string };
    /** ws-1 was deleted: the host no longer lists it. Set it, then `service.syncWorkspaces()`. */
    workspaceDeleted: boolean;
    harness: { name: string; problem: string | null };
    /** Each workspace's latest Inbox snapshot, as `inboxSnapshot` returns it. */
    inbox: Map<string, ItemSnapshot>;
    /** Sessions a pane has a live terminal for: a person opened them. */
    liveTerminals: Set<string>;

    launches: AgentLaunchRequest[];
    resumes: Array<{ sessionId: string; prompt: string }>;
    stops: Array<{ sessionId: string; reason: string }>;
    refreshes: string[];
    /** The workspace id of every snapshot broadcast, in order. */
    broadcasts: string[];
}

export interface StepsHarness {
    service: AutomationService;
    store: RunStore;
    folder: RunFolder;
    world: StepsWorld;
    notices: AutomationNotice[];
    /** Replace ws-1's factory.yml and reload it, as the file watcher would. */
    setYaml(yaml: string): Promise<void>;
    /** A successful Inbox fetch of ws-1 holding `items`, as main hands it over, then whatever it set going. */
    poll(items: InboxItemView[]): Promise<void>;
    /** Quit, then start a new service over the same state, history, run folder, files, clock and world. */
    relaunch(): Promise<StepsHarness>;
    /** A scheduler tick, then whatever it set going. */
    tick(): Promise<void>;
    /** Let queued promise chains (launches awaited one after another) settle. */
    flush(): Promise<void>;
    now(): Date;
    advance(ms: number): void;
}

/** A state file held in memory, copied on write as a real one would be. */
function memoryStateFile() {
    let stored: AutomationStateFile | null = null;
    return {
        read: () => stored,
        write: (value: AutomationStateFile) => {
            stored = JSON.parse(JSON.stringify(value));
        },
    };
}

async function flush(): Promise<void> {
    for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
}

/** Sprocket: two scopes, GitHub bound as JaviDev, and the two actions every steps test names. */
function sprocket(): StepsWorld['workspace'] {
    return {
        id: WORKSPACE_ID,
        name: 'Sprocket',
        provider: { id: 'github', accountLogin: 'JaviDev' },
        actions: [
            { name: 'Review', appliesTo: ['pr'], prompt: REVIEW_BODY, groupId: 'g-1' },
            { name: 'Triage', appliesTo: ['issue'], prompt: TRIAGE_BODY },
        ],
        scopes: [
            { id: 'scope-catalog-portal', name: 'catalog-portal', path: '/code/catalog-portal' },
            { id: 'scope-api', name: 'api', path: '/code/api' },
        ],
        sessions: [],
    };
}

/** A started service over Sprocket. Call it inside a test: its run folder goes when the test ends. */
export async function stepsHarness(options: StepsHarnessOptions = {}): Promise<StepsHarness> {
    const { yaml, platform = 'darwin', harness = { name: 'Claude', problem: null }, now = new Date(2026, 10, 16, 8, 0) } = options;
    let clock = now;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-harness-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

    const world: StepsWorld = {
        workspace: sprocket(),
        workspaceDeleted: false,
        harness,
        inbox: new Map(),
        liveTerminals: new Set(),
        launches: [],
        resumes: [],
        stops: [],
        refreshes: [],
        broadcasts: [],
    };
    const notices: AutomationNotice[] = [];
    const texts = new Map<string, string>(yaml === undefined ? [] : [[WORKSPACE_ID, yaml]]);
    // What outlives a quit: the state file, the run logs and the run folder.
    const stateFile = memoryStateFile();
    const history = memoryHistory();
    const folder = new RunFolder((workspaceId) => path.join(root, workspaceId));
    let id = 0;

    const fileFor = (workspaceId: string): FactoryFileHandle => {
        const filePath = `/home/me/.consola/workspaces/${workspaceId}/factory.yml`;
        return {
            filePath,
            load: async () => {
                const text = texts.get(workspaceId);
                return text === undefined ? { exists: false, spec: { automations: [], issues: [] } } : { exists: true, spec: parseFactorySpec(text) };
            },
            watch: () => {},
            unwatch: () => {},
            ensureExists: async (template) => {
                if (!texts.has(workspaceId)) texts.set(workspaceId, template);
                return filePath;
            },
            appendAutomation: async (entryYaml) => {
                texts.set(workspaceId, appendAutomationEntry(texts.get(workspaceId)!, entryYaml));
            },
            replaceAutomation: async (name, entryYaml) => {
                texts.set(workspaceId, replaceAutomationEntry(texts.get(workspaceId)!, name, entryYaml));
            },
            readText: async () => texts.get(workspaceId) ?? null,
        };
    };

    const deps = (store: RunStore): AutomationServiceDeps => ({
        fileFor,
        store,
        runFolder: folder,
        registry: new FakeToolRegistry(),
        getWorkspaces: () => (world.workspaceDeleted ? [] : [world.workspace]),
        now: () => clock,
        newId: () => `run-${++id}`,
        notify: (notice) => notices.push(notice),
        broadcast: (workspaceId) => world.broadcasts.push(workspaceId),
        every: () => () => {},
        inboxSnapshot: (workspaceId) => world.inbox.get(workspaceId) ?? null,
        refreshInbox: async (workspaceId) => {
            world.refreshes.push(workspaceId);
        },
        // Like the desktop: the session is on the workspace's record by the time the launch resolves.
        launchAgent: async (request) => {
            world.launches.push(request);
            const session: SessionView = {
                id: `session-${world.launches.length}`,
                workspaceId: request.workspaceId,
                name: request.item?.title ?? request.run.automation,
                scopeId: request.scopeId ?? 'scope-catalog-portal',
                harnessId: 'claude',
                claudeSessionId: `claude-${world.launches.length}`,
                createdAt: clock.getTime(),
                automation: { name: request.run.automation, runId: request.run.id },
                toolPolicy: 'read-only',
            };
            world.workspace.sessions.push(session);
            return session;
        },
        resumeAgent: async (session, prompt) => {
            world.resumes.push({ sessionId: session.id, prompt });
        },
        hasLiveTerminal: (session) => world.liveTerminals.has(session.id),
        agentHarness: () => world.harness,
        stopAgent: (session, reason) => {
            world.stops.push({ sessionId: session.id, reason });
            return true;
        },
        platform,
    });

    const launch = async (): Promise<StepsHarness> => {
        const store = new RunStore(stateFile, history);
        const service = new AutomationService(deps(store));
        await service.start();

        return {
            service,
            store,
            folder,
            world,
            notices,
            async setYaml(next) {
                texts.set(WORKSPACE_ID, next);
                await service.reload(WORKSPACE_ID);
            },
            async poll(items) {
                const snapshot: ItemSnapshot = { workspaceId: WORKSPACE_ID, items, fetchedAt: clock.getTime() };
                world.inbox.set(WORKSPACE_ID, snapshot);
                service.observeInbox(snapshot);
                await flush();
            },
            async relaunch() {
                service.shutdown();
                return launch();
            },
            async tick() {
                await service.tick();
                await flush();
            },
            flush,
            now: () => clock,
            advance(ms) {
                clock = new Date(clock.getTime() + ms);
            },
        };
    };
    return launch();
}
