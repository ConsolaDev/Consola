import * as fs from 'fs';
import type { Harness } from '../shared/harness';
import type { HarnessLaunchFields } from '../shared/types';
import type { NewSessionFields, Session, Workspace } from '../shared/workspace';
import type { TerminalServiceOptions } from './TerminalService';

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
}

/** The slice of HarnessService this launcher needs. */
export interface HarnessRecordStore {
    getAll(): Harness[];
}

/** The slice of TerminalManager this launcher needs. */
export interface HeadlessTerminalStarter {
    startHeadless(instanceId: string, options: TerminalServiceOptions): void;
}

export type LaunchSessionFields = NewSessionFields & { initialPrompt?: string };

/**
 * How a harness record translates into launch fields.
 *
 * Absent or built-in pins nothing — the empty object resolves exactly the way
 * Consola did before harnesses existed, ambient CLAUDE_CONFIG_DIR included.
 */
function launchFieldsFor(harness: Harness | undefined): HarnessLaunchFields {
    if (!harness || harness.isBuiltIn) return {};
    return {
        driverId: harness.driverId,
        binaryOverride: harness.binaryPath,
        configDirOverride: harness.configDir,
        extraArgs: harness.extraArgs,
    };
}

export class SessionLauncher {
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

        // initialPrompt is delivery-only; it must never reach the record.
        const { initialPrompt, ...sessionFields } = fields;
        const session = this.workspaces.createSession(workspaceId, sessionFields);
        if (!session) {
            throw new Error(`Workspace ${workspaceId} refused the session record`);
        }

        // A session runs in its own cwd when it has one (worktrees, fan-out
        // targets) and in its scope's folder otherwise — the home-vs-runs-in
        // split from the spec.
        const scope = workspace.scopes.find((candidate) => candidate.id === session.scopeId);
        const cwd = session.cwd ?? scope?.path;
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

        const harness = this.harnesses.getAll().find((candidate) => candidate.id === session.harnessId);
        this.terminals.startHeadless(session.instanceId, {
            cwd,
            claudeSessionId: session.claudeSessionId,
            // First launch of a fresh record; later attaches resume.
            resume: false,
            initialPrompt,
            model: session.model,
            // The workspace's GitHub binding, resolved here the same way the
            // TERMINAL_CREATE handler resolves it: TerminalService turns the
            // login into a token at spawn time.
            githubAccountLogin: workspace.github?.accountLogin,
            ...launchFieldsFor(harness),
        });

        this.workspaces.updateSession(workspaceId, session.id, { hasStarted: true });
        return { ...session, hasStarted: true };
    }
}
