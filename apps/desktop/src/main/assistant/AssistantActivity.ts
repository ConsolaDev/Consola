import type { AssistantActivitySnapshot } from '../../shared/types';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Session, Workspace } from '../../shared/workspace';

/** How long a session must stay quiet before it counts as finished. */
export const SETTLE_MS = 4_000;
/** Notices landing within this window of the first are sent as one line. */
export const COALESCE_MS = 5_000;

const MAX_NAME_LENGTH = 60;

export interface AssistantActivityDeps {
    getWorkspaces(): Workspace[];
    /** False when the Assistant has no live process; nothing here may start one. */
    queuePrompt(instanceId: string, prompt: string): boolean;
    broadcast(workspaceId: string, activity: AssistantActivitySnapshot): void;
}

interface Watch {
    assistantSessionId: string;
    workspaceId: string;
    /** A session that was ready when prompted has not yet reacted to the prompt. */
    seenWorking: boolean;
    timer?: NodeJS.Timeout;
}

interface Entry {
    sessionId: string;
    /** `"<name>" <is ready | needs you | has exited>` */
    text: string;
}

const VERDICT: Record<'ready' | 'needs-attention' | 'exited', string> = {
    ready: 'is ready',
    'needs-attention': 'needs you',
    exited: 'has exited',
};

/**
 * Session names come from PR titles, which anyone can write, and a notice
 * becomes a pasted prompt in the Assistant. Keep the name to one short quoted
 * run so it cannot close the quote, start a new line or carry a paragraph.
 */
function quoteName(name: string): string {
    const flat = name.replace(/\s+/g, ' ').trim().replace(/"/g, '’');
    const cut = flat.length > MAX_NAME_LENGTH ? `${flat.slice(0, MAX_NAME_LENGTH - 1)}…` : flat;
    return `"${cut}"`;
}

/**
 * Hears back from the sessions the Assistant prompted or started. When one
 * settles it queues a one-line notice into the Assistant, and keeps a count
 * of what finished unseen for the sidebar. Watches live for this app run only.
 */
export class AssistantActivity {
    private readonly watches = new Map<string, Watch>();
    private readonly touched = new Map<string, Set<string>>();
    private readonly unseen = new Map<string, number>();
    private readonly pending = new Map<string, { entries: Entry[]; timer: NodeJS.Timeout }>();

    constructor(private readonly deps: AssistantActivityDeps) {}

    /** Called after each prompt or start. A new watch replaces the old one: one notice per prompt. */
    watch(assistantSessionId: string, targetSessionId: string): void {
        const workspace = this.deps.getWorkspaces().find((w) => w.sessions.some((s) => s.id === assistantSessionId));
        if (!workspace || assistantSessionId === targetSessionId) return;
        if (!workspace.sessions.some((s) => s.id === targetSessionId)) return;

        const old = this.watches.get(targetSessionId);
        if (old?.timer) clearTimeout(old.timer);
        this.watches.set(targetSessionId, { assistantSessionId, workspaceId: workspace.id, seenWorking: false });

        const set = this.touched.get(workspace.id) ?? new Set<string>();
        const added = !set.has(targetSessionId);
        set.add(targetSessionId);
        this.touched.set(workspace.id, set);
        if (added) this.emit(workspace.id);
    }

    statusChanged(instanceId: string, status: TerminalStatus): void {
        const found = this.findByInstance(instanceId);
        const watch = found && this.watches.get(found.session.id);
        if (!found || !watch) return;
        const targetId = found.session.id;

        if (status === 'working') {
            watch.seenWorking = true;
            this.clearTimer(watch);
        } else if (status === 'exited') {
            this.settle(targetId, status);
        } else if (status === 'needs-attention' || watch.seenWorking) {
            // `ready` before any work is the state the prompt found it in.
            this.clearTimer(watch);
            watch.timer = setTimeout(() => this.settle(targetId, status), SETTLE_MS);
            watch.timer.unref?.();
        }
    }

    snapshot(workspaceId: string): AssistantActivitySnapshot {
        const workspace = this.deps.getWorkspaces().find((w) => w.id === workspaceId);
        const live = new Set(workspace?.sessions.map((s) => s.id));
        return {
            touchedSessionIds: [...(this.touched.get(workspaceId) ?? [])].filter((id) => live.has(id)),
            unseenFinished: this.unseen.get(workspaceId) ?? 0,
        };
    }

    markSeen(workspaceId: string): void {
        if (!this.unseen.get(workspaceId)) return;
        this.unseen.delete(workspaceId);
        this.emit(workspaceId);
    }

    private settle(targetId: string, status: 'ready' | 'needs-attention' | 'exited'): void {
        const watch = this.watches.get(targetId);
        if (!watch) return;
        this.clearTimer(watch);
        this.watches.delete(targetId);

        this.unseen.set(watch.workspaceId, (this.unseen.get(watch.workspaceId) ?? 0) + 1);
        this.emit(watch.workspaceId);

        const target = this.findById(targetId)?.session;
        const batch = this.pending.get(watch.assistantSessionId) ?? {
            entries: [],
            timer: setTimeout(() => this.flush(watch.assistantSessionId), COALESCE_MS),
        };
        batch.timer.unref?.();
        batch.entries.push({ sessionId: targetId, text: `${quoteName(target?.name ?? targetId)} ${VERDICT[status]}` });
        this.pending.set(watch.assistantSessionId, batch);
    }

    private flush(assistantSessionId: string): void {
        const batch = this.pending.get(assistantSessionId);
        this.pending.delete(assistantSessionId);
        const assistant = this.findById(assistantSessionId)?.session;
        if (!batch || !assistant) return;

        const [only] = batch.entries;
        const line =
            batch.entries.length === 1
                ? `[consola] ${only.text} — read it with consola_read_session (session_id: ${only.sessionId}).`
                : `[consola] ${batch.entries.map((e) => `${e.text} (session_id: ${e.sessionId})`).join('; ')} — read them with consola_read_session.`;
        // A stopped Assistant drops the notice; the unseen count carries it.
        this.deps.queuePrompt(assistant.instanceId, line);
    }

    private emit(workspaceId: string): void {
        this.deps.broadcast(workspaceId, this.snapshot(workspaceId));
    }

    private clearTimer(watch: Watch): void {
        if (watch.timer) clearTimeout(watch.timer);
        watch.timer = undefined;
    }

    private findById(sessionId: string): { session: Session } | undefined {
        for (const workspace of this.deps.getWorkspaces()) {
            const session = workspace.sessions.find((s) => s.id === sessionId);
            if (session) return { session };
        }
        return undefined;
    }

    private findByInstance(instanceId: string): { session: Session } | undefined {
        for (const workspace of this.deps.getWorkspaces()) {
            const session = workspace.sessions.find((s) => s.instanceId === instanceId);
            if (session) return { session };
        }
        return undefined;
    }
}
