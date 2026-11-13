import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Hand,
  LoaderCircle,
  Play,
  RefreshCw,
  Timer,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { AgentRunPreview, AutomationsSnapshot, AutomationView, RunListEntry, RunRecord } from '../../../shared/automations';
import type {
  CleanupResult,
  PullRequestSummary,
  SessionOutcome,
  SessionVerdict,
  StalePreview,
} from '../../../shared/sessionCleanup';
import { useAutomationsStore } from '../../stores/automationsStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { isLookedAt } from '../../utils/windowAttention';
import {
  formatAgo,
  formatDuration,
  formatTime,
  runAbout,
  runTitle,
  statusLabel,
  triggerInWords,
  type RunAutomationOption,
  type RunFacts,
} from './presentation';

/**
 * A run's status as a dot. Decorative: whatever shows one also says the
 * status in words.
 */
export function StatusDot({ status }: { status: RunFacts['status'] }) {
  return <span className={`automations-dot automations-dot-${status}`} aria-hidden="true" />;
}

const STATUS_ICONS: Record<RunFacts['status'], LucideIcon> = {
  completed: CircleCheck,
  failed: CircleX,
  running: LoaderCircle,
  queued: Clock,
  // A person's hand is what it waits for; the approval step in a pipeline wears the same one.
  'needs-approval': Hand,
  rejected: CircleSlash,
};

/**
 * A run's status as a CI run list draws it: a check, a cross, a spinner.
 * Decorative like the dot, and in the dot's colours.
 */
export function StatusIcon({ status, size = 16 }: { status: RunFacts['status']; size?: number }) {
  const Icon = STATUS_ICONS[status];
  return (
    <Icon size={size} className={`automations-status-icon automations-status-icon-${status}`} aria-hidden="true" />
  );
}

/**
 * One run as GitHub Actions lists a workflow's: what it did on top; under
 * it, which automation (where the list mixes them), how it ended and what
 * fired it; when and how long on the right. `when` is how long ago, or the
 * time of day where the list is already grouped by day. A queued run says
 * its place in line; one that lands while the list shows washes in once.
 */
export function RunItem({
  run,
  now,
  place,
  arrived = false,
  selected = false,
  showName = false,
  when = 'ago',
  onOpen,
}: {
  run: RunListEntry;
  now: Date;
  place?: number;
  arrived?: boolean;
  selected?: boolean;
  showName?: boolean;
  when?: 'ago' | 'time';
  onOpen: () => void;
}) {
  const washed = useArrivedOnMount(arrived);
  const about = runAbout(run);
  const status = `${statusLabel(run.status)}${run.status === 'queued' && place !== undefined ? ` · ${place} in line` : ''}`;
  // With nothing to say about itself, a run's "about" is its status: the title says that instead.
  const title = about !== run.status ? about : status;
  const worked = run.status === 'completed' || run.status === 'failed' || run.status === 'running';
  const duration = worked ? formatDuration(run, now) : null;
  const fired = triggerInWords(run);
  const name = showName ? runTitle(run) : null;
  const full = formatTime(run.createdAt);
  const at =
    when === 'time'
      ? new Date(run.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : formatAgo(run.createdAt, now);
  return (
    <li>
      <button
        type="button"
        className={`automations-run-item ${washed ? 'automations-run-arrived' : ''}`}
        aria-current={selected ? 'true' : undefined}
        // The cells are laid out apart, so their text has no separators of its own to read out.
        aria-label={[name, status, title !== status ? title : null, fired, full, duration ? `took ${duration}` : null]
          .filter(Boolean)
          .join(', ')}
        onClick={onOpen}
      >
        <StatusIcon status={run.status} />
        <span className="automations-run-item-main">
          <span className="automations-run-item-title">{title}</span>
          <span className="automations-run-item-meta">
            {name && (
              <>
                <span className="automations-run-item-name">{name}</span>
                {' · '}
              </>
            )}
            {title !== status && (
              <>
                <span className={`automations-tone-${run.status}`}>{status}</span>
                {' · '}
              </>
            )}
            {fired}
          </span>
        </span>
        <span className="automations-run-item-side">
          <time dateTime={run.createdAt} title={full}>
            <CalendarDays size={12} aria-hidden="true" />
            {at}
          </time>
          {duration && (
            <span>
              <Timer size={12} aria-hidden="true" />
              {duration}
            </span>
          )}
        </span>
        <ChevronRight size={14} className="automations-run-item-chevron" aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * Narrows a run list to one automation, single-select like the Inbox's
 * "Updated". factory.yml's entries first, then what else has runs — an entry
 * since removed, an agent's request — each with its count in the list.
 */
export function AutomationFilterMenu({
  options,
  value,
  onChange,
}: {
  options: RunAutomationOption[];
  value: string | null;
  onChange: (automation: string | null) => void;
}) {
  const chosen = options.find((option) => option.id === value);
  const inFile = options.filter((option) => option.inFile);
  const others = options.filter((option) => !option.inFile);
  const item = (option: RunAutomationOption) => (
    <DropdownMenu.RadioItem key={option.id} className="dropdown-item automations-filter-item" value={`a:${option.id}`}>
      <span className="automations-filter-indicator" aria-hidden="true">
        <DropdownMenu.ItemIndicator>
          <Check size={12} />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className="automations-filter-label">{option.label}</span>
      <span className="automations-filter-count">{option.count}</span>
    </DropdownMenu.RadioItem>
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`automations-filter-trigger ${value !== null ? 'active' : ''}`}
          aria-label={`Automation: ${chosen?.label ?? 'all'}`}
        >
          <span className="automations-filter-trigger-label">{chosen?.label ?? 'All automations'}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content automations-filter-menu" sideOffset={6} align="end">
          {/* Prefixed values: "all" could be an automation's name. */}
          <DropdownMenu.RadioGroup
            value={value === null ? 'all' : `a:${value}`}
            onValueChange={(next) => onChange(next === 'all' ? null : next.slice(2))}
          >
            <DropdownMenu.RadioItem className="dropdown-item automations-filter-item" value="all">
              <span className="automations-filter-indicator" aria-hidden="true">
                <DropdownMenu.ItemIndicator>
                  <Check size={12} />
                </DropdownMenu.ItemIndicator>
              </span>
              <span className="automations-filter-label">All automations</span>
            </DropdownMenu.RadioItem>
            {inFile.length > 0 && <DropdownMenu.Separator className="dropdown-separator" />}
            {inFile.map(item)}
            {others.length > 0 && <DropdownMenu.Separator className="dropdown-separator" />}
            {others.map(item)}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The time now, ticking every `intervalMs` (never, for null): durations
 * count up and countdowns count down without a push from main.
 */
export function useNow(intervalMs: number | null): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    setNow(new Date());
    if (intervalMs === null) return;
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Counts the workspace's runs as seen while a view that shows them is up,
 * which is what the sidebar's "N failed" counts from. Opening the view is
 * looking at it. After that, a change counts as seen only if someone can
 * see the window: main keeps pushing to a minimized or background one, and
 * the failures that land there are what "N failed" is for. `shows` is false
 * while the view leaves out a failure that "N failed" counts.
 */
export function useMarkRunsSeen(workspaceId: string, snapshot: AutomationsSnapshot, shows = true): void {
  const hasMarked = useRef(false);
  useEffect(() => {
    if (!shows) return;
    if (hasMarked.current && !isLookedAt()) return;
    hasMarked.current = true;
    markRunsSeen(workspaceId);
  }, [workspaceId, snapshot, shows]);

  // Coming back to the window while the view shows is looking at it.
  useEffect(() => {
    if (!shows) return;
    const onReturn = () => {
      if (isLookedAt()) markRunsSeen(workspaceId);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [workspaceId, shows]);
}

function markRunsSeen(workspaceId: string): void {
  useAutomationsStore.getState().markRunsSeen(workspaceId, new Date().toISOString());
}

/**
 * The runs that landed since the list first showed, so each is marked once
 * as it arrives. Known by every run the snapshot has held, not by what a
 * filter shows: a run a filter brings back into view has not arrived.
 */
export function useArrivals(runs: RunListEntry[]): ReadonlySet<string> {
  const known = useRef<Set<string> | null>(null);
  const seen = known.current;
  const arrived = new Set(seen === null ? [] : runs.filter((run) => !seen.has(run.id)).map((run) => run.id));
  useEffect(() => {
    known.current ??= new Set();
    for (const run of runs) known.current.add(run.id);
  }, [runs]);
  return arrived;
}

/**
 * Whether this element arrived, fixed at its mount. `useArrivals` forgets a
 * run on the next render, and a run's next push comes within moments (queued,
 * then running), which would cut its entrance short.
 */
export function useArrivedOnMount(arrived: boolean): boolean {
  const [onMount] = useState(arrived);
  return onMount;
}

/**
 * One intent sent to main at a time, with what went wrong kept to show
 * inline. `busy` is the key of the intent in flight.
 */
export function useIntent() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (key: string, intent: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await intent();
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, act };
}

/**
 * An automation's Run now, or Check now for one fired by events. Disabled
 * while another intent is in flight, while it runs, or when it is not
 * running at all (`problem`).
 */
export function RunNowButton({
  automation,
  running,
  disabled,
  primary = false,
  onRun,
}: {
  automation: AutomationView;
  running: boolean;
  disabled: boolean;
  /** Where it is the main thing to do, as an automation's own details make it. */
  primary?: boolean;
  onRun: () => void;
}) {
  const checks = automation.onEvent;
  return (
    <button
      type="button"
      className={`${primary ? 'dialog-button-primary' : 'dialog-button-secondary'} automations-small-button`}
      disabled={disabled || running || Boolean(automation.problem)}
      onClick={onRun}
      title={
        checks
          ? 'Refresh the Inbox now; only what is new since the last check fires'
          : automation.mode === 'auto' && !automation.asksFirst
            ? 'Runs now'
            : 'Previews now; nothing changes until you approve'
      }
    >
      {checks ? (
        <RefreshCw size={12} className={running ? 'automations-spin' : undefined} aria-hidden="true" />
      ) : (
        <Play size={12} aria-hidden="true" />
      )}
      <span className="automations-run-now-label">
        {running ? (checks ? 'Checking…' : 'Running…') : checks ? 'Check now' : 'Run now'}
      </span>
    </button>
  );
}

/** What an agent run will start: the item it is about, what it runs, and the exact prompt. */
export function AgentRunDetails({ preview }: { preview: AgentRunPreview }) {
  return (
    <div className="automations-details">
      {preview.item && (
        <div>
          <a href={preview.item.url} target="_blank" rel="noreferrer">
            {preview.item.title}
          </a>{' '}
          by @{preview.item.author}
        </div>
      )}
      <div>
        {preview.runs}
        {preview.scope ? ` in ${preview.scope}` : ''}, read-only
      </div>
      <details>
        <summary>The prompt it will send</summary>
        <pre className="automations-prompt">{preview.prompt}</pre>
      </details>
    </div>
  );
}

/** The item an event run is about, linked; its title is the author's own text, shown as text. */
export function RunItemLink({ run, fallback }: { run: RunRecord; fallback?: string }) {
  const item = run.trigger.item;
  if (!item) return <>{fallback ?? null}</>;
  return (
    <a href={item.url} target="_blank" rel="noreferrer">
      {item.title}
    </a>
  );
}

interface CleanupRow {
  key: string;
  /** Going, in a preview; removed or failed, in a result. */
  tone: 'going' | 'done' | 'failed';
  name: string;
  pullRequest?: PullRequestSummary;
  effect: string;
}

const CLEANUP_ICONS: Record<CleanupRow['tone'], LucideIcon> = { going: Trash2, done: CircleCheck, failed: CircleX };
const CLEANUP_WORDS: Record<CleanupRow['tone'], string> = { going: 'to remove', done: 'removed', failed: 'not removed' };

/**
 * A cleanup's output, a row per session: in a preview, what approving would
 * remove; in a result, what it removed and what it could not. The sessions
 * it kept fold underneath with their reasons. Results of other tools render
 * nothing.
 */
export function CleanupDetails({ result }: { result: unknown }) {
  if (!isCleanupData(result)) return null;
  const rows: CleanupRow[] =
    'candidates' in result
      ? result.candidates.map((verdict) => ({
          key: verdict.sessionId,
          tone: 'going',
          name: verdict.sessionName,
          pullRequest: verdict.pullRequest,
          effect: diskEffect(verdict),
        }))
      : [
          ...result.removed.map((outcome): CleanupRow => ({
            key: outcome.sessionId,
            tone: 'done',
            name: outcome.sessionName,
            pullRequest: outcome.pullRequest,
            effect: outcomeEffect(outcome),
          })),
          ...result.failed.map((outcome): CleanupRow => ({
            key: outcome.sessionId,
            tone: 'failed',
            name: outcome.sessionName,
            pullRequest: outcome.pullRequest,
            effect: outcome.error ?? 'Could not be removed',
          })),
        ];
  const kept = result.skipped;
  if (rows.length === 0 && kept.length === 0) return null;
  return (
    <div className="automations-details">
      {rows.length > 0 && (
        <ul className="automations-output">
          {rows.map((row) => {
            const Icon = CLEANUP_ICONS[row.tone];
            return (
              <li key={row.key} className={`automations-output-row automations-output-${row.tone}`}>
                <Icon size={14} aria-label={CLEANUP_WORDS[row.tone]} />
                <span className="automations-output-main">
                  <span className="automations-output-name">{row.name}</span>
                  {row.effect && <span className="automations-output-effect">{row.effect}</span>}
                </span>
                {row.pullRequest && (
                  <a
                    className="automations-output-pr"
                    href={row.pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`${row.pullRequest.repo}#${row.pullRequest.number}`}
                  >
                    #{row.pullRequest.number} {row.pullRequest.status}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {kept.length > 0 && (
        <details className="automations-output-kept">
          <summary>{kept.length} kept</summary>
          <ul>
            {kept.map((verdict) => (
              <li key={verdict.sessionId}>
                <strong>{verdict.sessionName}</strong> — {verdict.detail ?? verdict.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function isCleanupData(result: unknown): result is StalePreview | CleanupResult {
  return typeof result === 'object' && result !== null && Array.isArray((result as { skipped?: unknown }).skipped);
}

/** What approving would do on disk. */
function diskEffect(verdict: SessionVerdict): string {
  if (!verdict.worktree) return '';
  if (!verdict.worktree.remove) return `Keeps its worktree (${verdict.worktree.keptBecause})`;
  const folder = verdict.worktree.path.split(/[\\/]/).pop();
  return `Removes ${folder}${verdict.branch ? ` and ${verdict.branch}` : ''}`;
}

/** What removing it did on disk, and anything it noted. */
function outcomeEffect(outcome: SessionOutcome): string {
  const parts = [
    outcome.worktree === 'removed' ? 'Worktree removed' : outcome.worktree === 'kept' ? 'Worktree kept' : null,
    outcome.branch === 'deleted' ? 'branch deleted' : outcome.branch === 'kept' ? 'branch kept' : null,
    ...outcome.notes,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}
