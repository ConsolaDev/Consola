import * as fs from 'fs';
import type { Harness } from '../shared/harness';
import type { HarnessLaunchFields } from '../shared/types';
import type { ActionConversation } from '../shared/workItemActions';
import {
    generateSessionInstanceId,
    generateUuid,
    type NewSessionFields,
    type Session,
    type Workspace,
} from '../shared/workspace';
import { toolPolicyProblem } from './drivers';
import { mcpConfigForSession } from './mcp/SessionMcpHost';
import type { RelaunchFields, TerminalService, TerminalServiceOptions } from './TerminalService';

/**
 * Start a session with no renderer involved.
 *
 * The Layer-1 gap, closed: fan-out and conductors need sessions that exist
 * before any pane mounts. The launcher creates the record through the same
 * single writer every window uses, then spawns the PTY headlessly through
 * TerminalManager. A pane that mounts later goes through the ordinary
 * TERMINAL_CREATE path, takes ownership, and repaints from the replay buffer.
 *
 * Order matters and mirrors the spec: record first, spawn second — and the
 * record is rolled back if the session turns out to have nowhere to run,
 * because a tab that fails on every open is worse than no tab.
 */

/** The slice of WorkspaceService this launcher needs. Structural, for tests. */
export interface SessionRecordStore {
    getAll(): Workspace[];
    createSession(workspaceId: string, fields: NewSessionFields): Session | undefined;
    updateSession(
        workspaceId: string,
        sessionId: string,
        updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
    ): void;
    deleteSession(workspaceId: string, sessionId: string): void;
    replaceConversation(workspaceId: string, sessionId: string, claudeSessionId?: string): Session;
}

/** The slice of HarnessService this launcher needs. */
export interface HarnessRecordStore {
    getAll(): Harness[];
}

/** What the launcher may do to a session's terminal that is already there. */
export type ExistingTerminal = Pick<
    TerminalService,
    'queuePrompt' | 'startFreshConversation' | 'runningUnattended' | 'hasClaudeExited' | 'restartClaude'
>;

/** The slice of TerminalManager this launcher needs. */
export interface HeadlessTerminalStarter {
    startHeadless(instanceId: string, options: TerminalServiceOptions): void;
    /** Whether a session already has a terminal, live or exited. */
    has(instanceId: string): boolean;
    /** The terminal for a session, if it has one. */
    get(instanceId: string): ExistingTerminal | undefined;
    /** Start an exited terminal again in place, keeping the instance. */
    relaunch(instanceId: string, launch: RelaunchFields): void;
}

/** How `deliverPrompt` reached the session: queued on a live terminal, woken interactively, or re-run unattended. */
export type PromptDelivery = 'queued' | 'woken' | 'rerun';

/**
 * A new session's record fields, plus how its first launch goes. The extras
 * are delivery-only: they describe one spawn, never the session, and must
 * never reach the record.
 */
export type LaunchSessionFields = NewSessionFields & {
    initialPrompt?: string;
    /** Run the first turn unattended (`TerminalServiceOptions.unattended`). */
    unattended?: boolean;
    /** Start the session as a fork of this conversation. */
    forkFrom?: string;
};

/** What one spawn of a recorded session is asked to do. */
type SpawnFields = Pick<TerminalServiceOptions, 'resume' | 'initialPrompt' | 'unattended' | 'forkFrom'>;

/**
 * How a harness record translates into launch fields.
 *
 * Absent or built-in pins nothing — the empty object resolves exactly the way
 * Consola did before harnesses existed, ambient CLAUDE_CONFIG_DIR included.
 */
export function launchFieldsFor(harness: Harness | undefined): HarnessLaunchFields {
    if (!harness || harness.isBuiltIn) return {};
    return {
        driverId: harness.driverId,
        binaryOverride: harness.binaryPath,
        configDirOverride: harness.configDir,
        extraArgs: harness.extraArgs,
    };
}

export class SessionLauncher {
    /**
     * The Consola MCP endpoint every session gets, set at wiring time
     * (ipc-handlers). Optional so unit tests and early boot need no MCP.
     */
    public mcpHost?: { register(session: Pick<Session, 'id'>): Promise<string> };

    /**
     * Runs before a read-only session is re-run, set at wiring so a worktree
     * can be brought up to date first. Its failure never stops the re-run.
     */
    public beforeRerun?: (workspace: Workspace, session: Session) => Promise<void>;

    constructor(
        private readonly workspaces: SessionRecordStore,
        private readonly harnesses: HarnessRecordStore,
        private readonly terminals: HeadlessTerminalStarter
    ) {}

    public async launchSession(workspaceId: string, fields: LaunchSessionFields): Promise<Session> {
        const workspace = this.workspaces.getAll().find((candidate) => candidate.id === workspaceId);
        if (!workspace) {
            throw new Error(`Cannot launch a session: no workspace ${workspaceId}`);
        }

        // A session that must be restricted and cannot be is refused before
        // it has a record, rather than at spawn with a tab already open.
        const harness = this.harnesses.getAll().find((candidate) => candidate.id === fields.harnessId);
        const policyProblem = toolPolicyProblem(launchFieldsFor(harness), fields.toolPolicy);
        if (policyProblem) throw new Error(policyProblem);

        // Delivery-only; none of these may reach the record.
        const { initialPrompt, unattended, forkFrom, ...sessionFields } = fields;
        const session = this.workspaces.createSession(workspaceId, sessionFields);
        if (!session) {
            throw new Error(`Workspace ${workspaceId} refused the session record`);
        }

        // A session runs in its own cwd when it has one (worktrees, fan-out
        // targets) and in its scope's folder otherwise — the home-vs-runs-in
        // split from the spec.
        const cwd = workingFolder(workspace, session);
        if (!cwd) {
            // The record exists but can never spawn. Back the creation out
            // rather than leaving a tab that fails on every open.
            this.workspaces.deleteSession(workspaceId, session.id);
            throw new Error(
                `Session "${session.name}" has no working folder: scope ${session.scopeId} not found and no cwd given`
            );
        }

        // A folder that is gone is the same failure as a folder that was never
        // named, and it has to be caught here: node-pty enters the directory
        // inside the PTY child, where the failure is silent (see
        // TerminalService.describeCwdProblem). Without this the launch looks
        // like a success, the session dies moments later with a blank pane,
        // and fan-out reports a moved or deleted target as launched.
        if (!fs.existsSync(cwd)) {
            this.workspaces.deleteSession(workspaceId, session.id);
            throw new Error(
                `Session "${session.name}" has no working folder: ${cwd} does not exist`
            );
        }

        // First launch of a fresh record; later attaches resume.
        await this.spawn(workspace, session, cwd, harness, { resume: false, initialPrompt, unattended, forkFrom });

        this.workspaces.updateSession(workspaceId, session.id, { hasStarted: true });
        return { ...session, hasStarted: true };
    }

    /**
     * Resume an automation's turn that Consola quit in the middle of: the
     * recorded session, resumed, unattended, with `prompt` as its turn.
     *
     * Only a read-only session — an unattended turn skips the CLI's trust
     * prompt — and only one with no terminal yet: once the person opened it,
     * it is theirs, and a second process on one conversation would fork it.
     */
    public async resumeUnattended(workspaceId: string, sessionId: string, prompt: string): Promise<void> {
        const workspace = this.workspaces.getAll().find((candidate) => candidate.id === workspaceId);
        const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
        if (!workspace || !session) throw new Error('Its session was closed.');
        if (session.toolPolicy !== 'read-only') throw new Error('Consola resumes a turn unattended only in a read-only session.');
        const opened = () => {
            if (this.terminals.has(session.instanceId)) throw new Error('You opened its session before Consola could resume it.');
        };
        opened();
        const cwd = workingFolder(workspace, session);
        if (!cwd || !fs.existsSync(cwd)) throw new Error(`Its working folder is gone: ${cwd ?? session.scopeId}.`);
        // Checked again after the await inside: a pane may have mounted meanwhile.
        await this.spawnRecorded(workspace, session, cwd, { resume: true, initialPrompt: prompt, unattended: true }, opened);
    }

    /**
     * Run `prompt` in a session that already exists, keeping it the same
     * session: one tab per job, however many passes the job takes.
     *
     * 'continue' types the prompt into the current conversation through the
     * guarded queue every prompt uses — it waits for Claude to go quiet and
     * never answers a menu. 'fresh' moves the session onto a new, empty
     * conversation first, so the pass starts with a clean context; harness,
     * model, tool policy, checkout and linked item all stay, because they
     * are the record's and only the conversation id changes.
     *
     * A session with no terminal yet spawns one headless, as opening it
     * would, so an action started from the Inbox runs whether or not its
     * pane is ever shown. An unattended turn is never interrupted or typed
     * into: its automation run is waiting on that process.
     */
    public async runInSession(
        workspaceId: string,
        sessionId: string,
        prompt: string,
        conversation: ActionConversation
    ): Promise<void> {
        const workspace = this.workspaces.getAll().find((candidate) => candidate.id === workspaceId);
        const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
        if (!workspace || !session) throw new Error('That session no longer exists.');
        const cwd = workingFolder(workspace, session);
        if (!cwd || !fs.existsSync(cwd)) throw new Error(`Its working folder is gone: ${cwd ?? session.scopeId}.`);

        const live = this.terminals.get(session.instanceId);
        if (live?.runningUnattended()) {
            throw new Error('An automation is still running its turn in this session. Wait for it to finish.');
        }

        if (conversation === 'continue') {
            if (live) {
                // An exited CLI resumes, and the queue holds the prompt until
                // its composer is back.
                if (live.hasClaudeExited()) live.restartClaude(cwd);
                live.queuePrompt(prompt);
                return;
            }
            await this.spawnRecorded(workspace, session, cwd, { resume: session.hasStarted, initialPrompt: prompt });
            if (!session.hasStarted) this.workspaces.updateSession(workspaceId, session.id, { hasStarted: true });
            return;
        }

        if (live) {
            // The terminal first: it is what can refuse (a launch already
            // under way), and a refusal must leave the record naming the
            // conversation that is actually running.
            const claudeSessionId = generateUuid();
            live.startFreshConversation(claudeSessionId, prompt);
            this.workspaces.replaceConversation(workspaceId, session.id, claudeSessionId);
            return;
        }
        const replaced = this.workspaces.replaceConversation(workspaceId, session.id);
        await this.spawnRecorded(workspace, replaced, cwd, { resume: false, initialPrompt: prompt });
    }

    /**
     * Deliver `prompt` to a session whatever state it is in: queued on a live
     * terminal, an exited one started again in place, or a session with no
     * terminal resumed from its own record. A read-only session is re-run
     * unattended and stays read-only; nothing here lifts a restriction.
     */
    public async deliverPrompt(workspaceId: string, sessionId: string, prompt: string): Promise<PromptDelivery> {
        const workspace = this.workspaces.getAll().find((candidate) => candidate.id === workspaceId);
        const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
        if (!workspace || !session) throw new Error(`No session ${sessionId} in workspace ${workspaceId}.`);

        const terminal = this.terminals.get(session.instanceId);
        if (terminal?.runningUnattended()) {
            throw new Error(`"${session.name}" is in the middle of an unattended run; wait for it to finish.`);
        }
        // queuePrompt waits for an empty composer, so this never types into a menu.
        if (terminal && !terminal.hasClaudeExited()) {
            terminal.queuePrompt(prompt);
            return 'queued';
        }

        const cwd = workingFolder(workspace, session);
        if (!cwd || !fs.existsSync(cwd)) throw new Error(`Its working folder is gone: ${cwd ?? session.scopeId}.`);
        const harness = this.harnesses.getAll().find((candidate) => candidate.id === session.harnessId);
        const policyProblem = toolPolicyProblem(launchFieldsFor(harness), session.toolPolicy);
        if (policyProblem) throw new Error(policyProblem);

        if (session.toolPolicy === 'read-only') {
            try {
                await this.beforeRerun?.(workspace, session);
            } catch (error) {
                console.error(`Refreshing "${session.name}" before its re-run failed.`, error);
            }
            // An exited terminal is still in the map, which resumeUnattended
            // refuses; relaunch reuses the instance a pane may be showing. A
            // terminal that appeared during the await makes startHeadless throw.
            if (terminal) this.terminals.relaunch(session.instanceId, { cwd, prompt, unattended: true });
            else await this.spawn(workspace, session, cwd, harness, { resume: true, initialPrompt: prompt, unattended: true });
            return 'rerun';
        }

        if (terminal) {
            this.terminals.relaunch(session.instanceId, { cwd, prompt, unattended: false });
        } else {
            await this.spawn(workspace, session, cwd, harness, { resume: session.hasStarted, initialPrompt: prompt });
            if (!session.hasStarted) this.workspaces.updateSession(workspaceId, sessionId, { hasStarted: true });
        }
        return 'woken';
    }

    /**
     * Continue a read-only conversation as an ordinary session of the
     * person's own: a fork of it, under a new record with no tool policy and
     * no automation. The original keeps its restriction and its provenance —
     * neither is ever lifted in place.
     *
     * The fork stays on the source's harness, because the transcript lives in
     * that harness's config directory and only a CLI reading it can fork it;
     * a driver that cannot fork refuses when the tab starts.
     */
    public async forkWithFullTools(workspaceId: string, sessionId: string): Promise<Session> {
        const source = this.workspaces
            .getAll()
            .find((candidate) => candidate.id === workspaceId)
            ?.sessions.find((candidate) => candidate.id === sessionId);
        if (!source) throw new Error(`No session ${sessionId} in workspace ${workspaceId}.`);
        if (!source.hasStarted) throw new Error('There is no conversation to continue yet.');
        return this.launchSession(workspaceId, {
            name: `${source.name} (full tools)`,
            workspaceId,
            instanceId: generateSessionInstanceId(workspaceId),
            harnessId: source.harnessId,
            model: source.model,
            scopeId: source.scopeId,
            kind: 'interactive',
            ...(source.cwd !== undefined ? { cwd: source.cwd } : {}),
            ...(source.groupId !== undefined ? { groupId: source.groupId } : {}),
            ...(source.workItem ? { workItem: source.workItem } : {}),
            ...(source.workItemAction !== undefined ? { workItemAction: source.workItemAction } : {}),
            forkFrom: source.claudeSessionId,
        });
    }

    /**
     * Start an existing record's terminal on its own harness, refusing first
     * if that harness can no longer enforce the session's tool policy — it
     * may have been edited since the session started.
     */
    private async spawnRecorded(
        workspace: Workspace,
        session: Session,
        cwd: string,
        launch: SpawnFields,
        beforeStart?: () => void
    ): Promise<void> {
        const harness = this.harnesses.getAll().find((candidate) => candidate.id === session.harnessId);
        const policyProblem = toolPolicyProblem(launchFieldsFor(harness), session.toolPolicy);
        if (policyProblem) throw new Error(policyProblem);
        await this.spawn(workspace, session, cwd, harness, launch, beforeStart);
    }

    /** Start a recorded session's terminal, resolved from the record and its workspace. */
    private async spawn(
        workspace: Workspace,
        session: Session,
        cwd: string,
        harness: Harness | undefined,
        launch: SpawnFields,
        beforeStart?: () => void
    ): Promise<void> {
        // Every session gets an endpoint and a config file pointing at it;
        // `mcpConfigForSession`, shared with TERMINAL_CREATE, decides what a
        // failure to set one up means for each kind.
        const mcpConfigPath = this.mcpHost
            ? await mcpConfigForSession(session, this.mcpHost)
            : undefined;
        beforeStart?.();

        this.terminals.startHeadless(session.instanceId, {
            cwd,
            claudeSessionId: session.claudeSessionId,
            ...launch,
            model: session.model,
            // The workspace's provider binding, resolved here the same way the
            // TERMINAL_CREATE handler resolves it: TerminalService turns the
            // login into a token at spawn time, under the driver's variable.
            providerId: workspace.provider?.id,
            providerAccountLogin: workspace.provider?.accountLogin,
            mcpConfigPath,
            toolPolicy: session.toolPolicy,
            ...launchFieldsFor(harness),
        });
    }
}

/** Where a session runs: its own cwd (worktrees, fan-out targets), else its scope's folder. */
function workingFolder(workspace: Workspace, session: Session): string | undefined {
    return session.cwd ?? workspace.scopes.find((candidate) => candidate.id === session.scopeId)?.path;
}
