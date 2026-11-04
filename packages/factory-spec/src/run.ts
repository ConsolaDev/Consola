import { createHash } from 'crypto';
import type { Automation, AutomationMode } from './schema';

/**
 * One execution of an automation.
 *
 * The north-star Run record (docs/north-star/consola-factories.md §3), as
 * much of it as a local tool run has. Same field names and status words, so
 * the cloud runner's rows and these list side by side later. Not recorded
 * yet, and why: `cost` (a tool run spends no tokens; agent actions will),
 * `environment` (the workspace scope is in `attribution` until environments
 * exist locally), `orgId` (personal automations have no org).
 */
export type RunStatus = 'running' | 'needs-approval' | 'completed' | 'failed' | 'rejected';

/** The runner set grows (an Anthropic-hosted one, say); nothing may assume two values. */
export type RunnerKind = 'local' | 'cloud' | (string & {});

export type RunSource = 'org' | 'repo' | 'personal' | 'manual';

export interface RunTrigger {
    /** What fired it: the schedule, or a request outside it. */
    kind: 'cron' | 'manual';
    /** ISO time: the scheduled occurrence for cron, the request for manual. */
    at: string;
    /** A cron occurrence missed while the runner was down, fired late. */
    catchUp?: boolean;
    /** Who asked, for a manual run. Agents never get `auto`. */
    by?: 'person' | 'agent';
    /** The asking session, when an agent asked. */
    actorId?: string;
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
    /** The `run:` reference as written, e.g. `consola#cleanup_stale_sessions`. */
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
 * A short, stable hash of what an automation does: target, arguments,
 * workspace and mode — not its schedule. What approval binds to: an approved
 * plan is refused if the definition changed under it, and an `auto` entry is
 * trusted to run unasked only at the version a person approved.
 */
export function automationVersion(automation: Pick<Automation, 'run' | 'with' | 'workspace' | 'mode'>): string {
    const canonical = stableStringify({
        run: automation.run.ref,
        with: automation.with,
        workspace: automation.workspace ?? null,
        mode: automation.mode,
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
