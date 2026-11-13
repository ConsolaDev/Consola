import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Play, RefreshCw } from 'lucide-react';
import type { AgentRunPreview, AutomationView, RunListEntry, RunRecord } from '../../../shared/automations';
import type { CleanupResult, SessionVerdict, StalePreview } from '../../../shared/sessionCleanup';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import {
  formatRunWhen,
  formatTime,
  runAbout,
  runTitle,
  statusWord,
  triggerLabel,
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

/**
 * One run as a row of a run list, its cells laid on the list's columns
 * (`.automations-runs`) so status, about, trigger and time line up down the
 * list. `showName` where the list mixes automations; a queued run says its
 * place in line when it has one. `arrived` washes a run that landed while
 * the list was showing, once.
 */
export function RunRow({
  run,
  now,
  showName = false,
  place,
  selected = false,
  arrived = false,
  onOpen,
}: {
  run: RunListEntry;
  now: Date;
  showName?: boolean;
  place?: number;
  selected?: boolean;
  arrived?: boolean;
  onOpen: () => void;
}) {
  const washed = useArrivedOnMount(arrived);
  const about = runAbout(run);
  const status = `${statusWord(run.status)}${run.status === 'queued' && place !== undefined ? ` · ${place} in line` : ''}`;
  // With nothing to say about itself, a run's "about" is its status, already shown.
  const aboutText = about !== run.status ? about : '';
  const when = formatTime(run.createdAt);
  return (
    <li className="automations-run">
      <button
        type="button"
        className={`automations-run-row ${washed ? 'automations-run-arrived' : ''}`}
        aria-current={selected ? 'true' : undefined}
        // The cells are a grid, so their text has no separators of its own to read out.
        aria-label={[showName ? runTitle(run) : null, status, aboutText || null, triggerLabel(run), when]
          .filter(Boolean)
          .join(', ')}
        onClick={onOpen}
      >
        <StatusDot status={run.status} />
        {showName && <span className="automations-run-name">{runTitle(run)}</span>}
        <span className={`automations-run-status automations-run-status-${run.status}`}>{status}</span>
        <span className="automations-run-about">{aboutText}</span>
        <span className="automations-run-trigger">{triggerLabel(run)}</span>
        <time className="automations-run-when" dateTime={run.createdAt} title={when}>
          {formatRunWhen(run.createdAt, now)}
        </time>
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
  onRun,
}: {
  automation: AutomationView;
  running: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const checks = automation.onEvent;
  return (
    <button
      type="button"
      className="dialog-button-secondary automations-small-button"
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

/**
 * The sessions a cleanup preview would remove, or a cleanup run removed, and
 * the ones kept with their reasons. Results of other tools render nothing.
 */
export function CleanupDetails({ result }: { result: unknown }) {
  if (!isCleanupData(result)) return null;
  const going = 'candidates' in result ? result.candidates : [];
  const kept = result.skipped;
  return (
    <div className="automations-details">
      {going.length > 0 && (
        <ul>
          {going.map((verdict) => (
            <li key={verdict.sessionId}>
              <strong>{verdict.sessionName}</strong>
              {verdict.pullRequest ? ` — #${verdict.pullRequest.number} ${verdict.pullRequest.status}` : ''}
              {diskEffect(verdict)}
            </li>
          ))}
        </ul>
      )}
      {kept.length > 0 && (
        <details>
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

function diskEffect(verdict: SessionVerdict): string {
  if (!verdict.worktree) return '';
  if (!verdict.worktree.remove) return ` · keeps its worktree (${verdict.worktree.keptBecause})`;
  const folder = verdict.worktree.path.split(/[\\/]/).pop();
  return ` · removes ${folder}${verdict.branch ? ` and ${verdict.branch}` : ''}`;
}
