import { createHash } from 'crypto';
import {
    automationVersion,
    nextCronOccurrence,
    type Automation,
    type AutomationMode,
    type RunRecord,
    type RunStatus,
    type RunTrigger,
} from '@consola/factory-spec';
import type { AutomationsSnapshot, AutomationView } from '../../shared/automations';
import type { Workspace } from '../../shared/workspace';
import { describeError } from '../describeError';
import {
    agentContext,
    CONSOLA_NAMESPACE,
    type ToolContext,
    type ToolDefinition,
    type ToolRegistry,
    type ToolResult,
} from '../tools/Tool';
import type { LoadedFactoryFile } from './FactoryFile';
import type { RunStore } from './RunStore';

/**
 * The local runner for personal automations: one `factory.yml` per workspace
 * (`~/.consola/workspaces/<workspace-id>/factory.yml`), whose automations act
 * on that workspace and nothing else.
 *
 * Trigger → tool, in a mode. Cron is a main-process timer, so automations run
 * only while Consola is open; an occurrence missed while it was closed fires
 * once on the next launch (`catchUp`), never once per missed occurrence. No
 * run ever starts another run (no workflow engine).
 *
 * Nothing a person did not approve runs unasked: `confirm` is the default; an
 * agent asking for an `auto` automation gets `confirm`; and an `auto` entry
 * runs on its own only at a version a person approved once — a new or edited
 * one asks first, whoever wrote the file. Approving runs exactly what the
 * preview showed, and nothing if the definition changed since.
 *
 * It also holds what agents ask to delete. An agent never runs a destructive
 * tool directly: its call becomes a run here (`source: 'manual'`), waiting in
 * its workspace beside the automations' approvals and approved or dismissed
 * the same way.
 */

export interface AutomationNotice {
    title: string;
    body: string;
    runId: string;
    /** Whose Automations panel a click opens. */
    workspaceId: string;
    needsApproval: boolean;
}

/** One workspace's spec file. */
export interface FactoryFileHandle {
    readonly filePath: string;
    load(): Promise<LoadedFactoryFile>;
    watch(onChange: () => void): void;
    unwatch(): void;
    ensureExists(): Promise<string>;
}

export interface AutomationServiceDeps {
    /** A workspace's spec file; asked for once, when the workspace is first seen. */
    fileFor(workspaceId: string): FactoryFileHandle;
    store: RunStore;
    registry: Pick<ToolRegistry, 'get' | 'validate' | 'invoke'>;
    getWorkspaces(): Workspace[];
    now(): Date;
    newId(): string;
    notify(notice: AutomationNotice): void;
    broadcast(workspaceId: string, snapshot: AutomationsSnapshot): void;
    /** setInterval, as a seam; returns a canceller. */
    every(ms: number, run: () => void): () => void;
}

/** How often the scheduler looks at the clock. Coarse on purpose: cron is per-minute. */
export const TICK_MS = 30_000;

/** Results bigger than this are summarised away rather than kept in history. */
const MAX_RESULT_CHARS = 20_000;

/** Requests one agent session may leave waiting before it must wait for the person. */
export const MAX_WAITING_PER_SESSION = 10;

interface Resolved {
    workspaceId: string;
    automation: Automation;
    /** `automationVersion`: what approvals bind to. */
    version: string;
    tool?: ToolDefinition;
    args?: Record<string, unknown>;
    /** Set when the entry parsed but cannot run: the reason it will not. */
    problem?: string;
}

/** One workspace's file as last read, and what its entries resolved to. */
interface WorkspaceFactory {
    file: FactoryFileHandle;
    loaded: LoadedFactoryFile;
    resolved: Resolved[];
}

const NOT_LOADED: LoadedFactoryFile = { exists: false, spec: { automations: [], issues: [] } };

/** An automation's identity: its name, within its workspace. */
function automationKey(entry: Pick<Resolved, 'workspaceId' | 'automation'>): string {
    return `${entry.workspaceId} ${entry.automation.name}`;
}

/** A schedule's identity: a renamed automation or an edited cron starts afresh rather than catching up. */
function scheduleKey(entry: Resolved): string {
    return `${automationKey(entry)} ${entry.automation.trigger.cron}`;
}

export class AutomationService {
    private readonly factories = new Map<string, WorkspaceFactory>();
    private stopTicking: (() => void) | null = null;
    /** Runs in progress: by automation key, or a request's own id. One at a time per automation. */
    private readonly inFlight = new Set<string>();
    private ticking = false;
    private started = false;

    constructor(private readonly deps: AutomationServiceDeps) {}

    public async start(): Promise<void> {
        this.deps.store.load(this.iso());
        this.started = true;
        await this.syncWorkspaces();
        this.stopTicking = this.deps.every(TICK_MS, () => void this.tick());
        // Catch up on anything missed while Consola was closed.
        await this.tick();
    }

    public stop(): void {
        this.started = false;
        this.stopTicking?.();
        this.stopTicking = null;
        for (const factory of this.factories.values()) factory.file.unwatch();
        this.factories.clear();
    }

    /**
     * Follow the workspace list. A new workspace's file is read and watched; a
     * deleted one's is let go — its schedules stop, and anything waiting for
     * approval in it is dismissed, since there is nowhere left to approve it.
     * Cheap when nothing was added or removed, so it runs on every change.
     */
    public async syncWorkspaces(): Promise<void> {
        if (!this.started) return;
        const current = new Set(this.deps.getWorkspaces().map((workspace) => workspace.id));

        const removed = [...this.factories.keys()].filter((id) => !current.has(id));
        for (const workspaceId of removed) {
            this.factories.get(workspaceId)!.file.unwatch();
            this.factories.delete(workspaceId);
            for (const run of this.deps.store.runs()) {
                if (run.attribution.workspaceId === workspaceId && run.status === 'needs-approval') {
                    this.finish(run.id, 'rejected', { summary: 'Its workspace was deleted.' });
                }
            }
        }

        // Registered before anything is awaited, so a second sync arriving
        // meanwhile sees the workspace as known rather than adding it twice.
        const added = [...current].filter((id) => !this.factories.has(id));
        for (const workspaceId of added) {
            const file = this.deps.fileFor(workspaceId);
            this.factories.set(workspaceId, { file, loaded: NOT_LOADED, resolved: [] });
            file.watch(() => void this.reload(workspaceId));
        }
        // Every file is read before schedules are reconciled: reconciling
        // while one is unread would forget its fire times, and with them the
        // catch-up for whatever it missed while Consola was closed.
        await Promise.all(added.map((workspaceId) => this.load(workspaceId)));
        if (added.length > 0 || removed.length > 0) this.settleSchedules();
        for (const workspaceId of added) this.broadcast(workspaceId);
    }

    /** Re-read one workspace's file: when it changes, and after "Open file" creates it. */
    public async reload(workspaceId: string): Promise<void> {
        if (!(await this.load(workspaceId))) return;
        this.settleSchedules();
        this.broadcast(workspaceId);
    }

    /** The workspace's file, created from its commented template when missing; for "Open file". */
    public async ensureFile(workspaceId: string): Promise<string> {
        const filePath = await this.factoryOf(workspaceId).file.ensureExists();
        await this.reload(workspaceId);
        return filePath;
    }

    /** Fire everything that is due. Public so wake-from-sleep can call it. */
    public async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const now = this.deps.now();
            for (const entry of this.allResolved()) {
                // A run still in progress keeps the occurrence for a later
                // tick rather than silently consuming it.
                if (entry.problem || this.inFlight.has(automationKey(entry))) continue;
                if (!this.factories.has(entry.workspaceId)) continue; // Deleted mid-tick.
                const due = this.nextDue(entry, now);
                if (!due || due.getTime() > now.getTime()) continue;
                // Recorded before running, so a slow run or a crash can never
                // make the same occurrence fire twice.
                this.deps.store.setLastFired(scheduleKey(entry), now.toISOString());
                const catchUp = now.getTime() - due.getTime() > 2 * TICK_MS;
                await this.fire(entry, { kind: 'cron', at: due.toISOString(), ...(catchUp ? { catchUp } : {}) }).catch(
                    (error) => console.error(`Automation ${entry.automation.name} could not start.`, error)
                );
            }
        } finally {
            this.ticking = false;
        }
    }

    /** Run one of a workspace's automations now: its panel's Run now, or an agent's `run_automation`. */
    public async trigger(workspaceId: string, name: string, actor: { sessionId?: string } = {}): Promise<RunRecord> {
        const factory = this.factoryOf(workspaceId);
        const entry = factory.resolved.find((candidate) => candidate.automation.name === name);
        if (!entry) throw new Error(`No automation named "${name}" in ${factory.file.filePath}.`);
        if (entry.problem) throw new Error(`${name} cannot run: ${entry.problem}`);
        // An agent never replaces a plan a person may be reviewing, nor
        // notifies them again about it: it gets the waiting run back.
        if (actor.sessionId) {
            const pending = this.deps.store
                .runs()
                .find((run) => isRunOf(run, entry) && run.status === 'needs-approval');
            if (pending) return pending;
        }
        return this.fire(entry, {
            kind: 'manual',
            at: this.iso(),
            by: actor.sessionId ? 'agent' : 'person',
            ...(actor.sessionId ? { actorId: actor.sessionId } : {}),
        });
    }

    /**
     * An agent's destructive call, made a run that waits for a person:
     * previewed now with the agent's own authority, and run — exactly what the
     * preview showed — only when a person approves it. Asking again for the
     * same plan returns the waiting run instead of notifying twice; a plan
     * with nothing to do records nothing.
     */
    public async requestApproval(
        toolName: string,
        raw: unknown,
        sessionId: string
    ): Promise<{ preview: ToolResult; run: RunRecord | null }> {
        const tool = this.deps.registry.get(toolName);
        if (!tool) throw new Error(`No Consola tool named "${toolName}".`);
        const workspaces = this.deps.getWorkspaces();
        const context = agentContext(sessionId, workspaces);
        const preview = await this.deps.registry.invoke(tool.name, raw, context, 'preview');
        if (preview.actionable === 0) return { preview, run: null };

        const validated = this.deps.registry.validate(tool, raw);
        const args = preview.approvalArgs ?? (validated.ok ? validated.args : {});
        const ref = `${CONSOLA_NAMESPACE}#${tool.name}`;
        const version = requestVersion(ref, args);
        const waitingFromCaller = this.deps.store
            .runs()
            .filter(
                (run) => isAgentRequest(run) && run.status === 'needs-approval' && run.trigger.actorId === sessionId
            );
        const same = waitingFromCaller.find((run) => run.actionName === ref && run.actionVersion === version);
        if (same) return { preview, run: same };
        if (waitingFromCaller.length >= MAX_WAITING_PER_SESSION) {
            throw new Error(
                `${waitingFromCaller.length} requests from this session are already waiting for the person; ` +
                    'ask them to review those in Consola first.'
            );
        }

        const asker = workspaces.flatMap((workspace) => workspace.sessions).find((session) => session.id === sessionId);
        const summary = `${preview.summary} Asked by "${asker?.name ?? sessionId}".`;
        const workspaceId = context.caller.workspaceId;
        const now = this.iso();
        const run: RunRecord = {
            id: this.deps.newId(),
            runner: 'local',
            source: 'manual',
            automationId: ref,
            actionName: ref,
            actionVersion: version,
            mode: 'confirm',
            trigger: { kind: 'manual', at: now, by: 'agent', actorId: sessionId },
            status: 'needs-approval',
            summary,
            result: compact(preview.data),
            approval: { args },
            attribution: { automationId: ref, actionName: ref, triggerKind: 'manual', workspaceId, actorId: sessionId },
            createdAt: now,
            updatedAt: now,
        };
        this.deps.store.add(run);
        this.broadcast(workspaceId);
        this.deps.notify({
            title: `"${asker?.name ?? 'A session'}" needs your approval`,
            body: `${summary} Review it in Consola.`,
            runId: run.id,
            workspaceId,
            needsApproval: true,
        });
        return { preview, run };
    }

    /**
     * Approve a run waiting for a person. Runs exactly what its preview showed
     * — every safety rule checked again, nothing added — and refuses if the
     * automation changed since. Approving a new or edited `auto` entry also
     * lets it run on its own from now on.
     */
    public async approve(runId: string): Promise<RunRecord> {
        const run = this.waiting(runId);
        if (isAgentRequest(run)) return this.approveRequest(run);
        const entry = this.factories
            .get(run.attribution.workspaceId ?? '')
            ?.resolved.find((candidate) => candidate.automation.name === run.automationId);
        const problem = !entry
            ? 'it is no longer in its workspace’s factory.yml'
            : (entry.problem ??
              (entry.version !== run.actionVersion ? 'factory.yml changed since this preview; run it again' : undefined));
        if (!entry || problem) {
            this.finish(run.id, 'failed', { error: `Not run: ${problem}.` });
            throw new Error(`Not run: ${problem}.`);
        }
        const key = automationKey(entry);
        this.assertIdle(key, entry.automation.name);
        this.deps.store.update(run.id, { status: 'running', updatedAt: this.iso() });
        return this.guarded(
            key,
            run.id,
            async () => {
                const args = run.approval?.args ?? entry.args;
                const result = await this.deps.registry.invoke(entry.tool!.name, args, this.contextFor(entry), 'run');
                this.finish(run.id, 'completed', { result });
                if (entry.automation.mode === 'auto') this.deps.store.accept(key, entry.version);
            },
            entry.automation.name
        );
    }

    public dismiss(runId: string): RunRecord {
        const run = this.waiting(runId);
        this.finish(run.id, 'rejected', {});
        return this.deps.store.get(run.id)!;
    }

    /** A workspace's automations as its panel and `list_automations` show them. */
    public list(workspaceId: string): AutomationView[] {
        const now = this.deps.now();
        return (this.factories.get(workspaceId)?.resolved ?? []).map((entry) => {
            const { automation } = entry;
            const next = entry.problem ? null : this.nextDue(entry, now);
            return {
                name: automation.name,
                cron: automation.trigger.cron,
                mode: automation.mode,
                target: automation.run.ref,
                ...(automation.line ? { line: automation.line } : {}),
                // A due-but-unfired occurrence reads as "now", not as a time in the past.
                nextRunAt: next ? new Date(Math.max(next.getTime(), now.getTime())).toISOString() : null,
                ...(automation.mode === 'auto' && this.deps.store.acceptedVersion(automationKey(entry)) !== entry.version
                    ? { asksFirst: true }
                    : {}),
                ...(entry.problem ? { problem: entry.problem } : {}),
            };
        });
    }

    public snapshot(workspaceId: string): AutomationsSnapshot {
        const factory = this.factoryOf(workspaceId);
        return {
            filePath: factory.file.filePath,
            fileExists: factory.loaded.exists,
            automations: this.list(workspaceId),
            issues: factory.loaded.spec.issues,
            runs: this.deps.store.runs().filter((run) => run.attribution.workspaceId === workspaceId),
        };
    }

    /**
     * Run an agent's request as previewed, with that agent's authority as it
     * is now: once the asking session is deleted or moved, its request
     * cannot run.
     */
    private async approveRequest(run: RunRecord): Promise<RunRecord> {
        const tool = this.deps.registry.get(run.actionName);
        const context = this.authorityOf(run.trigger.actorId);
        if (!tool || !context) {
            const problem = !tool
                ? `${run.actionName} no longer exists`
                : 'the session that asked for it no longer exists';
            this.finish(run.id, 'failed', { error: `Not run: ${problem}.` });
            throw new Error(`Not run: ${problem}.`);
        }
        this.deps.store.update(run.id, { status: 'running', updatedAt: this.iso() });
        return this.guarded(
            run.id,
            run.id,
            async () => {
                const result = await this.deps.registry.invoke(tool.name, run.approval?.args ?? {}, context, 'run');
                this.finish(run.id, 'completed', { result });
            },
            run.actionName
        );
    }

    private authorityOf(sessionId: string | undefined): ToolContext | null {
        if (!sessionId) return null;
        try {
            return agentContext(sessionId, this.deps.getWorkspaces());
        } catch {
            return null; // The session is gone, and its authority with it.
        }
    }

    /** Read and resolve one workspace's file. False when the workspace went away meanwhile. */
    private async load(workspaceId: string): Promise<boolean> {
        const factory = this.factories.get(workspaceId);
        if (!factory) return false;
        const loaded = await factory.file.load();
        if (this.factories.get(workspaceId) !== factory) return false;
        factory.loaded = loaded;
        factory.resolved = loaded.spec.automations.map((automation) => this.resolve(workspaceId, automation));
        return true;
    }

    /**
     * Forget schedules no file names any more, and start each new one now: it
     * never fires for an occurrence that passed before it existed.
     */
    private settleSchedules(): void {
        const keys = new Set(this.allResolved().map(scheduleKey));
        this.deps.store.keepSchedules(keys);
        for (const key of keys) {
            if (!this.deps.store.lastFired(key)) this.deps.store.setLastFired(key, this.iso());
        }
    }

    private allResolved(): Resolved[] {
        return [...this.factories.values()].flatMap((factory) => factory.resolved);
    }

    private factoryOf(workspaceId: string): WorkspaceFactory {
        const factory = this.factories.get(workspaceId);
        if (!factory) throw new Error(`No workspace ${workspaceId}.`);
        return factory;
    }

    private resolve(workspaceId: string, automation: Automation): Resolved {
        const version = automationVersion(automation);
        const { run } = automation;
        const unable = (problem: string): Resolved => ({ workspaceId, automation, version, problem });
        if (run.kind !== 'tool') return unable('actions cannot be run by automations yet');
        if (run.namespace !== CONSOLA_NAMESPACE) {
            return unable(`unknown tool namespace "${run.namespace}"; only consola# tools exist today`);
        }
        const tool = this.deps.registry.get(run.tool);
        if (!tool) return unable(`there is no Consola tool named "${run.tool}"`);
        if (!tool.automatable) return unable(`${run.ref} cannot be run by an automation`);
        const validated = this.deps.registry.validate(tool, automation.with);
        if (!validated.ok) return unable(`with: ${validated.error}`);
        return { workspaceId, automation, version, tool, args: validated.args };
    }

    /** An automation acts on its own workspace, as itself. */
    private contextFor(entry: Resolved): ToolContext {
        return {
            caller: { kind: 'automation', automation: entry.automation.name },
            scope: { workspaceIds: [entry.workspaceId], excludeSessionIds: [] },
        };
    }

    private nextDue(entry: Resolved, now: Date): Date | null {
        const last = this.deps.store.lastFired(scheduleKey(entry));
        return nextCronOccurrence(entry.automation.trigger.cron, last ? new Date(last) : now);
    }

    /** The mode this run uses, and why it asks when the file says `auto`. */
    private effectiveMode(entry: Resolved, trigger: RunTrigger): { mode: AutomationMode; asks?: string } {
        const { mode } = entry.automation;
        if (mode !== 'auto') return { mode };
        if (trigger.by === 'agent') return { mode: 'confirm', asks: 'An agent asked for this run.' };
        if (this.deps.store.acceptedVersion(automationKey(entry)) !== entry.version) {
            return { mode: 'confirm', asks: 'Approve once to let this new or changed automation run on its own.' };
        }
        return { mode };
    }

    private async fire(entry: Resolved, trigger: RunTrigger): Promise<RunRecord> {
        const { automation } = entry;
        const key = automationKey(entry);
        this.assertIdle(key, automation.name);
        const { mode, asks } = this.effectiveMode(entry, trigger);
        const run = this.newRun(entry, trigger, mode);
        this.deps.store.add(run);
        return this.guarded(
            key,
            run.id,
            async () => {
                const toolName = entry.tool!.name;
                const context = this.contextFor(entry);
                if (mode === 'auto') {
                    const result = await this.deps.registry.invoke(toolName, entry.args, context, 'run');
                    this.finish(run.id, 'completed', { result });
                    if ((result.actionable ?? 1) > 0) this.notify(automation.name, result.summary, run.id);
                    return;
                }
                const preview = await this.deps.registry.invoke(toolName, entry.args, context, 'preview');
                if (mode === 'notify' || preview.actionable === 0) {
                    this.finish(run.id, 'completed', { result: preview });
                    if (mode === 'notify' && (preview.actionable ?? 1) > 0) {
                        this.notify(automation.name, preview.summary, run.id);
                    }
                    return;
                }
                this.supersedeWaiting(entry, run.id);
                const summary = asks ? `${preview.summary} ${asks}` : preview.summary;
                this.deps.store.update(run.id, {
                    status: 'needs-approval',
                    summary,
                    result: compact(preview.data),
                    approval: { args: preview.approvalArgs ?? entry.args ?? {} },
                    updatedAt: this.iso(),
                });
                this.deps.notify({
                    title: `${automation.name} needs your approval`,
                    body: `${summary} Review it in Consola.`,
                    runId: run.id,
                    workspaceId: entry.workspaceId,
                    needsApproval: true,
                });
            },
            automation.name
        );
    }

    /**
     * One run at a time per key (an automation's key; a request's own id),
     * with the bookkeeping every run shares.
     */
    private async guarded(key: string, runId: string, work: () => Promise<void>, label: string): Promise<RunRecord> {
        this.inFlight.add(key);
        this.broadcastRun(runId);
        try {
            await work();
        } catch (error) {
            this.finish(runId, 'failed', { error: describeError(error) });
            this.notify(`${label} failed`, describeError(error), runId);
        } finally {
            this.inFlight.delete(key);
            this.broadcastRun(runId);
        }
        return this.deps.store.get(runId)!;
    }

    private assertIdle(key: string, name: string): void {
        if (this.inFlight.has(key)) throw new Error(`${name} is already running.`);
    }

    private newRun(entry: Resolved, trigger: RunTrigger, mode: AutomationMode): RunRecord {
        const { automation, version, workspaceId } = entry;
        const now = this.iso();
        return {
            id: this.deps.newId(),
            runner: 'local',
            source: 'personal',
            automationId: automation.name,
            actionName: automation.run.ref,
            actionVersion: version,
            mode,
            trigger,
            status: 'running',
            attribution: {
                automationId: automation.name,
                actionName: automation.run.ref,
                triggerKind: trigger.kind,
                workspaceId,
                ...(trigger.actorId ? { actorId: trigger.actorId } : {}),
            },
            createdAt: now,
            updatedAt: now,
        };
    }

    /** An older approval for the same automation is moot once a newer plan exists. */
    private supersedeWaiting(entry: Resolved, keepId: string): void {
        for (const run of this.deps.store.runs()) {
            if (isRunOf(run, entry) && run.id !== keepId && run.status === 'needs-approval') {
                this.finish(run.id, 'rejected', { summary: 'Superseded by a newer run.' });
            }
        }
    }

    private waiting(runId: string): RunRecord {
        const run = this.deps.store.get(runId);
        if (!run) throw new Error(`No run ${runId}.`);
        if (run.status !== 'needs-approval') throw new Error(`Run ${runId} is ${run.status}, not waiting for approval.`);
        return run;
    }

    private finish(
        runId: string,
        status: Extract<RunStatus, 'completed' | 'failed' | 'rejected'>,
        outcome: { result?: ToolResult; summary?: string; error?: string }
    ): void {
        const now = this.iso();
        this.deps.store.update(runId, {
            status,
            ...(outcome.result ? { summary: outcome.result.summary, result: compact(outcome.result.data) } : {}),
            ...(outcome.summary ? { summary: outcome.summary } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
            updatedAt: now,
            finishedAt: now,
        });
        this.broadcastRun(runId);
    }

    private notify(title: string, body: string, runId: string): void {
        const workspaceId = this.deps.store.get(runId)?.attribution.workspaceId;
        if (!workspaceId) return;
        this.deps.notify({ title, body, runId, workspaceId, needsApproval: false });
    }

    private broadcastRun(runId: string): void {
        const workspaceId = this.deps.store.get(runId)?.attribution.workspaceId;
        if (workspaceId) this.broadcast(workspaceId);
    }

    private broadcast(workspaceId: string): void {
        if (this.factories.has(workspaceId)) this.deps.broadcast(workspaceId, this.snapshot(workspaceId));
    }

    private iso(): string {
        return this.deps.now().toISOString();
    }
}

/** A run of this automation, in this workspace. */
function isRunOf(run: RunRecord, entry: Resolved): boolean {
    return (
        !isAgentRequest(run) &&
        run.attribution.workspaceId === entry.workspaceId &&
        run.automationId === entry.automation.name
    );
}

/** An agent's call waiting for a person, as opposed to a run of an automation. */
function isAgentRequest(run: RunRecord): boolean {
    return run.source === 'manual';
}

/** What a request asks for — tool and exact arguments — so asking twice for one plan is recognised. */
function requestVersion(ref: string, args: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify([ref, args])).digest('hex').slice(0, 16);
}

function compact(data: unknown): unknown {
    try {
        return JSON.stringify(data).length > MAX_RESULT_CHARS ? { truncated: true } : data;
    } catch {
        return undefined;
    }
}
