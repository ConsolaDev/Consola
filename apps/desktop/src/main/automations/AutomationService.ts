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
    CONSOLA_NAMESPACE,
    type ToolContext,
    type ToolDefinition,
    type ToolRegistry,
    type ToolResult,
} from '../tools/Tool';
import type { LoadedFactoryFile } from './FactoryFile';
import type { RunStore } from './RunStore';

/**
 * The local runner for personal automations (`~/.consola/factory.yml`).
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
 */

export interface AutomationNotice {
    title: string;
    body: string;
    runId: string;
    needsApproval: boolean;
}

export interface AutomationServiceDeps {
    file: {
        readonly filePath: string;
        load(): Promise<LoadedFactoryFile>;
        watch(onChange: () => void): void;
        unwatch(): void;
        ensureExists(): Promise<string>;
    };
    store: RunStore;
    registry: Pick<ToolRegistry, 'get' | 'validate' | 'invoke'>;
    getWorkspaces(): Workspace[];
    now(): Date;
    newId(): string;
    notify(notice: AutomationNotice): void;
    broadcast(snapshot: AutomationsSnapshot): void;
    /** setInterval, as a seam; returns a canceller. */
    every(ms: number, run: () => void): () => void;
}

/** How often the scheduler looks at the clock. Coarse on purpose: cron is per-minute. */
export const TICK_MS = 30_000;

/** Results bigger than this are summarised away rather than kept in history. */
const MAX_RESULT_CHARS = 20_000;

interface Resolved {
    automation: Automation;
    /** `automationVersion`: what approvals bind to. */
    version: string;
    tool?: ToolDefinition;
    args?: Record<string, unknown>;
    /** Set when the entry parsed but cannot run: the reason it will not. */
    problem?: string;
}

/** A schedule's identity: a renamed automation or an edited cron starts afresh rather than catching up. */
function scheduleKey(automation: Automation): string {
    return `${automation.name} ${automation.trigger.cron}`;
}

export class AutomationService {
    private loaded: LoadedFactoryFile = { exists: false, spec: { automations: [], issues: [] } };
    private resolved: Resolved[] = [];
    private stopTicking: (() => void) | null = null;
    /** Automation names with a run in progress: one at a time per automation. */
    private readonly inFlight = new Set<string>();
    private ticking = false;

    constructor(private readonly deps: AutomationServiceDeps) {}

    public async start(): Promise<void> {
        this.deps.store.load(this.iso());
        await this.reload();
        this.deps.file.watch(() => void this.reload());
        this.stopTicking = this.deps.every(TICK_MS, () => void this.tick());
        // Catch up on anything missed while Consola was closed.
        await this.tick();
    }

    public stop(): void {
        this.stopTicking?.();
        this.stopTicking = null;
        this.deps.file.unwatch();
    }

    public async reload(): Promise<void> {
        this.loaded = await this.deps.file.load();
        this.resolved = this.loaded.spec.automations.map((automation) => this.resolve(automation));
        const keys = new Set(this.resolved.map(({ automation }) => scheduleKey(automation)));
        this.deps.store.keepSchedules(keys);
        // A new schedule starts now: it never fires for an occurrence that
        // passed before it existed.
        for (const key of keys) {
            if (!this.deps.store.lastFired(key)) this.deps.store.setLastFired(key, this.iso());
        }
        this.broadcast();
    }

    /** The file, created from its commented template when missing; for "Open file". */
    public async ensureFile(): Promise<string> {
        const filePath = await this.deps.file.ensureExists();
        await this.reload();
        return filePath;
    }

    /** Fire everything that is due. Public so wake-from-sleep can call it. */
    public async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const now = this.deps.now();
            for (const entry of this.resolved) {
                // A run still in progress keeps the occurrence for a later
                // tick rather than silently consuming it.
                if (this.problemOf(entry) || this.inFlight.has(entry.automation.name)) continue;
                const due = this.nextDue(entry, now);
                if (!due || due.getTime() > now.getTime()) continue;
                // Recorded before running, so a slow run or a crash can never
                // make the same occurrence fire twice.
                this.deps.store.setLastFired(scheduleKey(entry.automation), now.toISOString());
                const catchUp = now.getTime() - due.getTime() > 2 * TICK_MS;
                await this.fire(entry, { kind: 'cron', at: due.toISOString(), ...(catchUp ? { catchUp } : {}) }).catch(
                    (error) => console.error(`Automation ${entry.automation.name} could not start.`, error)
                );
            }
        } finally {
            this.ticking = false;
        }
    }

    /** Run an automation now: Settings' Run now, or an agent's `run_automation`. */
    public async trigger(name: string, actor: { sessionId?: string } = {}): Promise<RunRecord> {
        const entry = this.resolved.find((candidate) => candidate.automation.name === name);
        if (!entry) throw new Error(`No automation named "${name}" in ${this.deps.file.filePath}.`);
        const problem = this.problemOf(entry);
        if (problem) throw new Error(`${name} cannot run: ${problem}`);
        // An agent never replaces a plan a person may be reviewing, nor
        // notifies them again about it: it gets the waiting run back.
        if (actor.sessionId) {
            const pending = this.deps.store
                .runs()
                .find((run) => run.automationId === name && run.status === 'needs-approval');
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
     * Approve a run waiting for a person. Runs exactly what its preview showed
     * — every safety rule checked again, nothing added — and refuses if the
     * automation changed since. Approving a new or edited `auto` entry also
     * lets it run on its own from now on.
     */
    public async approve(runId: string): Promise<RunRecord> {
        const run = this.waiting(runId);
        const entry = this.resolved.find((candidate) => candidate.automation.name === run.automationId);
        const problem = !entry
            ? 'it is no longer in factory.yml'
            : (this.problemOf(entry) ??
              (entry.version !== run.actionVersion ? 'factory.yml changed since this preview; run it again' : undefined));
        if (!entry || problem) {
            this.finish(run.id, 'failed', { error: `Not run: ${problem}.` });
            throw new Error(`Not run: ${problem}.`);
        }
        this.assertIdle(entry.automation.name);
        this.deps.store.update(run.id, { status: 'running', updatedAt: this.iso() });
        return this.guarded(entry.automation.name, run.id, async () => {
            const args = run.approval?.args ?? entry.args;
            const result = await this.deps.registry.invoke(entry.tool!.name, args, this.contextFor(entry), 'run');
            this.finish(run.id, 'completed', { result });
            if (entry.automation.mode === 'auto') this.deps.store.accept(entry.automation.name, entry.version);
        });
    }

    public dismiss(runId: string): RunRecord {
        const run = this.waiting(runId);
        this.finish(run.id, 'rejected', {});
        return this.deps.store.get(run.id)!;
    }

    public list(): AutomationView[] {
        const now = this.deps.now();
        return this.resolved.map((entry) => {
            const { automation } = entry;
            const problem = this.problemOf(entry);
            const next = problem ? null : this.nextDue(entry, now);
            return {
                name: automation.name,
                cron: automation.trigger.cron,
                mode: automation.mode,
                target: automation.run.ref,
                ...(automation.workspace ? { workspace: automation.workspace } : {}),
                ...(automation.line ? { line: automation.line } : {}),
                // A due-but-unfired occurrence reads as "now", not as a time in the past.
                nextRunAt: next ? new Date(Math.max(next.getTime(), now.getTime())).toISOString() : null,
                ...(automation.mode === 'auto' && this.deps.store.acceptedVersion(automation.name) !== entry.version
                    ? { asksFirst: true }
                    : {}),
                ...(problem ? { problem } : {}),
            };
        });
    }

    public snapshot(): AutomationsSnapshot {
        return {
            filePath: this.deps.file.filePath,
            fileExists: this.loaded.exists,
            automations: this.list(),
            issues: this.loaded.spec.issues,
            runs: this.deps.store.runs(),
        };
    }

    private resolve(automation: Automation): Resolved {
        const version = automationVersion(automation);
        const { run } = automation;
        const unable = (problem: string): Resolved => ({ automation, version, problem });
        if (run.kind !== 'tool') return unable('actions cannot be run by automations yet');
        if (run.namespace !== CONSOLA_NAMESPACE) {
            return unable(`unknown tool namespace "${run.namespace}"; only consola# tools exist today`);
        }
        const tool = this.deps.registry.get(run.tool);
        if (!tool) return unable(`there is no Consola tool named "${run.tool}"`);
        if (!tool.automatable) return unable(`${run.ref} cannot be run by an automation`);
        const validated = this.deps.registry.validate(tool, automation.with);
        if (!validated.ok) return unable(`with: ${validated.error}`);
        return { automation, version, tool, args: validated.args };
    }

    /** Load-time problems, plus the one that can appear later: the named workspace going away. */
    private problemOf(entry: Resolved): string | undefined {
        if (entry.problem) return entry.problem;
        const selected = this.selectedWorkspace(entry);
        return 'problem' in selected ? selected.problem : undefined;
    }

    /** The workspace `workspace:` names — by id, else by a name only one workspace has. */
    private selectedWorkspace(entry: Resolved): { workspace?: Workspace } | { problem: string } {
        const selector = entry.automation.workspace;
        if (!selector) return {};
        const workspaces = this.deps.getWorkspaces();
        const byId = workspaces.find((workspace) => workspace.id === selector);
        if (byId) return { workspace: byId };
        const wanted = selector.trim().toLowerCase();
        const byName = workspaces.filter((workspace) => workspace.name.trim().toLowerCase() === wanted);
        if (byName.length === 1) return { workspace: byName[0] };
        return {
            problem:
                byName.length === 0
                    ? `no workspace named "${selector}"`
                    : `${byName.length} workspaces are named "${selector}"; use the workspace id instead`,
        };
    }

    private contextFor(entry: Resolved): ToolContext {
        const selected = this.selectedWorkspace(entry);
        const workspace = 'workspace' in selected ? selected.workspace : undefined;
        return {
            caller: { kind: 'automation', automation: entry.automation.name },
            scope: { workspaceIds: workspace ? [workspace.id] : 'all', excludeSessionIds: [] },
        };
    }

    private nextDue(entry: Resolved, now: Date): Date | null {
        const last = this.deps.store.lastFired(scheduleKey(entry.automation));
        return nextCronOccurrence(entry.automation.trigger.cron, last ? new Date(last) : now);
    }

    /** The mode this run uses, and why it asks when the file says `auto`. */
    private effectiveMode(entry: Resolved, trigger: RunTrigger): { mode: AutomationMode; asks?: string } {
        const { mode, name } = entry.automation;
        if (mode !== 'auto') return { mode };
        if (trigger.by === 'agent') return { mode: 'confirm', asks: 'An agent asked for this run.' };
        if (this.deps.store.acceptedVersion(name) !== entry.version) {
            return { mode: 'confirm', asks: 'Approve once to let this new or changed automation run on its own.' };
        }
        return { mode };
    }

    private async fire(entry: Resolved, trigger: RunTrigger): Promise<RunRecord> {
        const { automation } = entry;
        this.assertIdle(automation.name);
        const { mode, asks } = this.effectiveMode(entry, trigger);
        const run = this.newRun(entry, trigger, mode);
        this.deps.store.add(run);
        return this.guarded(automation.name, run.id, async () => {
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
            this.supersedeWaiting(automation.name, run.id);
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
                needsApproval: true,
            });
        });
    }

    /** One run at a time per automation, with the bookkeeping every run shares. */
    private async guarded(name: string, runId: string, work: () => Promise<void>): Promise<RunRecord> {
        this.inFlight.add(name);
        this.broadcast();
        try {
            await work();
        } catch (error) {
            this.finish(runId, 'failed', { error: describeError(error) });
            this.notify(`${name} failed`, describeError(error), runId);
        } finally {
            this.inFlight.delete(name);
            this.broadcast();
        }
        return this.deps.store.get(runId)!;
    }

    private assertIdle(name: string): void {
        if (this.inFlight.has(name)) throw new Error(`${name} is already running.`);
    }

    private newRun(entry: Resolved, trigger: RunTrigger, mode: AutomationMode): RunRecord {
        const { automation, version } = entry;
        const selected = this.selectedWorkspace(entry);
        const workspaceId = 'workspace' in selected ? selected.workspace?.id : undefined;
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
                ...(workspaceId ? { workspaceId } : {}),
                ...(trigger.actorId ? { actorId: trigger.actorId } : {}),
            },
            createdAt: now,
            updatedAt: now,
        };
    }

    /** An older approval for the same automation is moot once a newer plan exists. */
    private supersedeWaiting(name: string, keepId: string): void {
        for (const run of this.deps.store.runs()) {
            if (run.automationId === name && run.id !== keepId && run.status === 'needs-approval') {
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
        this.broadcast();
    }

    private notify(title: string, body: string, runId: string): void {
        this.deps.notify({ title, body, runId, needsApproval: false });
    }

    private broadcast(): void {
        this.deps.broadcast(this.snapshot());
    }

    private iso(): string {
        return this.deps.now().toISOString();
    }
}

function compact(data: unknown): unknown {
    try {
        return JSON.stringify(data).length > MAX_RESULT_CHARS ? { truncated: true } : data;
    } catch {
        return undefined;
    }
}
