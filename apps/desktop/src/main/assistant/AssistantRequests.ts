import { isAssistantRequest, runTitle, type RunRecord } from '../../shared/automations';
import { assistantSession, type Session, type Workspace } from '../../shared/workspace';
import { quoteName } from './AssistantActivity';

export interface AssistantRequestsDeps {
    getWorkspaces(): Workspace[];
    /** One line for the Assistant, batched with its other notices (AssistantActivity.report). */
    report(assistantSessionId: string, text: string): void;
    /** Hear back when a session it caused to start settles (AssistantActivity.watch). */
    watch(assistantSessionId: string, sessionId: string): void;
}

interface Tracked {
    workspaceId: string;
    assistantSessionId: string;
    /** What the run said while it waited: a different summary on rejection is the reason it was not run. */
    waitingSummary: string;
}

const MAX_CLAUSE = 200;

/**
 * Text Consola did not write — summaries carry session names, which come from
 * PR titles — made one short clause of a notice line: one line, no closing
 * period, capped, and with no straight quote left to close the title's quotes
 * and carry on in Consola's voice (as `quoteName` does for names).
 */
export function clause(text: string, max = MAX_CLAUSE): string {
    const flat = text.replace(/\s+/g, ' ').replace(/"/g, '’').trim().replace(/[.\s]+$/, '');
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What the Assistant is told when one of its requests stops waiting, or null
 * while there is nothing to tell yet: waiting, queued for a slot, or running
 * before an outcome.
 */
export function requestOutcome(waitingSummary: string, run: RunRecord, startedIn?: Session): string | null {
    const title = quoteName(runTitle(run));
    const ref = `(run_id: ${run.id})`;
    switch (run.status) {
        case 'completed':
            return `You approved ${title} ${ref}: ${clause(run.summary ?? '')}`;
        case 'failed':
            return `You approved ${title} ${ref}, but it failed: ${clause(run.error ?? run.summary ?? '')}`;
        case 'rejected':
            return run.summary === waitingSummary
                ? `You dismissed ${title} ${ref}`
                : `${title} ${ref} was not run: ${clause(run.summary ?? '')}`;
        case 'running':
            if (!run.sessionId || !startedIn) return null;
            return `You started ${title} ${ref}; it runs in ${quoteName(startedIn.name)} (session_id: ${startedIn.id})`;
        default:
            return null;
    }
}

/**
 * Tells the Assistant what the person decided about what it asked for.
 *
 * Fed every automations snapshot main broadcasts, it notices an
 * Assistant-asked run leaving `needs-approval` — approved in its tray or in
 * Settings, dismissed, superseded, failed — and reports it exactly once.
 * Only runs it saw waiting are reported, so history never replays.
 */
export class AssistantRequests {
    private readonly tracked = new Map<string, Tracked>();

    constructor(private readonly deps: AssistantRequestsDeps) {}

    /** Never throws: it runs inside the automation runner's broadcast, which must not fail a run over a notice. */
    observe(workspaceId: string, runs: readonly RunRecord[]): void {
        try {
            this.track(workspaceId, runs);
        } catch (error) {
            console.error('Could not tell the Assistant about its requests.', error);
        }
    }

    private track(workspaceId: string, runs: readonly RunRecord[]): void {
        const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
        const assistant = workspace && assistantSession(workspace);
        const present = new Set<string>();

        for (const run of runs) {
            if (run.attribution.workspaceId !== workspaceId) continue;
            present.add(run.id);
            const tracked = this.tracked.get(run.id);
            if (!tracked) {
                if (assistant && run.status === 'needs-approval' && isAssistantRequest(run, assistant.id)) {
                    this.tracked.set(run.id, {
                        workspaceId,
                        assistantSessionId: assistant.id,
                        waitingSummary: run.summary ?? '',
                    });
                }
                continue;
            }
            if (run.status === 'needs-approval') {
                tracked.waitingSummary = run.summary ?? '';
                continue;
            }
            const startedIn = run.sessionId
                ? workspace?.sessions.find((candidate) => candidate.id === run.sessionId)
                : undefined;
            const outcome = requestOutcome(tracked.waitingSummary, run, startedIn);
            if (!outcome) continue;
            this.tracked.delete(run.id);
            this.deps.report(tracked.assistantSessionId, outcome);
            if (run.status === 'running' && startedIn) this.deps.watch(tracked.assistantSessionId, startedIn.id);
        }

        // Gone from history without an outcome seen: nothing honest to say.
        for (const [runId, tracked] of this.tracked) {
            if (tracked.workspaceId === workspaceId && !present.has(runId)) this.tracked.delete(runId);
        }
    }
}
