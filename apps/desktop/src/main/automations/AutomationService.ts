import { createHash } from 'crypto';
import {
    automationEntryText,
    automationVersion,
    nextCronOccurrence,
    parseAutomationEntry,
    parseFactorySpec,
    stableStringify,
    TERMINAL_RUN_STATUSES,
    type Automation,
    type AutomationMode,
    type CronTrigger,
    type FactorySpecIssue,
    type RunRecord,
    type RunStatus,
    type RunTrigger,
} from '@consola/factory-spec';
import type {
    AgentRunPreview,
    AutomationsSnapshot,
    AutomationView,
    RunListEntry,
    SavedAutomation,
    TemplateView,
} from '../../shared/automations';
import type { InboxItem, InboxSnapshot } from '../../shared/workItems';
import { defaultActionFor } from '../../shared/workItemActions';
import { sameWorkItem } from '../../shared/workItems';
import type { Scope, Session, Workspace } from '../../shared/workspace';
import { describeError } from '../describeError';
import {
    agentContext,
    CONSOLA_NAMESPACE,
    type ToolContext,
    type ToolDefinition,
    type ToolRegistry,
    type ToolResult,
} from '../tools/Tool';
import { describeCapabilities, type AutomationCapabilities } from './capabilities';
import { resolveEventSource, scheduledPrompt, type EventSource } from './connections';
import { describeSchedule } from './describeSchedule';
import {
    ASSIGNED_REVIEWS_NAME,
    assignedReviewsEntry,
    EMPTY_FACTORY_FILE,
    factoryTemplate,
    type LoadedFactoryFile,
} from './FactoryFile';
import type { RunStore } from './RunStore';
import { StartedByHandError } from './launchAgentRun';
import { advanceSeen } from './seenRecord';
import { AUTOMATION_TEMPLATES, coversAssignedReviews, templateViews } from './templates';

/**
 * The local runner for personal automations: one `factory.yml` per workspace
 * (`~/.consola/workspaces/<workspace-id>/factory.yml`), whose automations act
 * on that workspace and nothing else.
 *
 * Trigger → target, in a mode. A target is a tool, run in-process, or an
 * agent session — one of the workspace's actions or a prompt of the
 * automation's own — started headless, read-only, as an ordinary tab the
 * person can watch, steer and resume. Triggers are a cron, a main-process
 * timer, or a connection's event: a change between two successful polls of
 * the Inbox. Consola detects; the agent acts — nothing is spent while nothing
 * is new. Automations run only while Consola is open; what was missed while
 * it was closed fires once on the next launch, never once per occurrence. No
 * run ever starts another run (no workflow engine).
 *
 * Nothing a person did not approve runs unasked: `confirm` is the default; an
 * agent asking for an `auto` automation gets `confirm`; and an `auto` entry
 * runs on its own only at a version a person approved once — a new or edited
 * one asks first, whoever wrote the file, and so does one whose action was
 * edited in settings. Approving runs exactly what the preview showed, and
 * nothing if the definition changed since.
 *
 * Agent runs share one machine and one subscription, so at most a few of
 * their sessions work at once across every workspace; the rest wait as
 * `queued`, first in, first out.
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
    /** The session a run started: a click opens it instead of the panel. */
    sessionId?: string;
}

/** One workspace's spec file. */
export interface FactoryFileHandle {
    readonly filePath: string;
    load(): Promise<LoadedFactoryFile>;
    watch(onChange: () => void): void;
    unwatch(): void;
    /** Create the file from `template` when it is missing; returns its path. */
    ensureExists(template: string): Promise<string>;
    /** Add one automation (a `- name: …` item) at the end of the list, keeping everything else. */
    appendAutomation(entryYaml: string): Promise<void>;
    /** Swap the automation called `name` for `entryYaml`, in place, keeping every byte outside it. */
    replaceAutomation(name: string, entryYaml: string): Promise<void>;
    /** The file as written, or null when there is none yet. */
    readText(): Promise<string | null>;
}

/** How `saveEntry` writes: whether it may replace an entry of the same name, and the session that asked. */
export interface SaveEntryOptions {
    replace: boolean;
    by?: { sessionId: string; sessionName: string };
}

/** What an agent run asks main to start: a headless, read-only session. */
export interface AgentLaunchRequest {
    workspaceId: string;
    run: { id: string; automation: string };
    /** The exact prompt the session starts with — the one its preview showed. */
    prompt: string;
    /**
     * An item run: it runs in a worktree of the item's own repo. When
     * `startedByHandSince` is set, a session the person started on the item
     * with the same action after that time refuses the launch
     * (`StartedByHandError`), checked under the lock an Inbox click takes.
     */
    item?: { workItem: InboxItem['workItem']; title: string; label: string; groupId?: string; startedByHandSince?: string };
    /** A scheduled run: it runs in this scope's folder. */
    scopeId?: string;
}

export interface AutomationServiceDeps {
    /** A workspace's spec file; asked for once, when the workspace is first seen. */
    fileFor(workspaceId: string): FactoryFileHandle;
    store: RunStore;
    registry: Pick<ToolRegistry, 'get' | 'list' | 'validate' | 'invoke'>;
    getWorkspaces(): Workspace[];
    now(): Date;
    newId(): string;
    notify(notice: AutomationNotice): void;
    broadcast(workspaceId: string, snapshot: AutomationsSnapshot): void;
    /** setInterval, as a seam; returns a canceller. */
    every(ms: number, run: () => void): () => void;
    /** A workspace's latest Inbox snapshot, or null before its first fetch. */
    inboxSnapshot(workspaceId: string): InboxSnapshot | null;
    /** Fetch a workspace's Inbox now — an event automation's "Check now". */
    refreshInbox(workspaceId: string): Promise<void>;
    /** Start an agent run's session, its first turn unattended; throws with the reason it could not. */
    launchAgent(request: AgentLaunchRequest): Promise<Session>;
    /** Run `prompt` as an unattended turn in a recorded automation session; throws with the reason it could not. */
    resumeAgent(session: Session, prompt: string): Promise<void>;
    /** Whether a session has a terminal whose process is still running: someone opened it. */
    hasLiveTerminal(session: Session): boolean;
    /**
     * The workspace's default harness: its display name, and why it cannot
     * run a read-only unattended session (null when it can).
     */
    agentHarness(workspaceId: string): { name: string; problem: string | null };
    /** End a running unattended turn the way Ctrl+C does. False when none is running. */
    stopAgent(session: Session, reason: string): boolean;
    /** Agent sessions automations may have working at once, across every workspace. */
    maxConcurrentAgents?: number;
}

/** The turn an automation session gets when Consola quit before its first one finished. */
export const INTERRUPTED_PROMPT = 'Consola closed before you finished. Continue where you left off.';

/** How often the scheduler looks at the clock. Coarse on purpose: cron is per-minute. */
export const TICK_MS = 30_000;

/** Automation sessions working at once, across every workspace, by default. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 2;

/** Results bigger than this are summarised away rather than kept in history. */
const MAX_RESULT_CHARS = 20_000;

/** Requests one agent session may leave waiting before it must wait for the person. */
export const MAX_WAITING_PER_SESSION = 10;

/** A run that has not finished: one more of these for the same thing would be a duplicate. */
const OPEN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'needs-approval'];

interface Resolved {
    workspaceId: string;
    automation: Automation;
    /** `automationVersion`, the action's body included: what approvals bind to. */
    version: string;
    /** A tool run's tool and validated arguments. */
    tool?: ToolDefinition;
    args?: Record<string, unknown>;
    /** An agent run: the body it renders, and how its session is labelled and placed. */
    agent?: {
        body: string;
        /** The session's `workItemAction` for an item run: the action's name, or the automation's. */
        label?: string;
        groupId?: string;
        /** A scheduled run's scope. */
        scope?: Scope;
        /** "Review action", "Prompt" — for previews. */
        runs: string;
    };
    /** An event trigger, resolved against the entry's filter. */
    event?: EventSource;
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
function automationKey(entry: { workspaceId: string; automation: Pick<Automation, 'name'> }): string {
    return `${entry.workspaceId} ${entry.automation.name}`;
}

function cronOf(entry: Resolved): CronTrigger | null {
    return entry.automation.trigger.kind === 'cron' ? entry.automation.trigger : null;
}

/** A schedule's identity: a renamed automation or an edited cron starts afresh rather than catching up. */
function scheduleKey(entry: Resolved): string {
    return `${automationKey(entry)} ${cronOf(entry)?.cron ?? ''}`;
}

/**
 * Which list an event automation watches: its trigger and filter, and whose
 * Inbox it is — the account and org the workspace is bound to decide what
 * the searches return. Changing any of them re-baselines, so binding another
 * org never reads as every request in it arriving at once.
 */
function listDefinition(entry: Resolved, provider: Workspace['provider']): string {
    const { trigger, filter } = entry.automation;
    const account = provider ? { id: provider.id, login: provider.accountLogin, org: provider.org } : null;
    return createHash('sha256').update(stableStringify({ trigger, filter, account })).digest('hex').slice(0, 16);
}

type QueueVerdict =
    | { go: true; item?: InboxItem }
    | { go: false; wait: true }
    | { go: false; wait?: false; status: 'rejected' | 'failed'; message: string };

export class AutomationService {
    private readonly factories = new Map<string, WorkspaceFactory>();
    private stopTicking: (() => void) | null = null;
    /** Tool runs in progress: by automation key, or a request's own id. One at a time per automation. */
    private readonly inFlight = new Set<string>();
    private ticking = false;
    private started = false;
    private pumping = false;
    /** Running agent runs whose session is still being launched or resumed: no live turn to stop yet. */
    private readonly starting = new Set<string>();
    /** Of those, the ones a person asked to stop; honoured as soon as the turn exists. */
    private readonly stopRequested = new Set<string>();
    private pumpAgain = false;
    /** Each workspace's last save, settled either way: the next one waits for it. */
    private readonly saving = new Map<string, Promise<void>>();
    /**
     * When `saveEntry` last wrote each entry, by automation key. A run asked
     * for before then was approved for what the entry said before, so its
     * approval accepts nothing: a schedule-only change keeps the version, and
     * would otherwise run unasked on the strength of the old entry's approval.
     */
    private readonly savedAt = new Map<string, number>();

    constructor(private readonly deps: AutomationServiceDeps) {}

    public async start(): Promise<void> {
        this.deps.store.load(this.iso());
        this.started = true;
        await this.syncWorkspaces();
        this.stopTicking = this.deps.every(TICK_MS, () => void this.tick());
        // Catch up on anything missed while Consola was closed, and resume
        // whatever was queued when it quit.
        await this.tick();
    }

    /** Quit: stop ticking and let go of every workspace's file. */
    public shutdown(): void {
        this.started = false;
        this.stopTicking?.();
        this.stopTicking = null;
        for (const factory of this.factories.values()) factory.file.unwatch();
        this.factories.clear();
    }

    /**
     * Follow the workspace list. A new workspace's file is read and watched; a
     * deleted one's is let go — its schedules stop, and anything waiting in it
     * is dismissed, since there is nowhere left to approve or run it. Every
     * other workspace's entries are resolved again, because what they resolve
     * against — actions, scopes, the provider binding — lives on the record.
     */
    public async syncWorkspaces(): Promise<void> {
        if (!this.started) return;
        const current = new Set(this.deps.getWorkspaces().map((workspace) => workspace.id));

        const removed = [...this.factories.keys()].filter((id) => !current.has(id));
        for (const workspaceId of removed) {
            this.factories.get(workspaceId)!.file.unwatch();
            this.factories.delete(workspaceId);
            for (const run of this.deps.store.runs()) {
                if (run.attribution.workspaceId === workspaceId && (run.status === 'needs-approval' || run.status === 'queued')) {
                    this.finish(run.id, 'rejected', { summary: 'Its workspace was deleted.' });
                }
            }
            this.deps.store.forgetWorkspace(workspaceId);
        }

        // Registered before anything is awaited, so a second sync arriving
        // meanwhile sees the workspace as known rather than adding it twice.
        const added = [...current].filter((id) => !this.factories.has(id));
        for (const workspaceId of added) {
            const file = this.deps.fileFor(workspaceId);
            this.factories.set(workspaceId, { file, loaded: NOT_LOADED, resolved: [] });
            file.watch(() => void this.reload(workspaceId));
        }

        // Settings edits re-resolve without touching the file. Broadcast only
        // what changed: this runs on every workspace write, session clicks
        // included. A template's `missing` follows the same settings.
        const settingsView = (workspaceId: string, factory: WorkspaceFactory) =>
            stableStringify([this.list(workspaceId), this.templatesOf(workspaceId, factory)]);
        for (const [workspaceId, factory] of this.factories) {
            if (added.includes(workspaceId)) continue;
            const before = settingsView(workspaceId, factory);
            this.resolveAll(workspaceId, factory);
            if (settingsView(workspaceId, factory) !== before) this.broadcast(workspaceId);
        }

        // Every file is read before schedules are reconciled: reconciling
        // while one is unread would forget its fire times, and with them the
        // catch-up for whatever it missed while Consola was closed.
        await Promise.all(added.map((workspaceId) => this.load(workspaceId)));
        if (added.length > 0 || removed.length > 0) this.settleSchedules();
        for (const workspaceId of added) this.broadcast(workspaceId);
        // A session closed mid-turn never reports its exit (closing drops the
        // terminal's listeners): its run ends here, and its slot frees.
        for (const run of this.deps.store.runs()) {
            if (run.status === 'running' && run.sessionId && isAgentRun(run) && !this.sessionOf(run)) {
                this.finish(run.id, 'failed', { error: 'Its session was closed before it finished.' });
            }
        }
        void this.pump();
    }

    /** Re-read one workspace's file: when it changes, and after "Open file" creates it. */
    public async reload(workspaceId: string): Promise<void> {
        if (!(await this.load(workspaceId))) return;
        this.settleSchedules();
        this.broadcast(workspaceId);
    }

    /**
     * The workspace's file, created from the template when missing; for
     * "Open file". A new file reviews assigned pull requests with the
     * workspace's default pull request action, when it has one.
     */
    public async ensureFile(workspaceId: string): Promise<string> {
        const filePath = await this.factoryOf(workspaceId).file.ensureExists(factoryTemplate(this.prActionOf(workspaceId) ?? null));
        await this.reload(workspaceId);
        return filePath;
    }

    /**
     * The panel's "Review PRs assigned to me automatically": add
     * review-assigned-prs to the workspace's file — the template when there
     * is no file, otherwise one more entry at the end, every other line left
     * as it was. In `auto`, so it asks once before the first review.
     */
    public async addAssignedReviews(workspaceId: string): Promise<void> {
        const action = this.prActionOf(workspaceId);
        if (!action) throw new Error('Add an action for pull requests first.');
        const { file } = this.factoryOf(workspaceId);
        const loaded = await file.load();
        if (loaded.spec.automations.some((automation) => automation.name === ASSIGNED_REVIEWS_NAME)) {
            throw new Error(`factory.yml already has ${ASSIGNED_REVIEWS_NAME}.`);
        }
        if (loaded.exists) await file.appendAutomation(assignedReviewsEntry(action));
        else await file.ensureExists(factoryTemplate(action));
        await this.reload(workspaceId);
    }

    /** The action automatic reviews would run: the workspace's default for pull requests. */
    private prActionOf(workspaceId: string): string | undefined {
        const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
        return workspace ? defaultActionFor(workspace.actions ?? [], 'pr')?.name : undefined;
    }

    /**
     * Whether to offer automatic reviews: the workspace can run them (an
     * account and a pull request action), its file loads, and nothing in it
     * already reviews requests or assignments — or goes by that name.
     */
    private assignedReviewsSuggestion(workspaceId: string, factory: WorkspaceFactory): { action: string } | null {
        const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
        const action = this.prActionOf(workspaceId);
        if (!workspace?.provider || !action) return null;
        const { spec } = factory.loaded;
        if (spec.issues.some((issue) => !isEntryIssue(issue))) return null;
        return spec.automations.some(coversAssignedReviews) ? null : { action };
    }

    /**
     * Add or replace one entry in a workspace's factory.yml: an agent's
     * `save_automation`, and a template's "Add". The entry is checked the way
     * the runner checks it — parsed on its own, then resolved against this
     * workspace, harness included — and refused, with every reason, if it
     * would not run; a refusal leaves the file as it was. A name already in
     * the file is replaced in place only when `replace` says so. Saves in one
     * workspace run one at a time, each reading what the last one wrote.
     *
     * Whatever it writes asks once before its next unattended run, even a
     * schedule-only change the version would not notice; a hand edit keeps
     * asking only when what the entry does changed. With `by`, the entry is
     * marked as that session's addition until a person looks at it.
     */
    public saveEntry(workspaceId: string, entryYaml: string, options: SaveEntryOptions): Promise<SavedAutomation> {
        const previous = this.saving.get(workspaceId) ?? Promise.resolve();
        const saved = previous.then(() => this.writeEntry(workspaceId, entryYaml, options));
        const settled = saved.then(
            () => undefined,
            () => undefined
        );
        this.saving.set(workspaceId, settled);
        void settled.then(() => {
            if (this.saving.get(workspaceId) === settled) this.saving.delete(workspaceId);
        });
        return saved;
    }

    private async writeEntry(workspaceId: string, entryYaml: string, options: SaveEntryOptions): Promise<SavedAutomation> {
        const parsed = parseAutomationEntry(entryYaml);
        if (!parsed.ok) throw notSaved(parsed.issues.map(describeIssue));
        const { automation, item } = parsed;
        const { file } = this.factoryOf(workspaceId);
        // Read now, not as last loaded: the person may have edited it since.
        const text = await file.readText().catch((error: unknown) => {
            throw notSaved([describeError(error)]);
        });
        const broken = text === null ? [] : parseFactorySpec(text).issues.filter((issue) => !isEntryIssue(issue));
        if (broken.length > 0) {
            throw notSaved([`factory.yml does not load (${broken.map(describeIssue).join('; ')}); fix it by hand first`]);
        }
        const problem = this.resolve(workspaceId, automation).problem;
        if (problem) throw notSaved([problem]);
        // By name as written, so an entry that fails to load still holds its name.
        const replaced = text !== null && automationEntryText(text, automation.name) !== null;
        if (replaced && !options.replace) {
            const name = automation.name;
            throw notSaved([`factory.yml already has an automation named "${name}"; pass replace: true to replace it, or choose another name`]);
        }
        try {
            // A file of its own, not "Open file"'s template: nothing is added beside the entry unasked.
            if (text === null) await file.ensureExists(EMPTY_FACTORY_FILE);
            if (replaced) await file.replaceAutomation(automation.name, item);
            else await file.appendAutomation(item);
        } catch (error) {
            throw notSaved([describeError(error)]);
        }
        const key = automationKey({ workspaceId, automation });
        this.deps.store.revokeAcceptance(key);
        this.savedAt.set(key, this.deps.now().getTime());
        if (options.by) this.deps.store.markAdded(key, { ...options.by, at: this.iso() });
        await this.reload(workspaceId);
        // Again once it is live: a run fired while the file was being reloaded was of the entry before.
        this.savedAt.set(key, this.deps.now().getTime());
        const line = this.factories
            .get(workspaceId)
            ?.loaded.spec.automations.find((candidate) => candidate.name === automation.name)?.line;
        return { name: automation.name, replaced, entry: item, ...(line ? { line } : {}) };
    }

    /**
     * The Templates tab's "Add": the template's entry, as-is, through
     * `saveEntry`. Refused while the workspace lacks what it needs.
     */
    public async addTemplate(workspaceId: string, templateId: string): Promise<void> {
        const template = AUTOMATION_TEMPLATES.find((candidate) => candidate.id === templateId);
        if (!template) throw new Error(`There is no template "${templateId}".`);
        const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
        if (!workspace) throw new Error(`No workspace ${workspaceId}.`);
        const missing = template.missing(workspace);
        if (missing) throw new Error(`Not added: ${missing}.`);
        await this.saveEntry(workspaceId, template.entry(workspace), { replace: false });
    }

    /** One entry exactly as the file has it, as a `- name: …` item; null when there is no such entry or no file. */
    public async entryText(workspaceId: string, name: string): Promise<string | null> {
        const text = await this.factoryOf(workspaceId).file.readText();
        return text === null ? null : automationEntryText(text, name);
    }

    /** A person opened an agent-added entry's details: it is no longer new. */
    public acknowledge(workspaceId: string, name: string): void {
        const key = automationKey({ workspaceId, automation: { name } });
        const added = this.deps.store.addedBy(key);
        if (!added || added.seen) return;
        this.deps.store.acknowledgeAdded(key);
        this.broadcast(workspaceId);
    }

    /** What an agent writing an entry for this workspace needs to know: `automation_capabilities`. */
    public capabilities(workspaceId: string): AutomationCapabilities {
        const factory = this.factoryOf(workspaceId);
        const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
        const { spec } = factory.loaded;
        // An entry that fails to load still holds its name.
        const named = [
            ...spec.automations.map((automation) => automation.name),
            ...spec.issues.flatMap((issue) => issue.automation ?? []),
        ];
        return describeCapabilities({
            filePath: factory.file.filePath,
            fileExists: factory.loaded.exists,
            tools: this.deps.registry.list().filter((tool) => tool.automatable),
            actions: workspace?.actions ?? [],
            scopes: workspace?.scopes ?? [],
            taken: [...new Set(named)],
            boundConnection: workspace?.provider?.id ?? null,
            harness: { name: this.deps.agentHarness(workspaceId).name, problem: this.harnessProblem(workspaceId) },
        });
    }

    /** The templates as this workspace's Templates tab shows them. */
    private templatesOf(workspaceId: string, factory: WorkspaceFactory): TemplateView[] {
        const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
        return workspace ? templateViews(workspace, factory.loaded.spec.automations) : [];
    }

    /** Fire everything that is due, and start what the queue has room for. Public so wake-from-sleep can call it. */
    public async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const now = this.deps.now();
            for (const entry of this.allResolved()) {
                // A run still in progress keeps the occurrence for a later
                // tick rather than silently consuming it.
                if (!cronOf(entry) || entry.problem || this.inFlight.has(automationKey(entry))) continue;
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
        await this.pump();
    }

    /**
     * One workspace's Inbox, freshly fetched: each event automation's set is
     * compared with what it held last time (`advanceSeen`), and every member
     * that passes its filter and has not fired since it entered is one run.
     * A failed fetch — the last good list carried forward with an error —
     * says nothing about what changed, so it fires nothing and moves nothing.
     *
     * The seen record is written before any run is created, so a crash can
     * never fire one event twice. An automation with no record of its own —
     * new, or with a trigger or filter edited — records what is there and
     * fires nothing: turning one on never works through the backlog already
     * waiting, the same rule as a new schedule never firing for a past
     * occurrence. A record that survived a restart is diffed as usual, so a
     * request that arrived while Consola was closed fires once.
     */
    public observeInbox(snapshot: InboxSnapshot): void {
        if (!this.started || snapshot.error || snapshot.fetchedAt === 0) return;
        const factory = this.factories.get(snapshot.workspaceId);
        if (!factory) return;
        const provider = this.deps.getWorkspaces().find((workspace) => workspace.id === snapshot.workspaceId)?.provider;
        const at = new Date(snapshot.fetchedAt).toISOString();
        for (const entry of factory.resolved) {
            const { event } = entry;
            // An entry with a problem is paused: its record stays where it
            // was, so fixing it catches up rather than forgetting.
            if (!event || entry.problem) continue;
            const inSet = new Map<string, InboxItem>();
            for (const item of snapshot.items) if (event.inSet(item)) inSet.set(event.keyOf(item), item);
            const key = automationKey(entry);
            const previous = this.deps.store.seen(key);
            const current = [...inSet].map(([itemKey, item]) => ({ key: itemKey, passes: event.passesFilter(item) }));
            const { record, fire } = advanceSeen(previous, listDefinition(entry, provider), current, at);
            this.deps.store.setSeen(key, record);
            for (const itemKey of fire) this.fireEvent(entry, inSet.get(itemKey)!, previous!.at, at);
        }
        void this.pump();
    }

    /**
     * A session's unattended turn ended: its run is done, one way or the
     * other, and its slot is free. The run is the session's `running` one —
     * a later exit of the same session, the person continuing it, is not.
     */
    public turnEnded(sessionId: string, outcome: { exitCode: number; lastLine?: string; stopped?: string }): void {
        const run = this.deps.store
            .runs()
            .find((candidate) => candidate.sessionId === sessionId && candidate.status === 'running' && isAgentRun(candidate));
        if (!run) return;
        const name = this.sessionOf(run)?.name ?? 'its session';
        let notice: { title: string; body: string };
        if (outcome.stopped) {
            // Stopped before it answered — by the person, the limit, or a
            // signal — whatever code the process exited with.
            const error = `It stopped before finishing: ${outcome.stopped.trim().replace(/[.\s]+$/, '')}.`;
            this.finish(run.id, 'failed', { error });
            notice = { title: `${run.automationId} did not finish`, body: error };
        } else if (outcome.exitCode === 0) {
            this.finish(run.id, 'completed', { summary: `Ready in “${name}”.` });
            const item = (run.result as AgentRunPreview).item?.label;
            notice = { title: `${run.automationId}: ready`, body: `${item ?? name} — the findings are waiting. Click to open them.` };
        } else {
            const said = outcome.lastLine?.trim().replace(/[.\s]+$/, '');
            const error = `It stopped before finishing (exit ${outcome.exitCode})${said ? `: ${said}` : ''}.`;
            this.finish(run.id, 'failed', { error });
            notice = { title: `${run.automationId} did not finish`, body: error };
        }
        // The click opens the session, where the findings — or the reason — are.
        const { workspaceId } = run.attribution;
        if (workspaceId) this.deps.notify({ ...notice, runId: run.id, workspaceId, needsApproval: false, sessionId });
        void this.pump();
    }

    /**
     * Run one of a workspace's automations now: its panel's Run now, or an
     * agent's `run_automation`. An event automation has no run to start on
     * request — its "Check now" fetches the Inbox, and only what is new fires
     * — so it returns null; an agent cannot ask for one at all.
     */
    public async trigger(
        workspaceId: string,
        name: string,
        actor: { sessionId?: string } = {}
    ): Promise<RunRecord | null> {
        const factory = this.factoryOf(workspaceId);
        const entry = factory.resolved.find((candidate) => candidate.automation.name === name);
        if (!entry) throw new Error(`No automation named "${name}" in ${factory.file.filePath}.`);
        if (entry.problem) throw new Error(`${name} cannot run: ${entry.problem}`);
        if (entry.event) {
            if (actor.sessionId) {
                throw new Error(`${name} runs when its event happens (${entry.event.describe.toLowerCase()}), not on request.`);
            }
            await this.deps.refreshInbox(workspaceId);
            return null;
        }
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
     * automation changed since. An agent run joins the queue, so approving
     * one never steps past the cap. Approving a new or edited `auto` entry
     * also lets it run on its own from now on.
     */
    public async approve(runId: string): Promise<RunRecord> {
        const run = this.waiting(runId);
        if (isAgentRequest(run)) return this.approveRequest(run);
        const entry = this.entryOf(run);
        const problem = !entry
            ? 'it is no longer in its workspace’s factory.yml'
            : (entry.problem ??
              (entry.version !== run.actionVersion ? 'factory.yml changed since this preview; run it again' : undefined));
        if (!entry || problem) {
            this.finish(run.id, 'failed', { error: `Not run: ${problem}.` });
            throw new Error(`Not run: ${problem}.`);
        }
        const key = automationKey(entry);
        if (entry.agent) {
            this.deps.store.update(run.id, { status: 'queued', updatedAt: this.iso() });
            this.acceptApproved(key, entry, run);
            this.broadcastRun(run.id);
            // As approved: in line. The queue may start it at once.
            const queued = { ...this.deps.store.get(run.id)! };
            void this.pump();
            return queued;
        }
        this.assertIdle(key, entry.automation.name);
        this.deps.store.update(run.id, { status: 'running', startedAt: this.iso(), updatedAt: this.iso() });
        return this.guarded(
            key,
            run.id,
            async () => {
                const args = run.approval?.args ?? entry.args;
                const result = await this.deps.registry.invoke(entry.tool!.name, args, this.contextFor(entry), 'run');
                this.finish(run.id, 'completed', { result });
                // Checked now, not at approval: a save may have landed while it ran.
                this.acceptApproved(key, entry, run);
            },
            entry.automation.name
        );
    }

    /**
     * An approved run of an `auto` entry lets it run on its own from now on —
     * unless `saveEntry` wrote the entry since the run was asked for, or in
     * the same instant: that approval was for the entry before.
     */
    private acceptApproved(key: string, entry: Resolved, run: RunRecord): void {
        if (entry.automation.mode !== 'auto') return;
        const saved = this.savedAt.get(key);
        if (saved !== undefined && !(Date.parse(run.createdAt) > saved)) return;
        this.deps.store.accept(key, entry.version);
    }

    /** Turn down a run waiting for approval, or take a queued one out of the line. */
    public dismiss(runId: string): RunRecord {
        const run = this.deps.store.get(runId);
        if (run?.status !== 'queued') this.waiting(runId);
        this.finish(runId, 'rejected', {});
        return this.deps.store.get(runId)!;
    }

    /** A workspace's automations as its panel and `list_automations` show them. */
    public list(workspaceId: string): AutomationView[] {
        const now = this.deps.now();
        return (this.factories.get(workspaceId)?.resolved ?? []).map((entry) => {
            const { automation } = entry;
            const cron = cronOf(entry);
            const next = cron && !entry.problem ? this.nextDue(entry, now) : null;
            const added = this.deps.store.addedBy(automationKey(entry));
            return {
                name: automation.name,
                mode: automation.mode,
                trigger: entry.event?.describe ?? (cron ? describeSchedule(cron.cron) : describeTriggerAsWritten(automation)),
                ...(cron ? { schedule: cron.cron } : {}),
                onEvent: automation.trigger.kind === 'event',
                kind: automation.run.kind === 'tool' ? 'tool' : 'agent',
                runs: describeRun(automation),
                target: automation.run.ref,
                ...(automation.line ? { line: automation.line } : {}),
                // A due-but-unfired occurrence reads as "now", not as a time in the past.
                nextRunAt: next ? new Date(Math.max(next.getTime(), now.getTime())).toISOString() : null,
                ...(automation.mode === 'auto' && this.deps.store.acceptedVersion(automationKey(entry)) !== entry.version
                    ? { asksFirst: true }
                    : {}),
                ...(entry.problem ? { problem: entry.problem } : {}),
                ...(added
                    ? { addedBy: { sessionName: added.sessionName, sessionId: added.sessionId, isNew: !added.seen } }
                    : {}),
            };
        });
    }

    /** One run, whole: its result and approval too, which the activity list leaves out. */
    public getRun(runId: string): RunRecord | null {
        return this.deps.store.get(runId) ?? null;
    }

    /**
     * End a running agent turn, as Ctrl+C would. The turn's own end then
     * fails the run ("It stopped before finishing: you stopped it."); when
     * no turn is running any more, nothing will report, so the run ends here.
     * An agent run that already ended — its turn beat the click — is left as
     * it ended.
     */
    public stop(runId: string): void {
        const run = this.deps.store.get(runId);
        if (run && isAgentRun(run) && TERMINAL_RUN_STATUSES.includes(run.status)) return;
        if (!run || run.status !== 'running' || !isAgentRun(run)) throw new Error(`Run ${runId} is not a running agent run.`);
        if (this.starting.has(runId)) {
            // No turn exists yet: remember, and end it the moment it does.
            this.stopRequested.add(runId);
            return;
        }
        const session = this.sessionOf(run);
        if (session && this.deps.stopAgent(session, 'you stopped it')) return;
        this.finish(runId, 'failed', { error: 'Stopped: its session was no longer running.' });
        void this.pump();
    }

    public snapshot(workspaceId: string): AutomationsSnapshot {
        const factory = this.factoryOf(workspaceId);
        const runs = this.deps.store
            .runs()
            .filter((run) => run.attribution.workspaceId === workspaceId)
            .map(toListEntry);
        // A place in the one line every workspace shares.
        const queue: Record<string, number> = {};
        this.queuedRuns().forEach((run, index) => {
            if (run.attribution.workspaceId === workspaceId) queue[run.id] = index + 1;
        });
        return {
            filePath: factory.file.filePath,
            fileExists: factory.loaded.exists,
            automations: this.list(workspaceId),
            issues: factory.loaded.spec.issues,
            runs,
            queue,
            suggestAssignedReviews: this.assignedReviewsSuggestion(workspaceId, factory),
            templates: this.templatesOf(workspaceId, factory),
        };
    }

    /**
     * Start queued agent runs while there is room: oldest first, each checked
     * once more right before it starts. Re-entrant calls fold into one more
     * pass rather than racing the one in progress.
     */
    private async pump(): Promise<void> {
        if (!this.started) return;
        if (this.pumping) {
            this.pumpAgain = true;
            return;
        }
        this.pumping = true;
        try {
            do {
                this.pumpAgain = false;
                for (const run of this.queuedRuns()) {
                    // The list was taken before the last launch was awaited:
                    // a run dismissed or dropped meanwhile is not in line.
                    if (this.deps.store.get(run.id)?.status !== 'queued') continue;
                    if (this.slotsInUse() >= this.capacity()) break;
                    const verdict = this.checkQueued(run);
                    if (!verdict.go) {
                        if (!verdict.wait) {
                            this.finish(run.id, verdict.status, verdict.status === 'failed' ? { error: verdict.message } : { summary: verdict.message });
                        }
                        continue;
                    }
                    await this.startAgentRun(run, verdict.item);
                }
            } while (this.pumpAgain);
        } finally {
            this.pumping = false;
        }
    }

    /**
     * Whether a queued run may start now. Its automation must still say the
     * same thing, and an event run's item must still be in the list — a
     * review the person did by hand while it waited is not done twice. An
     * item the runner cannot check yet (no Inbox since launch) waits.
     */
    private checkQueued(run: RunRecord): QueueVerdict {
        // A turn cut off by a quit resumes in its session, whatever the file
        // says now: it was approved, and it belongs to that conversation.
        if (run.sessionId) {
            const session = this.sessionOf(run);
            if (!session) return { go: false, status: 'rejected', message: 'Its session was closed.' };
            if (this.deps.hasLiveTerminal(session)) {
                return { go: false, status: 'rejected', message: 'You opened its session before Consola could resume it.' };
            }
            return { go: true };
        }
        const entry = this.entryOf(run);
        if (!entry) return { go: false, status: 'rejected', message: 'It is no longer in its workspace’s factory.yml.' };
        if (entry.problem) return { go: false, status: 'failed', message: `Not run: ${entry.problem}.` };
        if (entry.version !== run.actionVersion) {
            return { go: false, status: 'rejected', message: 'Its automation changed since it was queued.' };
        }
        const wanted = run.trigger.item;
        if (!wanted || !entry.event) return { go: true };
        const snapshot = this.deps.inboxSnapshot(entry.workspaceId);
        if (!snapshot || snapshot.fetchedAt === 0) return { go: false, wait: true };
        const item = snapshot.items.find((candidate) => entry.event!.keyOf(candidate) === wanted.key);
        // The set, not the filter: a queued review is not dropped for going back to draft.
        if (!item || !entry.event.inSet(item)) return { go: false, status: 'rejected', message: entry.event.goneReason };
        const byHand = this.startedByHand(entry, item, run.createdAt);
        if (byHand) return { go: false, status: 'rejected', message: `Already started by hand: “${byHand.name}”.` };
        return { go: true, item };
    }

    /**
     * Start a queued agent run. Its status is `running` from here until its
     * turn ends (`turnEnded`): the run is the turn, and what holds a slot.
     */
    private async startAgentRun(run: RunRecord, item: InboxItem | undefined): Promise<void> {
        // An interrupted run picked up again keeps the time it first started.
        this.deps.store.update(run.id, { status: 'running', startedAt: run.startedAt ?? this.iso(), updatedAt: this.iso() });
        this.broadcastRun(run.id);
        this.starting.add(run.id);
        try {
            if (run.sessionId) return await this.resumeAgentRun(run);
            await this.launchAgentRun(run, item);
        } finally {
            this.starting.delete(run.id);
            this.stopRequested.delete(run.id);
        }
    }

    /** Whether the run is still the one running: it may have ended, or its workspace been forgotten, while a launch was awaited. */
    private stillRunning(runId: string): boolean {
        return this.deps.store.get(runId)?.status === 'running';
    }

    /** A stop asked for while the turn was starting: end it now that there is one to end. */
    private honourStop(runId: string, session: Session): void {
        if (!this.stopRequested.delete(runId)) return;
        if (this.deps.stopAgent(session, 'you stopped it')) return; // Its exit records the stop.
        this.finish(runId, 'failed', { error: 'Stopped: its session was no longer running.' });
        void this.pump();
    }

    private async launchAgentRun(run: RunRecord, item: InboxItem | undefined): Promise<void> {
        const entry = this.entryOf(run)!;
        const agent = entry.agent!;
        const name = entry.automation.name;
        try {
            const session = await this.deps.launchAgent({
                workspaceId: entry.workspaceId,
                run: { id: run.id, automation: name },
                prompt: String(run.approval?.args.prompt ?? ''),
                ...(item
                    ? {
                          item: {
                              workItem: item.workItem,
                              title: item.title,
                              label: agent.label ?? name,
                              ...(agent.groupId ? { groupId: agent.groupId } : {}),
                              startedByHandSince: run.createdAt,
                          },
                      }
                    : { scopeId: agent.scope?.id }),
            });
            if (!this.stillRunning(run.id)) return;
            const scopePath = this.deps
                .getWorkspaces()
                .find((workspace) => workspace.id === entry.workspaceId)
                ?.scopes.find((scope) => scope.id === session.scopeId)?.path;
            this.deps.store.update(run.id, {
                sessionId: session.id,
                conversation: {
                    harnessId: session.harnessId,
                    id: session.claudeSessionId,
                    cwd: session.cwd ?? scopePath ?? agent.scope?.path,
                },
                summary: runningIn(session.name),
                updatedAt: this.iso(),
            });
            this.broadcastRun(run.id);
            this.honourStop(run.id, session);
        } catch (error) {
            // The person got there first: nothing failed, the review exists.
            if (error instanceof StartedByHandError) {
                this.finish(run.id, 'rejected', { summary: error.message });
                return;
            }
            this.finish(run.id, 'failed', { error: describeError(error) });
            this.notify(`${name} could not start`, describeError(error), run.id);
        }
    }

    /** Pick an interrupted turn up where it stopped. Needs its session, never its entry, which may be gone. */
    private async resumeAgentRun(run: RunRecord): Promise<void> {
        const session = this.sessionOf(run);
        try {
            if (!session) throw new Error('Its session was closed.');
            await this.deps.resumeAgent(session, INTERRUPTED_PROMPT);
            if (!this.stillRunning(run.id)) return;
            this.deps.store.update(run.id, { summary: runningIn(session.name), updatedAt: this.iso() });
            this.broadcastRun(run.id);
            this.honourStop(run.id, session);
        } catch (error) {
            this.finish(run.id, 'failed', { error: describeError(error) });
            this.notify(`${run.automationId} could not continue`, describeError(error), run.id);
        }
    }

    /** The session an agent run started, while its workspace still has it. */
    private sessionOf(run: RunRecord): Session | undefined {
        if (!run.sessionId) return undefined;
        return this.deps
            .getWorkspaces()
            .find((workspace) => workspace.id === run.attribution.workspaceId)
            ?.sessions.find((session) => session.id === run.sessionId);
    }

    /**
     * Oldest in line first, by when each joined the queue — after the turns
     * a quit interrupted, which were already running and go back first.
     */
    private queuedRuns(): RunRecord[] {
        return this.deps.store
            .runs()
            .filter((run) => run.status === 'queued')
            .reverse()
            .sort((a, b) => {
                if (!!a.sessionId !== !!b.sessionId) return a.sessionId ? -1 : 1;
                return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
            });
    }

    /** Agent runs whose turn is running, or being launched: each is one process. */
    private slotsInUse(): number {
        return this.deps.store.runs().filter((run) => run.status === 'running' && isAgentRun(run)).length;
    }

    private capacity(): number {
        return this.deps.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS;
    }

    /**
     * A session the person started on this item with the same action since
     * `sinceIso` — the review they clicked before the automation got to it.
     */
    private startedByHand(entry: Resolved, item: InboxItem, sinceIso: string): Session | undefined {
        const label = entry.agent?.label;
        if (!label) return undefined;
        const since = Date.parse(sinceIso);
        return this.deps
            .getWorkspaces()
            .find((workspace) => workspace.id === entry.workspaceId)
            ?.sessions.find(
                (session) =>
                    !session.automation &&
                    sameWorkItem(session.workItem, item.workItem) &&
                    session.workItemAction === label &&
                    session.createdAt > since
            );
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
        this.deps.store.update(run.id, { status: 'running', startedAt: this.iso(), updatedAt: this.iso() });
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
        this.resolveAll(workspaceId, factory);
        return true;
    }

    private resolveAll(workspaceId: string, factory: WorkspaceFactory): void {
        factory.resolved = factory.loaded.spec.automations.map((automation) => this.resolve(workspaceId, automation));
    }

    /**
     * Forget schedules and lists no file names any more, and start each new
     * schedule now: it never fires for an occurrence that passed before it
     * existed.
     */
    private settleSchedules(): void {
        const resolved = this.allResolved();
        const keys = new Set(resolved.filter(cronOf).map(scheduleKey));
        this.deps.store.keepSchedules(keys);
        for (const key of keys) {
            if (!this.deps.store.lastFired(key)) this.deps.store.setLastFired(key, this.iso());
        }
        // A file that did not load cleanly may be hiding an entry behind a
        // typo: its workspace's lists are kept until the file says otherwise,
        // so fixing the typo catches up instead of starting from scratch.
        // An agent's addition is kept the same way, so its mark survives too.
        const kept = new Set(resolved.filter((entry) => entry.automation.trigger.kind === 'event').map(automationKey));
        const named = new Set(resolved.map(automationKey));
        for (const [workspaceId, factory] of this.factories) {
            if (factory.loaded.spec.issues.length === 0) continue;
            for (const key of this.deps.store.seenKeys()) if (key.startsWith(`${workspaceId} `)) kept.add(key);
            for (const key of this.deps.store.addedKeys()) if (key.startsWith(`${workspaceId} `)) named.add(key);
        }
        this.deps.store.keepSeen(kept);
        this.deps.store.keepAdded(named);
    }

    private allResolved(): Resolved[] {
        return [...this.factories.values()].flatMap((factory) => factory.resolved);
    }

    private factoryOf(workspaceId: string): WorkspaceFactory {
        const factory = this.factories.get(workspaceId);
        if (!factory) throw new Error(`No workspace ${workspaceId}.`);
        return factory;
    }

    private entryOf(run: RunRecord): Resolved | undefined {
        return this.factories
            .get(run.attribution.workspaceId ?? '')
            ?.resolved.find((candidate) => candidate.automation.name === run.automationId);
    }

    /**
     * What an entry resolves to in its workspace, or why it cannot run. Which
     * tools, actions, scopes, connections and events exist is the runner's to
     * say; each problem names the one that was asked for.
     */
    private resolve(workspaceId: string, automation: Automation): Resolved {
        const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
        const base = automationVersion(automation);
        const unable = (problem: string): Resolved => ({ workspaceId, automation, version: base, problem });
        const { run, trigger } = automation;

        let event: EventSource | undefined;
        if (trigger.kind === 'event') {
            const resolution = resolveEventSource(trigger, automation.filter);
            if (!resolution.ok) return unable(resolution.problem);
            event = resolution.source;
            if (run.kind === 'tool') {
                return unable('tools run on a schedule; an event starts an agent session (`run: { action: … }` or `run: { prompt: … }`)');
            }
            if (workspace?.provider?.id !== trigger.connection) {
                return unable(`this workspace has no ${trigger.connection} account bound; bind one in its settings`);
            }
            if (event.itemsHaveRepo && automation.scope) {
                return unable(`scope: a ${trigger.connection} item runs in a worktree of its own repository, so it takes no scope`);
            }
            if (!event.itemsHaveRepo && !automation.scope) {
                return unable(`scope: ${trigger.connection} items have no repository, so say which scope this runs in`);
            }
        }

        if (run.kind === 'tool') {
            if (run.namespace !== CONSOLA_NAMESPACE) {
                return unable(`unknown tool namespace "${run.namespace}"; only consola# tools exist today`);
            }
            const tool = this.deps.registry.get(run.tool);
            if (!tool) return unable(`there is no Consola tool named "${run.tool}"`);
            if (!tool.automatable) return unable(`${run.ref} cannot be run by an automation`);
            const validated = this.deps.registry.validate(tool, run.with);
            if (!validated.ok) return unable(`with: ${validated.error}`);
            return { workspaceId, automation, version: base, tool, args: validated.args };
        }

        if (run.kind === 'action') {
            const action = workspace?.actions.find((candidate) => candidate.name === run.name);
            if (!action) return unable(`no action named ${run.name} in this workspace`);
            if (event && !action.appliesTo.includes(event.itemType)) {
                return unable(`the ${run.name} action does not apply to ${event.itemType === 'pr' ? 'pull requests' : 'issues'}`);
            }
            const refused = this.harnessProblem(workspaceId);
            if (refused) return unable(refused);
            return {
                workspaceId,
                automation,
                // The body lives in settings, not the file: editing it asks again.
                version: automationVersion(automation, action.prompt),
                event,
                agent: {
                    body: action.prompt,
                    label: action.name,
                    ...(action.groupId ? { groupId: action.groupId } : {}),
                    runs: `${action.name} action`,
                },
            };
        }

        let scope: Scope | undefined;
        if (automation.scope) {
            scope = workspace?.scopes.find((candidate) => candidate.name === automation.scope);
            if (!scope) {
                const names = workspace?.scopes.map((candidate) => candidate.name).join(', ');
                return unable(`no scope named "${automation.scope}" in this workspace${names ? `; it has: ${names}` : ''}`);
            }
        }
        const refused = this.harnessProblem(workspaceId);
        if (refused) return unable(refused);
        return {
            workspaceId,
            automation,
            version: base,
            event,
            agent: { body: run.prompt, ...(event ? { label: automation.name } : {}), ...(scope ? { scope } : {}), runs: 'Prompt' },
        };
    }

    /** Why the workspace's default harness cannot run an agent entry, as the entry's problem; null when it can. */
    private harnessProblem(workspaceId: string): string | null {
        const { name, problem } = this.deps.agentHarness(workspaceId);
        return problem ? `${name} can’t run read-only automation sessions: ${problem.replace(/\.$/, '')}` : null;
    }

    /** An automation acts on its own workspace, as itself. */
    private contextFor(entry: Resolved): ToolContext {
        return {
            caller: { kind: 'automation', automation: entry.automation.name },
            scope: { workspaceIds: [entry.workspaceId], excludeSessionIds: [] },
        };
    }

    private nextDue(entry: Resolved, now: Date): Date | null {
        const cron = cronOf(entry);
        if (!cron) return null;
        const last = this.deps.store.lastFired(scheduleKey(entry));
        return nextCronOccurrence(cron.cron, last ? new Date(last) : now);
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
        if (entry.agent) return this.fireAgent(entry, trigger);
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
                    this.deps.store.update(run.id, { startedAt: this.iso() });
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
     * A scheduled or requested agent run, which has no item: its session
     * starts in the automation's scope. One waits at a time — a queued run
     * is what the next occurrence would have been.
     */
    private fireAgent(entry: Resolved, trigger: RunTrigger): RunRecord {
        const agent = entry.agent!;
        const lined = this.deps.store.runs().find((run) => isRunOf(run, entry) && (run.status === 'queued' || run.status === 'running'));
        if (lined) return lined;
        const scopeName = agent.scope?.name ?? '';
        const prompt = scheduledPrompt(agent.body, entry.automation.name, scopeName);
        const preview: AgentRunPreview = { kind: 'agent-run', runs: agent.runs, prompt, scope: scopeName };
        return this.recordAgentRun(entry, trigger, preview, `${agent.runs} in ${scopeName}`);
    }

    /** One event — an item entering an automation's list — made one run. */
    private fireEvent(entry: Resolved, item: InboxItem, since: string, at: string): void {
        const event = entry.event!;
        const agent = entry.agent!;
        const itemKey = event.keyOf(item);
        // One at a time per (automation, item); items run side by side.
        const open = this.deps.store
            .runs()
            .some((run) => isRunOf(run, entry) && run.trigger.item?.key === itemKey && OPEN_STATUSES.includes(run.status));
        if (open) return;
        const trigger: RunTrigger = {
            kind: 'event',
            at,
            connection: event.connection,
            events: event.eventsOf(item),
            item: { key: itemKey, url: item.url, title: item.title },
        };
        const described = event.describeItem(item);
        const byHand = this.startedByHand(entry, item, since);
        if (byHand) {
            const run = this.newRun(entry, trigger, entry.automation.mode);
            const now = this.iso();
            this.deps.store.add({ ...run, status: 'rejected', summary: `Already started by hand: “${byHand.name}”.`, finishedAt: now });
            this.broadcast(entry.workspaceId);
            return;
        }
        const preview: AgentRunPreview = {
            kind: 'agent-run',
            runs: agent.runs,
            prompt: event.renderPrompt(agent.body, item, entry.automation.name),
            item: { url: item.url, title: item.title, author: item.author, label: described },
        };
        this.recordAgentRun(entry, trigger, preview, described);
    }

    /** The bookkeeping every agent run shares: queued, waiting for a person, or only reported. */
    private recordAgentRun(entry: Resolved, trigger: RunTrigger, preview: AgentRunPreview, described: string): RunRecord {
        const { automation } = entry;
        const { mode, asks } = this.effectiveMode(entry, trigger);
        const base = this.newRun(entry, trigger, mode);
        const now = this.iso();
        // The prompt approval sends is the one the preview showed.
        const run: RunRecord = { ...base, result: preview, approval: { args: { prompt: preview.prompt } } };
        if (mode === 'notify') {
            this.deps.store.add({ ...run, status: 'completed', summary: `${described}. Nothing started (notify).`, finishedAt: now });
            this.notify(automation.name, `${described}.`, run.id);
        } else if (mode === 'confirm') {
            if (!trigger.item) this.supersedeWaiting(entry, run.id);
            const summary = `${entry.agent!.runs}: ${described}.${asks ? ` ${asks}` : ''}`;
            this.deps.store.add({ ...run, status: 'needs-approval', summary });
            this.deps.notify({
                title: `${automation.name} needs your approval`,
                body: `${summary} Review it in Consola.`,
                runId: run.id,
                workspaceId: entry.workspaceId,
                needsApproval: true,
            });
        } else {
            this.deps.store.add({ ...run, status: 'queued', summary: `${entry.agent!.runs}: ${described}.` });
        }
        this.broadcast(entry.workspaceId);
        void this.pump();
        return this.deps.store.get(run.id)!;
    }

    /**
     * One run at a time per key (an automation's key; a request's own id),
     * with the bookkeeping every tool run shares.
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
        // A failed agent run's launch-time "Running in …" says nothing true any more.
        const stale = status === 'failed' && !outcome.summary ? sessionRunningIn(this.deps.store.get(runId)) : null;
        this.deps.store.update(runId, {
            status,
            ...(stale !== null ? { summary: `Did not finish in “${stale}”.` } : {}),
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

/** What an entry runs, in words: "Review action", "Prompt", "Tool: cleanup_stale_sessions". */
function describeRun(automation: Automation): string {
    const { run } = automation;
    if (run.kind === 'tool') return `Tool: ${run.tool}`;
    return run.kind === 'action' ? `${run.name} action` : 'Prompt';
}

/** What an agent run says while its turn runs. */
function runningIn(sessionName: string): string {
    return `Running in “${sessionName}”.`;
}

/** The session an agent run's summary still says it is running in; null once it says anything else. */
function sessionRunningIn(run: RunRecord | undefined): string | null {
    if (!run || !isAgentRun(run)) return null;
    return /^Running in “(.*)”\.$/.exec(run.summary ?? '')?.[1] ?? null;
}

/** A run that starts a session: its result is the preview of what it starts. */
function isAgentRun(run: RunRecord): boolean {
    return (run.result as { kind?: unknown } | undefined)?.kind === 'agent-run';
}

/**
 * A run as the activity list shows it: its kind, and its result only while
 * it waits for a person or a slot. Everything else is `getRun`'s.
 */
function toListEntry(run: RunRecord): RunListEntry {
    const { result, approval: _approval, ...rest } = run;
    const kind = isAgentRequest(run) ? 'request' : isAgentRun(run) ? 'agent' : 'tool';
    return { ...rest, kind, ...(run.status === 'needs-approval' || run.status === 'queued' ? { result } : {}) };
}

/** A problem with one entry, rather than with the file as a whole. */
function isEntryIssue(issue: FactorySpecIssue): boolean {
    return issue.path.startsWith('automations[');
}

/** An issue as a reason: where it is, then what is wrong. */
function describeIssue(issue: FactorySpecIssue): string {
    const where = issue.path || (issue.line ? `line ${issue.line}` : '');
    return where ? `${where}: ${issue.message}` : issue.message;
}

/** A save refused, with every reason: what the agent reads and acts on. */
function notSaved(reasons: string[]): Error {
    return new Error(`Not saved: ${reasons.map((reason) => reason.trim().replace(/\.$/, '')).join('; ')}.`);
}

/** An event trigger that did not resolve, said as written. */
function describeTriggerAsWritten(automation: Automation): string {
    const { trigger } = automation;
    return trigger.kind === 'event' ? `${trigger.connection}: ${trigger.events.join(', ')}` : trigger.cron;
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
