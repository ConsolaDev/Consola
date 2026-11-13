import { createHash } from 'crypto';
import type { Automation, AutomationMode } from './schema';

/**
 * One execution of an automation.
 *
 * The north-star Run record (docs/north-star/consola-factories.md §3), as
 * much of it as a local run has. Same field names and status words, so the
 * cloud runner's rows and these list side by side later. Not recorded yet,
 * and why: `cost` (a tool run spends no tokens; an agent run's tokens are its
 * session's), `environment` (the workspace scope is in `attribution` until
 * environments exist locally), `orgId` (personal automations have no org).
 */
export type RunStatus = 'queued' | 'running' | 'needs-approval' | 'completed' | 'failed' | 'rejected';

/** The runner set grows (an Anthropic-hosted one, say); nothing may assume two values. */
export type RunnerKind = 'local' | 'cloud' | (string & {});

export type RunSource = 'org' | 'repo' | 'personal' | 'manual';

/** The item an event run is about, as the connection reported it. */
export interface RunItem {
    /** The connection's stable key for it, e.g. `github:acme/api:pr:123`. */
    key: string;
    url: string;
    /** Author-controlled: shown as data, never sent as instructions. */
    title: string;
}

export interface RunTrigger {
    /** What fired it: the schedule, a connection's event, or a request outside both. */
    kind: 'cron' | 'event' | 'manual';
    /** ISO time: the scheduled occurrence, the poll that saw the event, or the request. */
    at: string;
    /** A cron occurrence missed while the runner was down, fired late. */
    catchUp?: boolean;
    /** Who asked, for a manual run. Agents never get `auto`. */
    by?: 'person' | 'agent';
    /** The asking session, when an agent asked. */
    actorId?: string;
    /** For an event: which connection, which of its listed events the item was in, and the item. */
    connection?: string;
    events?: string[];
    item?: RunItem;
}

export interface RunRecord {
    id: string;
    runner: RunnerKind;
    source: RunSource;
    /**
     * The automation's name: its identity in a personal file. A `manual` run
     * no automation made — an agent's call waiting for a person — carries
     * its tool reference here instead.
     */
    automationId: string;
    /** What it runs: a tool reference, an action's name, or `prompt`. */
    actionName: string;
    /** `automationVersion` of the definition this run executed. */
    actionVersion: string;
    /** The mode this run used — `confirm` even for an `auto` entry when it had to ask. */
    mode: AutomationMode;
    trigger: RunTrigger;
    status: RunStatus;
    /** One human sentence: "Removed 3 sessions; 1 kept." */
    summary?: string;
    /** The target's structured result, small enough to keep in history. */
    result?: unknown;
    /**
     * For `needs-approval`: the exact arguments approval executes — the
     * preview narrowed to what the person saw, never a fresh plan.
     */
    approval?: { args: Record<string, unknown> };
    /** The agent session the run started, once it launched. */
    sessionId?: string;
    /**
     * When a person approved it: the end of its wait for them. An approved
     * agent run waits for a slot from here, so a run's wait splits into the
     * two. Absent for a run that never asked, or from before it was recorded.
     */
    approvedAt?: string;
    /**
     * When the run started working: its tool's `run` call, or its agent
     * session's turn. Duration counts from here, not from `createdAt`, which
     * also covers time spent waiting for a person or a slot.
     */
    startedAt?: string;
    /**
     * The session's conversation, recorded at launch so the run stays
     * readable after the session is removed.
     */
    conversation?: { harnessId: string; id: string; cwd?: string };
    error?: string;
    attribution: {
        automationId: string;
        actionName: string;
        triggerKind: RunTrigger['kind'];
        workspaceId?: string;
        actorId?: string;
    };
    createdAt: string;
    updatedAt: string;
    finishedAt?: string;
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'rejected'];

/**
 * A short, stable hash of what an automation does — what approval binds to:
 * an approved plan is refused if the definition changed under it, and an
 * `auto` entry is trusted to run unasked only at the version a person
 * approved.
 *
 * Covers the target and its arguments or body, the mode, the filter and
 * scope (which items, and where), and an event trigger (what fires it). Not
 * a cron schedule, which says when rather than what, and not the workspace,
 * which is where the file lives rather than something it says.
 *
 * `resolvedBody` is what the runner resolved the target to — an action's
 * prompt, which lives in the workspace's settings rather than the file — so
 * editing the Review action makes an `auto` automation that runs it ask
 * again.
 */
export function automationVersion(
    automation: Pick<Automation, 'run' | 'mode' | 'trigger'> & Partial<Pick<Automation, 'filter' | 'scope'>>,
    resolvedBody?: string
): string {
    const { trigger } = automation;
    const canonical = stableStringify({
        run: automation.run,
        mode: automation.mode,
        filter: automation.filter,
        scope: automation.scope,
        event:
            trigger.kind === 'event'
                ? { connection: trigger.connection, events: trigger.events, params: trigger.params }
                : undefined,
        resolvedBody,
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** JSON with sorted keys and undefined dropped, so equal definitions hash equal. */
export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
