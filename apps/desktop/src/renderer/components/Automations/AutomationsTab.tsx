import { useId, type MouseEvent } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  AlertTriangle,
  Bot,
  Clock,
  Ellipsis,
  ExternalLink,
  Hand,
  History,
  Inbox,
  KeyRound,
  MousePointerClick,
  RefreshCw,
  ScanSearch,
  Wrench,
} from 'lucide-react';
import type {
  AutomationsSnapshot,
  AutomationView,
  RunListEntry,
} from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { useSettings } from '../../contexts/SettingsContext';
import { automationsBridge } from '../../services/automationsBridge';
import { useAttentionStore } from '../../stores/attentionStore';
import { waitingRuns } from '../../sidebar/entries';
import { useAutomationsStore, WINDOW_LOADED_AT } from '../../stores/automationsStore';
import {
  RunNowButton,
  StatusDot,
  useArrivals,
  useArrivedOnMount,
  useIntent,
  useMarkRunsSeen,
  useNow,
} from './parts';
import { noNextCheckWords } from './checkWords';
import {
  ASSIGNED_REVIEWS_OFFER,
  formatAgo,
  formatCountdown,
  formatDueAt,
  formatDuration,
  formatRunWhen,
  formatTime,
  historySlots,
  isOpenableFile,
  issuesByFile,
  issuesTitle,
  latestRun,
  modeInWords,
  noticesLine,
  recentRuns,
  recentRunsInWords,
  runAbout,
  runWorked,
  runTitle,
  runStatusLabel,
  tableShowsUnseenFailures,
  triggerInWords,
  triggerLabel,
  type LatestRun,
} from './presentation';
import { GetStarted } from './TemplatesTab';

/**
 * Where the dashboard opens, as Airflow and Buildkite open on their
 * pipelines: automations fire on their own, so the first question is
 * whether they are all right, not what one run did. What is wrong with the
 * file comes first, then what waits for the person, then every automation
 * in factory.yml as one row of a table, read left to right from past to
 * future: what it is, when it fires and what it runs, its latest runs as a
 * strip, how the last one went, and when the next is due. A row opens the
 * automation's panel; a bar in its strip opens that run. Names, triggers
 * and problems come from the file and runs' summaries from other people,
 * so all of it is shown as text.
 *
 * The table gives up columns as its width shrinks (container queries in
 * styles.css): trigger and target fold under the name, then the strip goes,
 * then the next run. How the last run went stays at every width — it is
 * what the table is opened for, and what counts as seeing a failure.
 */
export function AutomationsTab({
  workspace,
  snapshot,
}: {
  workspace: Workspace;
  snapshot: AutomationsSnapshot;
}) {
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const showAutomationRuns = useAutomationsStore((state) => state.showAutomationRuns);
  const openName = useAutomationsStore((state) =>
    state.panel?.kind === 'automation' ? state.panel.name : null,
  );
  const lastSeen = useAutomationsStore((state) => state.lastSeen[workspace.id] ?? WINDOW_LOADED_AT);
  const { busy, error, act } = useIntent();
  const arrivals = useArrivals(snapshot.runs);
  // A running run's duration counts in seconds; countdowns need only the minute.
  const now = useNow(snapshot.runs.some((run) => run.status === 'running') ? 1000 : 30_000);
  // The table counts as looking at runs only while each failure "N failed" counts is a row's last run.
  useMarkRunsSeen(workspace.id, snapshot, tableShowsUnseenFailures(snapshot, lastSeen, now));
  const attention = useAttentionStore((state) => state.attention);
  // The sidebar's own answer, so the two cannot list different runs as pending.
  const waiting = waitingRuns(snapshot.runs, { attention });
  // Later slices' folders and model warnings: worth knowing, and none stops anything.
  const notices = noticesLine(snapshot.notices);

  return (
    <div className="automations-activity">
      {error && (
        <div className="automations-error" role="alert">
          {error}
        </div>
      )}
      {snapshot.standing && (
        <FactoryStandingBanner
          message={snapshot.standing.message}
          checking={busy === 'recheck'}
          onRecheck={() => void act('recheck', () => automationsBridge.recheck(workspace.id))}
        />
      )}
      {snapshot.issues.length > 0 && (
        <FileIssues
          snapshot={snapshot}
          opening={busy !== null && busy.startsWith('open:')}
          onOpen={(file) =>
            void act(`open:${file}`, () => automationsBridge.openFile(workspace.id, file))
          }
        />
      )}
      {notices && <p className="automations-hint automations-notices">{notices}</p>}
      {waiting.length > 0 && (
        <WaitingForYou
          runs={waiting}
          now={now}
          onReview={(runId) => openPanel({ kind: 'run', runId })}
        />
      )}
      {snapshot.suggestAssignedReviews && (
        <div
          className="automations-callout"
          role="region"
          aria-label="Review PRs assigned to me automatically"
        >
          <div className="automations-callout-text">
            <div className="automations-callout-title">Review PRs assigned to me automatically</div>
            <p className="automations-hint">
              Adds <code>review-assigned-prs</code> to factory.yml. {ASSIGNED_REVIEWS_OFFER}
            </p>
          </div>
          <button
            type="button"
            className="dialog-button-primary automations-small-button"
            onClick={() =>
              void act('add-reviews', () => automationsBridge.addAssignedReviews(workspace.id))
            }
            disabled={busy === 'add-reviews'}
          >
            Add
          </button>
        </div>
      )}
      {snapshot.automations.length > 0 ? (
        <Tooltip.Provider delayDuration={120} skipDelayDuration={400}>
          <div className="automations-table-frame">
            <div className="automations-table">
              {/* The cells say what they are to a screen reader; these labels are for the eye. */}
              <div className="automations-table-head" aria-hidden="true">
                <span>Automation</span>
                <span className="automations-col-trigger">Trigger</span>
                <span className="automations-col-target">Runs</span>
                <span className="automations-col-history">History</span>
                <span className="automations-col-last">Last run</span>
                <span className="automations-col-next">Next run</span>
                <span />
              </div>
              <ul className="automations-table-body" aria-label="Automations">
                {snapshot.automations.map((automation) => {
                  const name = automation.name;
                  const runs = recentRuns(snapshot.runs, name, now);
                  const running = runs.some((run) => run.status === 'running');
                  return (
                    <AutomationRow
                      key={name}
                      automation={automation}
                      runs={runs}
                      latest={latestRun(runs, now, (runId) => snapshot.queue[runId])}
                      now={now}
                      arrivals={arrivals}
                      selected={openName === name}
                      running={busy === `run:${name}` || running}
                      disabled={busy !== null}
                      onOpen={() => openPanel({ kind: 'automation', name })}
                      onOpenRun={(runId) => openPanel({ kind: 'run', runId })}
                      onRun={() =>
                        void act(`run:${name}`, () => automationsBridge.runNow(workspace.id, name))
                      }
                      onShowRuns={() => showAutomationRuns(workspace.id, name)}
                      onChange={() => openPanel({ kind: 'new', basis: { automation: name } })}
                      checking={busy === 'recheck'}
                      onRecheck={() =>
                        void act('recheck', () => automationsBridge.recheck(workspace.id))
                      }
                    />
                  );
                })}
              </ul>
            </div>
          </div>
        </Tooltip.Provider>
      ) : (
        // A file that did not load lists nothing, and its problems above say why.
        snapshot.issues.length === 0 && <GetStarted workspace={workspace} snapshot={snapshot} />
      )}
    </div>
  );
}

/**
 * The factory folder does not apply: the last applied version keeps running,
 * and the banner says so, with what was removed regardless. Check again
 * re-reads the folder, for a fix the poll has not seen yet or a harness
 * turned back on.
 */
function FactoryStandingBanner({
  message,
  checking,
  onRecheck,
}: {
  message: string;
  checking: boolean;
  onRecheck: () => void;
}) {
  return (
    <div className="automations-standing" role="status">
      <AlertTriangle size={14} aria-hidden="true" />
      <p className="automations-standing-text">{message}</p>
      <button
        type="button"
        className="dialog-button-secondary automations-small-button"
        disabled={checking}
        onClick={onRecheck}
      >
        <RefreshCw size={12} aria-hidden="true" />
        Check again
      </button>
    </div>
  );
}

/**
 * What in the factory folder did not load, by the file it is in, each with
 * its line: the whole folder, the entries left out, or, while the folder does
 * not apply, everything that keeps it from applying. Each file opens in the
 * person's editor; the line is shown beside it, since an editor is opened at
 * a file, not at a line.
 */
function FileIssues({
  snapshot,
  opening,
  onOpen,
}: {
  snapshot: AutomationsSnapshot;
  opening: boolean;
  onOpen: (file: string) => void;
}) {
  return (
    <div className="automations-issues" role="status">
      <div className="automations-issues-title">
        <AlertTriangle size={13} />
        {issuesTitle(snapshot)}
      </div>
      {issuesByFile(snapshot.issues).map(({ file, issues }) => (
        <div key={file} className="automations-issues-file">
          <div className="automations-issues-file-head">
            <code>{file}</code>
            {isOpenableFile(file) && (
              <button
                type="button"
                className="automations-link-button"
                aria-label={`Open ${file}`}
                disabled={opening}
                onClick={() => onOpen(file)}
              >
                <ExternalLink size={11} aria-hidden="true" />
                Open
              </button>
            )}
          </div>
          <ul>
            {issues.map((issue, index) => (
              <li key={index}>
                {issue.line ? <span className="automations-line">line {issue.line}</span> : null}
                {issue.path ? <code>{issue.path}</code> : null} {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Every run waiting for a person, plans and agents' requests alike, as
 * CircleCI holds a workflow at an approval: amber, above the table, each
 * with its Review. The sidebar's "N waiting" opens the dashboard on it.
 */
function WaitingForYou({
  runs,
  now,
  onReview,
}: {
  runs: RunListEntry[];
  now: Date;
  onReview: (runId: string) => void;
}) {
  const headingId = useId();
  return (
    <section className="automations-waiting" aria-labelledby={headingId}>
      <h2 id={headingId} className="automations-waiting-title">
        <Hand size={14} aria-hidden="true" />
        Waiting for you
        <span className="automations-waiting-count" aria-hidden="true">
          {runs.length}
        </span>
      </h2>
      <ul className="automations-waiting-list">
        {runs.map((run) => (
          <li key={run.id} className="automations-waiting-card">
            <div className="automations-waiting-text">
              <span className="automations-waiting-name">{runTitle(run)}</span>
              {run.summary && <span className="automations-waiting-summary">{run.summary}</span>}
            </div>
            <span className="automations-waiting-when" title={formatTime(run.createdAt)}>
              {triggerInWords(run)} · {formatAgo(run.createdAt, now)}
            </span>
            <button
              type="button"
              className="dialog-button-primary automations-small-button"
              onClick={() => onReview(run.id)}
            >
              Review…
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Keeps a click on a control inside the row from also opening the row. */
const inside = (handler?: () => void) => (event: MouseEvent) => {
  event.stopPropagation();
  handler?.();
};

function AutomationRow({
  automation,
  runs,
  latest,
  now,
  arrivals,
  selected,
  running,
  disabled,
  onOpen,
  onOpenRun,
  onRun,
  onShowRuns,
  onChange,
  checking,
  onRecheck,
}: {
  automation: AutomationView;
  runs: RunListEntry[];
  latest: LatestRun | null;
  now: Date;
  arrivals: ReadonlySet<string>;
  selected: boolean;
  running: boolean;
  disabled: boolean;
  onOpen: () => void;
  onOpenRun: (runId: string) => void;
  onRun: () => void;
  onShowRuns: () => void;
  onChange: () => void;
  /** Check again, the banner's own, is under way. */
  checking: boolean;
  /** Asks every harness's CLI again, as the banner's Check again does. */
  onRecheck: () => void;
}) {
  const { openSettings } = useSettings();
  const isAgent = automation.kind === 'agent';
  const TriggerIcon =
    automation.source === 'poll'
      ? ScanSearch
      : automation.source === 'manual'
        ? MousePointerClick
        : automation.onEvent
          ? Inbox
          : Clock;
  const TargetIcon = isAgent ? Bot : Wrench;
  return (
    <li className="automations-row-item">
      {/* The row opens the panel for a pointer; the name is the same action for a keyboard. */}
      <div
        className="automations-row"
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
      >
        <div className="automations-cell automations-cell-name">
          <div className="automations-row-line">
            <button
              type="button"
              className="automations-link-button automations-name"
              onClick={inside(onOpen)}
            >
              {automation.name}
            </button>
            <span
              className={`automations-mode automations-mode-${automation.mode}`}
              title={modeInWords(
                automation.mode,
                automation.asksFirst,
                automation.source,
                Boolean(automation.needsAllow),
              )}
            >
              {automation.mode}
            </span>
            {automation.needsAllow && (
              <span className="automations-allow-pill" title="It does not check until you allow it">
                Needs your OK
              </span>
            )}
            {automation.addedBy?.isNew && (
              <span
                className="automations-new-pill"
                title={`Added by ${automation.addedBy.sessionName}`}
              >
                New
              </span>
            )}
          </div>
          {/* Wide: where it is written (a problem names its own line). Narrower, without the trigger and target columns: what it does. */}
          {!automation.problem && (automation.line !== undefined || automation.addedBy) && (
            <div className="automations-row-sub automations-row-meta">
              {automation.line !== undefined && (
                <span className="automations-row-file">
                  {automation.file ?? 'factory.yml'}:{automation.line}
                </span>
              )}
              {automation.line !== undefined && automation.addedBy && ' · '}
              {automation.addedBy && `added by ${automation.addedBy.sessionName}`}
            </div>
          )}
          <div className="automations-row-sub automations-row-pipeline">
            {automation.trigger} → {automation.runs}
            {isAgent ? ', read-only' : ''}
          </div>
          {automation.problem && (
            <div className="automations-problem automations-row-problem">
              <AlertTriangle size={12} aria-hidden="true" />
              <span>
                Not running: {automation.problem}
                {automation.line ? ` (line ${automation.line})` : ''}
              </span>
              {/* A problem from asking a harness's CLI about servers is asked again from here (review B4). */}
              {automation.recheck && (
                <button
                  type="button"
                  className="dialog-button-secondary automations-small-button"
                  disabled={checking}
                  onClick={inside(onRecheck)}
                >
                  <RefreshCw size={12} aria-hidden="true" />
                  Check again
                </button>
              )}
              {/* An entry that needs a secret bound runs nothing until it is: bind it where the binding lives. */}
              {automation.unbound && (
                <button
                  type="button"
                  className="dialog-button-secondary automations-small-button"
                  onClick={inside(() => openSettings('secrets'))}
                >
                  <KeyRound size={12} aria-hidden="true" />
                  Bind…
                </button>
              )}
            </div>
          )}
        </div>

        <div className="automations-cell automations-col-trigger">
          <div className="automations-row-line" title={automation.trigger}>
            <TriggerIcon size={13} className="automations-row-icon" aria-hidden="true" />
            <span className="sr-only">Trigger: </span>
            <span className="automations-row-text">{automation.trigger}</span>
          </div>
          {automation.schedule && (
            <code className="automations-row-sub automations-cron">{automation.schedule}</code>
          )}
        </div>

        <div className="automations-cell automations-col-target">
          <div className="automations-row-line" title={automation.runs}>
            <TargetIcon size={13} className="automations-row-icon" aria-hidden="true" />
            <span className="sr-only">Runs: </span>
            <span className="automations-row-text">{automation.runs}</span>
          </div>
          <div className="automations-row-sub">
            {isAgent ? 'Agent session, read-only' : 'Consola tool'}
          </div>
        </div>

        <div className="automations-cell automations-col-history">
          <HistoryStrip runs={runs} now={now} arrivals={arrivals} onOpenRun={onOpenRun} />
        </div>

        <div className="automations-cell automations-col-last">
          <LastRunCell latest={latest} />
        </div>

        <div className="automations-cell automations-col-next">
          <NextRunCell automation={automation} now={now} />
        </div>

        <div className="automations-cell automations-row-actions" onClick={inside()}>
          <RunNowButton
            automation={automation}
            running={running}
            disabled={disabled}
            onRun={onRun}
          />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="automations-icon-button"
                aria-label={`More for ${automation.name}`}
              >
                <Ellipsis size={15} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="dropdown-content" align="end" sideOffset={4}>
                <DropdownMenu.Item className="dropdown-item" onSelect={onShowRuns}>
                  <History size={13} aria-hidden="true" />
                  Show runs in Activity
                </DropdownMenu.Item>
                <DropdownMenu.Item className="dropdown-item" onSelect={onChange}>
                  <Bot size={13} aria-hidden="true" />
                  Change with agent
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
    </li>
  );
}

/**
 * An automation's latest runs as a strip of bars, oldest on the left, so
 * the newest sits beside "Last run". A slot with no run is a flat line. A
 * bar says its run on hover and opens it on click; to a screen reader the
 * strip is its counts in words, and the automation's details list each run.
 */
function HistoryStrip({
  runs,
  now,
  arrivals,
  onOpenRun,
}: {
  runs: RunListEntry[];
  now: Date;
  arrivals: ReadonlySet<string>;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <div className="automations-history" role="img" aria-label={recentRunsInWords(runs)}>
      {historySlots(runs).map((run, index) =>
        run === null ? (
          <span key={`empty-${index}`} className="automations-bar automations-bar-empty" />
        ) : (
          <HistoryBar
            key={run.id}
            run={run}
            now={now}
            arrived={arrivals.has(run.id)}
            onOpen={() => onOpenRun(run.id)}
          />
        ),
      )}
    </div>
  );
}

function HistoryBar({
  run,
  now,
  arrived,
  onOpen,
}: {
  run: RunListEntry;
  now: Date;
  arrived: boolean;
  onOpen: () => void;
}) {
  // A run that lands while the strip shows grows in, so Run now visibly adds one.
  const grows = useArrivedOnMount(arrived);
  const about = runAbout(run);
  const duration = runWorked(run) ? formatDuration(run, now) : null;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span
          className={`automations-bar automations-bar-${run.status} ${grows ? 'automations-bar-arrived' : ''}`}
          onClick={inside(onOpen)}
        />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="tooltip-content automations-bar-tooltip"
          side="top"
          sideOffset={6}
        >
          <span className="automations-bar-tooltip-head">
            <StatusDot status={run.status} />
            <strong>{runStatusLabel(run)}</strong>
            <span className="automations-bar-tooltip-when">
              {formatRunWhen(run.createdAt, now)}
            </span>
          </span>
          {/* With nothing to say about itself, a run's "about" is its status, already shown. */}
          {about !== run.status && <span className="automations-bar-tooltip-about">{about}</span>}
          <span className="automations-bar-tooltip-meta">
            {triggerLabel(run)}
            {duration ? ` · ${duration}` : ''}
          </span>
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** The run the row speaks for, as `latestRun` picks it: one waiting for you before one that ran. */
function LastRunCell({ latest }: { latest: LatestRun | null }) {
  if (!latest) {
    return (
      <div className="automations-row-line automations-row-quiet">
        <span className="sr-only">Last run: </span>
        No runs yet
      </div>
    );
  }
  return (
    <>
      <div className="automations-row-line">
        <StatusDot status={latest.tone} />
        <span className="sr-only">Last run: </span>
        <span className={`automations-last-label automations-tone-${latest.tone}`}>
          {latest.label}
        </span>
      </div>
      <div className="automations-row-sub automations-row-number">{latest.detail}</div>
    </>
  );
}

/**
 * When it fires next: a countdown, with the calendar time under it. One on
 * events fires when the Inbox refreshes; one with a problem does not fire.
 */
function NextRunCell({ automation, now }: { automation: AutomationView; now: Date }) {
  if (automation.problem) {
    return (
      <div className="automations-row-line automations-row-quiet">
        <span className="sr-only">Next run: none</span>
        <span aria-hidden="true">—</span>
      </div>
    );
  }
  if (automation.source === 'poll') {
    if (automation.needsAllow || !automation.check?.nextAt) {
      return (
        <div className="automations-row-line automations-row-quiet">
          <span className="sr-only">Next check: </span>
          {noNextCheckWords(automation.check, Boolean(automation.needsAllow))}
        </div>
      );
    }
    const countdown = formatCountdown(automation.check.nextAt, now);
    return (
      <>
        <div
          className={`automations-row-line automations-countdown ${countdown === 'due now' ? 'automations-due' : ''}`}
          title={formatTime(automation.check.nextAt)}
        >
          Next check {countdown}
        </div>
        <div className="automations-row-sub automations-row-number">
          {formatDueAt(automation.check.nextAt, now)}
        </div>
      </>
    );
  }
  if (automation.source === 'manual') {
    return (
      <div className="automations-row-line automations-row-quiet">
        <span className="sr-only">Next run: </span>
        On demand
      </div>
    );
  }
  if (automation.onEvent) {
    return (
      <div className="automations-row-line">
        <span className="sr-only">Next run: </span>
        On Inbox refresh
      </div>
    );
  }
  if (!automation.nextRunAt) {
    return (
      <div className="automations-row-line automations-row-quiet">
        <span className="sr-only">Next run: </span>
        Not scheduled
      </div>
    );
  }
  const countdown = formatCountdown(automation.nextRunAt, now);
  return (
    <>
      <div
        className={`automations-row-line automations-countdown ${countdown === 'due now' ? 'automations-due' : ''}`}
        title={formatTime(automation.nextRunAt)}
      >
        <span className="sr-only">Next run </span>
        {countdown}
      </div>
      <div className="automations-row-sub automations-row-number">
        {formatDueAt(automation.nextRunAt, now)}
        {automation.asksFirst ? ' · asks first' : ''}
      </div>
    </>
  );
}
