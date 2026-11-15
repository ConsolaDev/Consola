import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { onTestFinished } from 'vitest';
import { appendAutomationEntry, parseFactorySpec, replaceAutomationEntry } from '@consola/factory-spec';
import { AutomationService, type AutomationNotice, type AutomationServiceDeps } from '../AutomationService';
import { itemKey } from '../inboxItems.test-helpers';
import { RunFolder } from '../node/runFolder';
import type { AgentLaunchRequest, CommandResult, CommandSpec, FactoryFileHandle, RunningCommand } from '../ports';
import { RunStore, type AutomationStateFile } from '../RunStore';
import { memoryHistory } from '../runHistory.test-helpers';
import { StartedByHandError } from '../support';
import { FakeToolRegistry, type TestTool } from '../tools.test-helpers';
import type { InboxItemView, ItemRef, ItemSnapshot, SessionView, WorkspaceView } from '../views';
import type { CheckoutRequest } from './checkout';
import { maskSecrets } from './commandIO';
import type { StepToolAnswer } from './stepTools';

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

/** The commit every fake preparation reports, unless a test sets another. */
export const CHECKOUT_HEAD = '5f3c2a1b9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a';

/** Where the fake host keeps an item's automation checkout: `/worktrees/catalog-portal-pr-51-automation`. */
export function checkoutPathFor(workItem: ItemRef): string {
    return `/worktrees/${workItem.repo.split('/')[1]}-${workItem.type}-${workItem.number}-automation`;
}

type TurnOutcome = { exitCode: number; lastLine?: string; stopped?: string };

/** The base environment the fake host gives every command: the login env and the bound account's token. */
export const COMMAND_ENV = { env: { PATH: '/bin', GH_TOKEN: 'gho_stub' }, secrets: ['gho_stub'] };

/** One command the engine started, held until the test ends it. */
export interface FakeCommand {
    spec: CommandSpec;
    /**
     * It wrote `outputs` to its `$CONSOLA_OUTPUT` and its logs (masked, as
     * the executor masks them), then ended as `result` says: exit 0 unless
     * told. Then whatever that set going.
     */
    end(how?: { outputs?: string; stdout?: string; stderr?: string; result?: Partial<CommandResult> }): Promise<void>;
    /** Its result rejects, as the executor's does when the shell never started. */
    neverStarted(error: unknown): Promise<void>;
    /** How many times it was asked to stop. */
    stops: number;
}

export interface StepsHarnessOptions {
    /** ws-1's factory.yml; without one, the workspace has no file. */
    yaml?: string;
    /** What `process.platform` would say on the host. Default `darwin`. */
    platform?: NodeJS.Platform;
    /** The default harness, as the agent check sees it. Default: Claude, able to run read-only. */
    harness?: { name: string; problem: string | null };
    /** Local wall-clock start. */
    now?: Date;
    /** Agent sessions automations may have working at once; `world.maxConcurrentAgents` changes it later. Default: the engine's. */
    maxConcurrentAgents?: number;
    /** Commands automations may have running at once; `world.maxConcurrentCommands` changes it later. Default: the engine's. */
    maxConcurrentCommands?: number;
    /** Tools the registry offers; none by default. */
    tools?: TestTool[];
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
    /** The cap the service reads, read at every look: undefined is the engine's default. */
    maxConcurrentAgents?: number;
    /** The command lane's cap, read the same way. */
    maxConcurrentCommands?: number;
    /** What `commandEnv` resolves with: `COMMAND_ENV` unless a test sets another. */
    commandEnv: { env: NodeJS.ProcessEnv; secrets: string[] };
    /** `commandEnv` rejects with this while it is set: a token that cannot be borrowed. */
    commandEnvThrows?: unknown;
    /** `commandEnv` waits for this while it is set, after recording the call. */
    commandEnvGate?: Promise<void>;
    /** The workspace of every `commandEnv` asked for, in order. */
    commandEnvAsked: string[];
    /** Every command started, in order. */
    commands: FakeCommand[];
    /** Called inside the fake `start`, before it returns: nothing has run yet. */
    onCommand?: (spec: CommandSpec) => void;
    /** Folders a running session works in, as `checkoutBusy` answers. */
    busyFolders: Set<string>;
    /** Working folders that are gone from disk, as `folderExists` answers. */
    goneFolders: Set<string>;
    /** The automation checkout: every `prepare` asked for, the head it reports, and how the next one ends. */
    checkouts: {
        prepared: CheckoutRequest[];
        head: string;
        /** Every `prepare` throws this while it is set. */
        fails?: unknown;
        /** Every `prepare` waits for this while it is set. */
        gate?: Promise<void>;
    };
    /** Every launch throws this while it is set, after recording the request. */
    launchThrows?: unknown;
    /** Every launch waits for this while it is set, after recording the request and before its session exists. */
    launchGate?: Promise<void>;
    /** Every resume waits for this while it is set, after recording the call. */
    resumeGate?: Promise<void>;
    /** Every resume throws this while it is set, after recording the call. */
    resumeThrows?: unknown;
    /**
     * While set, a launch that asks after a review by hand (`startedByHandSince`)
     * refuses with `StartedByHandError` when the workspace has one, as the desktop's does.
     */
    byHandRefuses?: boolean;
    /** Every reminder waits for this while it is set, after recording the call. */
    remindGate?: Promise<void>;
    /** While set, `stopAgent` records the call and finds no turn running: it returns false. */
    noTurnToStop?: boolean;
    /** Every broadcast throws this while it is set. */
    broadcastThrows?: unknown;
    /** Called inside the fake launch, once its session is on the workspace's record and before it resolves. */
    onLaunch?: (request: AgentLaunchRequest, session: SessionView) => void;
    /** A session's unattended turn ended, as the desktop reports it; then whatever that set going. Exit 0 unless told. */
    endTurn(sessionId: string, outcome?: TurnOutcome): Promise<void>;
    /** A step session's `consola_set_outputs`, through the service's step tools. */
    setOutputs(sessionId: string, values: Record<string, unknown>): StepToolAnswer;
    /** A step session's `consola_write_artifact`, through the service's step tools. */
    writeArtifact(sessionId: string, name: string, content: string): StepToolAnswer;

    launches: AgentLaunchRequest[];
    resumes: Array<{ sessionId: string; prompt: string }>;
    /** Every reminder turn asked for, in order. */
    reminders: Array<{ sessionId: string; prompt: string }>;
    /** Every reminder throws this while it is set, after recording the call. */
    remindThrows?: unknown;
    stops: Array<{ sessionId: string; reason: string }>;
    refreshes: string[];
    /** The workspace id of every snapshot broadcast, in order. */
    broadcasts: string[];
}

export interface StepsHarness {
    service: AutomationService;
    store: RunStore;
    /** The run logs the store writes: one appended line per recorded change. */
    history: ReturnType<typeof memoryHistory>;
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
    // The service now running: `relaunch` replaces it, and the world's step calls follow.
    let current: AutomationService;

    const world: StepsWorld = {
        workspace: sprocket(),
        workspaceDeleted: false,
        harness,
        inbox: new Map(),
        liveTerminals: new Set(),
        maxConcurrentAgents: options.maxConcurrentAgents,
        maxConcurrentCommands: options.maxConcurrentCommands,
        commandEnv: structuredClone(COMMAND_ENV),
        commandEnvAsked: [],
        commands: [],
        busyFolders: new Set(),
        goneFolders: new Set(),
        checkouts: { prepared: [], head: CHECKOUT_HEAD },
        async endTurn(sessionId, outcome = { exitCode: 0 }) {
            current.turnEnded(sessionId, outcome);
            await flush();
        },
        setOutputs: (sessionId, values) => current.stepIO().setOutputs(sessionId, values),
        writeArtifact: (sessionId, name, content) => current.stepIO().writeArtifact(sessionId, name, content),
        launches: [],
        resumes: [],
        reminders: [],
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

    // Like the executor: its logs exist from the start, and what it prints reaches them masked.
    const startFakeCommand = (spec: CommandSpec): RunningCommand => {
        for (const log of [spec.stdoutPath, spec.stderrPath]) {
            fs.mkdirSync(path.dirname(log), { recursive: true });
            fs.writeFileSync(log, '');
        }
        let settle!: { resolve: (result: CommandResult) => void; reject: (error: unknown) => void };
        const result = new Promise<CommandResult>((resolve, reject) => (settle = { resolve, reject }));
        const command: FakeCommand = {
            spec,
            stops: 0,
            async end({ outputs, stdout = '', stderr = '', result: ending = {} } = {}) {
                if (outputs !== undefined) fs.appendFileSync(String(spec.env.CONSOLA_OUTPUT), outputs);
                fs.appendFileSync(spec.stdoutPath, maskSecrets(stdout, spec.secrets));
                fs.appendFileSync(spec.stderrPath, maskSecrets(stderr, spec.secrets));
                settle.resolve({
                    exitCode: 0,
                    signal: null,
                    timedOut: false,
                    stopped: false,
                    stdoutBytes: Buffer.byteLength(stdout),
                    stderrBytes: Buffer.byteLength(stderr),
                    truncated: false,
                    ...ending,
                });
                await flush();
            },
            async neverStarted(error) {
                settle.reject(error);
                await flush();
            },
        };
        world.commands.push(command);
        world.onCommand?.(spec);
        return {
            pid: 4242,
            result,
            stop: () => {
                command.stops++;
            },
        };
    };

    const registry = new FakeToolRegistry();
    for (const tool of options.tools ?? []) registry.register(tool);

    const deps = (store: RunStore): AutomationServiceDeps => ({
        fileFor,
        store,
        runFolder: folder,
        workItems: {
            canParseUrls: () => false,
            parseUrl: () => null,
            keyOf: (ref) => `${ref.provider}:${ref.repo.toLowerCase()}:${ref.type}:${ref.number}`,
            urlOf: (ref) => `https://example.test/${ref.repo}/${ref.type}/${ref.number}`,
            inWorkspace: () => true,
        },
        registry,
        getWorkspaces: () => (world.workspaceDeleted ? [] : [world.workspace]),
        now: () => clock,
        newId: () => `run-${++id}`,
        notify: (notice) => notices.push(notice),
        broadcast: (workspaceId) => {
            if (world.broadcastThrows) throw world.broadcastThrows;
            world.broadcasts.push(workspaceId);
        },
        every: () => () => {},
        inboxSnapshot: (workspaceId) => world.inbox.get(workspaceId) ?? null,
        refreshInbox: async (workspaceId) => {
            world.refreshes.push(workspaceId);
        },
        // Like the desktop: the session is on the workspace's record by the time the launch resolves.
        launchAgent: async (request) => {
            world.launches.push(request);
            if (world.launchGate) await world.launchGate;
            if (world.launchThrows) throw world.launchThrows;
            const since = request.item?.startedByHandSince;
            if (world.byHandRefuses && request.item && since !== undefined) {
                const key = itemKey(request.item.workItem);
                const label = request.item.label;
                const byHand = world.workspace.sessions.find(
                    (session) => !session.automation && session.workItemKey === key && session.workItemAction === label && session.createdAt > Date.parse(since)
                );
                if (byHand) throw new StartedByHandError(byHand.name);
            }
            const { step } = request;
            const session: SessionView = {
                id: `session-${world.launches.length}`,
                workspaceId: request.workspaceId,
                name: step?.name ?? request.item?.title ?? request.run.automation,
                scopeId: step?.scopeId ?? request.scopeId ?? 'scope-catalog-portal',
                harnessId: 'claude',
                claudeSessionId: `claude-${world.launches.length}`,
                ...(step ? { cwd: step.cwd } : {}),
                createdAt: clock.getTime(),
                automation: { name: request.run.automation, runId: request.run.id, ...(step ? { step: { id: step.id, attempt: step.attempt } } : {}) },
                ...(request.item ? { workItemAction: request.item.label } : {}),
                toolPolicy: 'read-only',
            };
            world.workspace.sessions.push(session);
            world.onLaunch?.(request, session);
            return session;
        },
        resumeAgent: async (session, prompt) => {
            world.resumes.push({ sessionId: session.id, prompt });
            if (world.resumeGate) await world.resumeGate;
            if (world.resumeThrows) throw world.resumeThrows;
        },
        remindAgent: async (session, prompt) => {
            world.reminders.push({ sessionId: session.id, prompt });
            if (world.remindGate) await world.remindGate;
            if (world.remindThrows) throw world.remindThrows;
        },
        hasLiveTerminal: (session) => world.liveTerminals.has(session.id),
        agentHarness: () => world.harness,
        stopAgent: (session, reason) => {
            world.stops.push({ sessionId: session.id, reason });
            return !world.noTurnToStop;
        },
        get maxConcurrentAgents() {
            return world.maxConcurrentAgents;
        },
        get maxConcurrentCommands() {
            return world.maxConcurrentCommands;
        },
        commandEnv: async (workspaceId) => {
            world.commandEnvAsked.push(workspaceId);
            if (world.commandEnvGate) await world.commandEnvGate;
            if (world.commandEnvThrows) throw world.commandEnvThrows;
            return structuredClone(world.commandEnv);
        },
        commands: { start: startFakeCommand },
        platform,
        checkout: {
            pathFor: (_workspaceId, workItem) => checkoutPathFor(workItem),
            prepare: async (request) => {
                world.checkouts.prepared.push(request);
                if (world.checkouts.gate) await world.checkouts.gate;
                if (world.checkouts.fails) throw world.checkouts.fails;
                return { cwd: checkoutPathFor(request.workItem), scopeId: 'scope-catalog-portal', head: world.checkouts.head };
            },
        },
        checkoutBusy: (dir) => world.busyFolders.has(dir),
        folderExists: (dir) => !world.goneFolders.has(dir),
    });

    const launch = async (): Promise<StepsHarness> => {
        const store = new RunStore(stateFile, history);
        const service = new AutomationService(deps(store));
        current = service;
        await service.start();

        return {
            service,
            store,
            history,
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
