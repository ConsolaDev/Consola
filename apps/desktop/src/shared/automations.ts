import type { RunRecord } from '@consola/factory-spec';

export type { AutomationMode, FactorySpecIssue, RunRecord } from '@consola/factory-spec';
import type { RunConversation } from './conversation';
import type { Session } from './workspace';
import type { AgentRunPreview, AutomationsSnapshot } from '@consola/automation-engine';
export type {
    AutomationView,
    TemplateView,
    TemplateService,
    TemplateNeedSection,
    TemplateNeed,
    TemplatePreview,
    SavedAutomation,
    RunKind,
    RunListEntry,
    AgentRunPreview,
    AutomationsSnapshot,
} from '@consola/automation-engine';

/** What a new automation's session starts from: one of the file's entries, or a template. */
export type AuthoringBasis = { automation: string } | { template: string };

/** "New automation", "Change with agent" and "Customize…": a session that writes an entry with the person. */
export interface AuthoringRequest {
    workspaceId: string;
    /** The person's own words: what it should do, and when. Empty only with a basis. */
    description: string;
    /** The scope the session starts in; the workspace's first when absent or unknown. */
    scopeId?: string;
    basis?: AuthoringBasis;
}

export function isAgentRunPreview(value: unknown): value is AgentRunPreview {
    return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'agent-run';
}

/**
 * The automations surface of preload. Each workspace has its own factory.yml;
 * main owns the runner, and the renderer reads one workspace's snapshot and
 * sends intents — run, approve, dismiss, open the file.
 */
export interface AutomationsAPI {
    getSnapshot: (workspaceId: string) => Promise<AutomationsSnapshot>;
    /** Run now; for an event automation, check now — null, since only what is new fires. */
    runNow: (workspaceId: string, name: string) => Promise<RunRecord | null>;
    approve: (runId: string) => Promise<RunRecord>;
    /** Turn down a run waiting for approval, or take a queued one out of the line. */
    dismiss: (runId: string) => Promise<RunRecord>;
    openFile: (workspaceId: string) => Promise<void>;
    /** Add review-assigned-prs to the workspace's factory.yml, creating the file when it is missing. */
    addAssignedReviews: (workspaceId: string) => Promise<void>;
    /** One run's full record; null once history has dropped it. */
    getRun: (runId: string) => Promise<RunRecord | null>;
    /** A run's part of its conversation, read from the transcript; never starts or resumes anything. */
    readConversation: (runId: string) => Promise<RunConversation>;
    stop: (runId: string) => Promise<void>;
    /** Add a ready-made automation to the workspace's factory.yml. */
    addTemplate: (workspaceId: string, templateId: string) => Promise<void>;
    /** Start the session that drafts an entry with the person. */
    startAuthoring: (request: AuthoringRequest) => Promise<Session>;
    /** The person has seen an automation an agent added. */
    acknowledge: (workspaceId: string, name: string) => Promise<void>;
    /** One entry exactly as factory.yml has it (`- name: …`); null when there is no such entry or no file. */
    getEntry: (workspaceId: string, name: string) => Promise<string | null>;
    onChanged: (callback: (change: AutomationsChange) => void) => () => void;
}

/** One workspace's automations changed: pushed to every window, each showing the ones it is open on. */
export interface AutomationsChange {
    workspaceId: string;
    snapshot: AutomationsSnapshot;
}

/** Whether the workspace's Assistant asked for this run: its own request, or an automation it fired. */
export function isAssistantRequest(run: RunRecord, assistantSessionId: string): boolean {
    return run.trigger.actorId === assistantSessionId;
}

/** What the Assistant asked for that is still waiting for a person, in the order given (newest first). */
export function waitingAssistantRequests(
    runs: readonly RunRecord[],
    assistantSessionId: string | undefined
): RunRecord[] {
    if (!assistantSessionId) return [];
    return runs.filter((run) => run.status === 'needs-approval' && isAssistantRequest(run, assistantSessionId));
}

/** An automation's name; for an agent's request, what it asks to do ("Delete session"). */
export function runTitle(run: RunRecord): string {
    if (run.source !== 'manual') return run.automationId;
    const words = run.actionName.replace(/^consola#/, '').replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}
