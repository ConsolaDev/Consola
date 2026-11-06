import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  ArrowRight,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  ExternalLink,
  FileDiff,
  FileMinus,
  FilePlus,
  FileSymlink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { WorkItemComment, WorkItemDetails } from '../../../shared/workItemDetails';
import { workItemAssetUrl } from '../../../shared/workItemAssets';
import { MarkdownRenderer } from '../Markdown';
import {
  OUTCOME_TONE,
  checkLabel,
  checkOutcome,
  checksSentence,
  commentAge,
  commentVerb,
  diffBlocks,
  fileStatus,
  initial,
  parsePatch,
  reviewMeta,
  sortChecks,
  splitPath,
  summarizeChecks,
  type CheckOutcome,
  type CheckSummary,
  type StatusKind,
  type Tone,
} from './workItemDetailPresentation';

export type DetailTab = 'Overview' | 'Conversation' | 'Files changed' | 'Checks';
type DetailFile = WorkItemDetails['files'][number];

const STATUS_ICONS: Record<StatusKind, LucideIcon> = {
  'pr-open': GitPullRequest,
  'pr-draft': GitPullRequestDraft,
  'pr-merged': GitMerge,
  'pr-closed': GitPullRequestClosed,
  'issue-open': CircleDot,
  'issue-closed': CircleCheck,
};

const OUTCOME_ICONS: Record<CheckOutcome, LucideIcon> = {
  failing: CircleX,
  pending: CircleDashed,
  passing: CircleCheck,
  skipped: CircleSlash,
};

const TONE_ICONS: Record<Tone, LucideIcon> = {
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
  merged: GitMerge,
  accent: CircleDot,
  neutral: CircleDashed,
};

/** Keyed by the state it shows, so a merge or close visibly lands. */
export function StateBadge({ kind, label, tone }: { kind: StatusKind; label: string; tone: Tone }) {
  const Icon = STATUS_ICONS[kind];
  return (
    <span className="inbox-detail-state" data-tone={tone}>
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * One branch name, cut short with an ellipsis when the row runs out. Hovering
 * a cut-short chip shows the whole name; a chip that fits shows nothing, since
 * the tooltip would only repeat it. Radix rather than `title`, like every
 * other tooltip here: the native one did not appear in this window.
 */
function BranchChip({ name }: { name: string }) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const isCut = () => !!ref.current && ref.current.scrollWidth > ref.current.clientWidth;
  return (
    <Tooltip.Root open={open} onOpenChange={(next) => setOpen(next && isCut())}>
      <Tooltip.Trigger asChild>
        <code ref={ref}>{name}</code>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content inbox-detail-branch-tooltip" sideOffset={6} align="start">
          {name}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function BranchPair({ head, base }: { head: string; base: string | undefined }) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <span className="inbox-detail-branches">
        <BranchChip name={head} />
        <ArrowRight size={12} aria-hidden="true" />
        <BranchChip name={base ?? ''} />
      </span>
    </Tooltip.Provider>
  );
}

/** The tone of the checks as a whole: one failure outweighs any number of passes. */
export function rollupOutcome(summary: CheckSummary): CheckOutcome | null {
  if (summary.total === 0) return null;
  if (summary.failing) return 'failing';
  if (summary.pending) return 'pending';
  return summary.passing ? 'passing' : 'skipped';
}

export function CheckIcon({ outcome, size = 14 }: { outcome: CheckOutcome; size?: number }) {
  const Icon = OUTCOME_ICONS[outcome];
  return <Icon size={size} className="inbox-detail-tone-icon" data-tone={OUTCOME_TONE[outcome]} aria-hidden="true" />;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inbox-detail-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A fact that is also the way to its tab. `tinted` colours the words too;
 * leave it off when the children carry their own colours.
 */
function FactLink({
  tone,
  icon: Icon,
  tinted = false,
  onClick,
  children,
}: {
  tone: Tone;
  icon: LucideIcon;
  tinted?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`inbox-detail-fact-link${tinted ? ' inbox-detail-fact-link--tinted' : ''}`}
      data-tone={tone}
      onClick={onClick}
    >
      <Icon size={14} className="inbox-detail-tone-icon" aria-hidden="true" />
      <span>{children}</span>
      <ChevronRight size={13} className="inbox-detail-fact-chevron" aria-hidden="true" />
    </button>
  );
}

function DiffCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inbox-detail-counts">
      <span className="inbox-detail-add">+{additions}</span>
      <span className="inbox-detail-del">−{deletions}</span>
    </span>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const OUTCOME_WORDS: Record<CheckOutcome, string> = {
  failing: 'failing',
  pending: 'pending',
  passing: 'passed',
  skipped: 'skipped',
};
const OUTCOMES: CheckOutcome[] = ['failing', 'pending', 'passing', 'skipped'];

/** "1 failing · 2 passed", each count in its own colour. */
function ChecksSentence({ summary }: { summary: CheckSummary }) {
  if (summary.total === 0) return <>{checksSentence(summary)}</>;
  return (
    <>
      {OUTCOMES.filter((outcome) => summary[outcome] > 0).map((outcome, index) => (
        <span key={outcome}>
          {index > 0 && <span className="inbox-detail-sep"> · </span>}
          <span data-tone={OUTCOME_TONE[outcome]} className="inbox-detail-toned">
            {summary[outcome]} {OUTCOME_WORDS[outcome]}
          </span>
        </span>
      ))}
    </>
  );
}

function totals(files: DetailFile[]) {
  return files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 }
  );
}

/**
 * A description or comment as GitHub would show it: its HTML rendered
 * (sanitized), and its images loaded through main as the workspace's
 * account, so a screenshot pasted into a private repo appears too. A click
 * on an image opens it full-window to zoom into.
 */
function WorkItemMarkdown({ workspaceId, content }: { workspaceId: string; content: string }) {
  const resolveImageSrc = useCallback((src: string | undefined) => workItemAssetUrl(workspaceId, src), [workspaceId]);
  return (
    <MarkdownRenderer content={content} enableCommandHighlighting={false} allowHtml resolveImageSrc={resolveImageSrc} zoomableImages />
  );
}

export function OverviewTab({
  workspaceId,
  details,
  isPr,
  onShow,
}: {
  workspaceId: string;
  details: WorkItemDetails;
  isPr: boolean;
  onShow: (tab: DetailTab) => void;
}) {
  const summary = summarizeChecks(details.checks);
  const rollup = rollupOutcome(summary);
  const review = reviewMeta(details.reviewDecision);
  // No merge fact: the merge state is said once, under the Merge button.
  const { additions, deletions } = totals(details.files);
  const hasFacts = isPr || details.labels.length > 0 || details.assignees.length > 0;
  return (
    <>
      {hasFacts && (
        <dl className="inbox-detail-facts">
          {isPr && (
            <Fact label="Review">
              <FactLink tone={review.tone} icon={TONE_ICONS[review.tone]} tinted={review.tone !== 'neutral'} onClick={() => onShow('Conversation')}>
                {review.label}
              </FactLink>
            </Fact>
          )}
          {isPr && (
            <Fact label="Checks">
              <FactLink
                tone={rollup ? OUTCOME_TONE[rollup] : 'neutral'}
                icon={rollup ? OUTCOME_ICONS[rollup] : CircleDashed}
                onClick={() => onShow('Checks')}
              >
                <ChecksSentence summary={summary} />
              </FactLink>
            </Fact>
          )}
          {isPr && (
            <Fact label="Changes">
              <FactLink tone="neutral" icon={FileDiff} onClick={() => onShow('Files changed')}>
                <DiffCounts additions={additions} deletions={deletions} /> in {plural(details.files.length, 'file')}
              </FactLink>
            </Fact>
          )}
          {details.labels.length > 0 && (
            <Fact label="Labels">
              <span className="inbox-detail-labels">
                {details.labels.map((label) => (
                  <span key={label} className="inbox-detail-label">{label}</span>
                ))}
              </span>
            </Fact>
          )}
          {details.assignees.length > 0 && <Fact label="Assignees">{details.assignees.join(', ')}</Fact>}
        </dl>
      )}
      <div className="inbox-detail-description">
        {details.body ? (
          <WorkItemMarkdown workspaceId={workspaceId} content={details.body} />
        ) : (
          <p className="inbox-detail-empty">No description provided.</p>
        )}
      </div>
    </>
  );
}

/** Who a Fix button hands its prompt to, in the words the buttons use. */
export type FixTarget = 'a session' | 'this session';

export function ConversationTimeline({
  workspaceId,
  comments,
  canFix,
  fixTarget = 'a session',
  onFix,
}: {
  workspaceId: string;
  comments: WorkItemComment[];
  canFix: boolean;
  fixTarget?: FixTarget;
  onFix: (comment: WorkItemComment) => void;
}) {
  if (comments.length === 0) {
    return (
      <p className="inbox-detail-empty inbox-detail-empty--icon">
        <MessageSquare size={16} aria-hidden="true" />
        No comments yet. Start the conversation below.
      </p>
    );
  }
  return (
    <ol className="inbox-detail-timeline">
      {comments.map((comment) => {
        const { verb, tone } = commentVerb(comment);
        const age = commentAge(comment.createdAt);
        const fixable = canFix && (comment.kind === 'inline' || comment.state === 'CHANGES_REQUESTED');
        const VerdictIcon = tone ? TONE_ICONS[tone] : null;
        return (
          <li className="inbox-detail-event" key={comment.id}>
            <span className="inbox-detail-avatar" data-tone={tone} aria-hidden="true">
              {initial(comment.author)}
            </span>
            <article className="inbox-detail-event-main">
              <header className="inbox-detail-event-head">
                <strong className="inbox-detail-event-author">{comment.author}</strong>
                {VerdictIcon ? (
                  <span className="inbox-detail-pill" data-tone={tone}>
                    <VerdictIcon size={12} aria-hidden="true" />
                    {verb}
                  </span>
                ) : (
                  <span className="inbox-detail-event-verb">{verb}</span>
                )}
                {comment.path && (
                  <code className="inbox-detail-path">
                    {comment.path}
                    {comment.line ? `:${comment.line}` : ''}
                  </code>
                )}
                {age && (
                  <time className="inbox-detail-event-time" dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>
                    {age}
                  </time>
                )}
                {comment.url && (
                  <a
                    className="inbox-detail-icon-link"
                    href={comment.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${comment.author}’s comment on GitHub`}
                    title="Open on GitHub"
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                )}
              </header>
              {comment.body.trim() && (
                <div className="inbox-detail-event-body">
                  <WorkItemMarkdown workspaceId={workspaceId} content={comment.body} />
                </div>
              )}
              {fixable && (
                <button type="button" className="inbox-detail-btn inbox-detail-btn--small inbox-detail-btn--tinted" data-tone="accent" onClick={() => onFix(comment)}>
                  <Wrench size={13} aria-hidden="true" />
                  Fix in {fixTarget}
                </button>
              )}
            </article>
          </li>
        );
      })}
    </ol>
  );
}

const FILE_ICONS: Record<string, LucideIcon> = {
  added: FilePlus,
  removed: FileMinus,
  renamed: FileSymlink,
  copied: FileSymlink,
};

function DiffBlocks({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inbox-detail-blocks" aria-hidden="true">
      {diffBlocks(additions, deletions).map((block, index) => (
        <i key={index} className={`inbox-detail-block inbox-detail-block--${block}`} />
      ))}
    </span>
  );
}

function DiffView({ path, patch }: { path: string; patch: string }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  return (
    // Focusable so a keyboard can scroll a long or wide diff.
    <pre className="inbox-detail-diff" aria-label={`Diff for ${path}`} tabIndex={0}>
      <code>
        {rows.map((row, index) => (
          <span key={index} className={`diff-row diff-row--${row.kind}`}>
            <span className="diff-num" aria-hidden="true">{row.oldLine || ''}</span>
            <span className="diff-num" aria-hidden="true">{row.newLine || ''}</span>
            <span className="diff-text">{row.text}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}

/** A collapsed file renders no diff at all: a large PR stays cheap until opened. */
function ChangedFile({ file }: { file: DetailFile }) {
  const [open, setOpen] = useState(false);
  const { dir, name } = splitPath(file.path);
  const status = fileStatus(file.status);
  const Icon = FILE_ICONS[file.status] ?? FileDiff;
  return (
    <details className="inbox-detail-file" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary title={`${status.label} · ${file.path}`}>
        <ChevronRight size={14} className="inbox-detail-file-chevron" aria-hidden="true" />
        <Icon size={14} className="inbox-detail-tone-icon" data-tone={status.tone} aria-hidden="true" />
        <span className="sr-only">{status.label}: </span>
        <span className="inbox-detail-file-path">
          <span className="inbox-detail-file-dir">{dir}</span>
          <span className="inbox-detail-file-name">{name}</span>
        </span>
        <span className="inbox-detail-file-stat">
          <DiffCounts additions={file.additions} deletions={file.deletions} />
          <DiffBlocks additions={file.additions} deletions={file.deletions} />
        </span>
      </summary>
      {open &&
        (file.patch ? (
          <DiffView path={file.path} patch={file.patch} />
        ) : (
          <p className="inbox-detail-hint inbox-detail-file-note">
            GitHub did not provide a text diff for this file. It may be binary or too large to show.
          </p>
        ))}
    </details>
  );
}

export function FilesTab({ files, itemUrl }: { files: DetailFile[]; itemUrl: string }) {
  const { additions, deletions } = totals(files);
  return (
    <>
      <div className="inbox-detail-tab-head">
        <span>
          {plural(files.length, 'file')} changed <DiffCounts additions={additions} deletions={deletions} />
        </span>
        <a className="inbox-detail-text-link" href={`${itemUrl}/files`} target="_blank" rel="noreferrer">
          View full diff on GitHub
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>
      {files.length === 0 ? (
        <p className="inbox-detail-empty">No changed files.</p>
      ) : (
        <div className="inbox-detail-files">
          {files.map((file) => (
            <ChangedFile key={file.path} file={file} />
          ))}
        </div>
      )}
    </>
  );
}

export function ChecksTab({
  checks,
  canFix,
  fixTarget = 'a session',
  onFixChecks,
}: {
  checks: WorkItemDetails['checks'];
  canFix: boolean;
  fixTarget?: FixTarget;
  onFixChecks: () => void;
}) {
  const summary = summarizeChecks(checks);
  if (checks.length === 0) return <p className="inbox-detail-empty">No checks reported for this commit.</p>;
  const present = OUTCOMES.filter((outcome) => summary[outcome] > 0);
  return (
    <>
      <div className="inbox-detail-checks-head">
        {/* The sentence beside it says the same thing in words. */}
        <div className="inbox-detail-meter" aria-hidden="true">
          {present.map((outcome) => (
            <span key={outcome} data-tone={OUTCOME_TONE[outcome]} style={{ flexGrow: summary[outcome] }} />
          ))}
        </div>
        <p className="inbox-detail-checks-sentence">
          <ChecksSentence summary={summary} />
        </p>
      </div>
      {canFix && summary.failing > 0 && (
        <div className="inbox-detail-callout" data-tone="error">
          <p>
            <strong>{plural(summary.failing, 'check')} failing.</strong>{' '}
            {fixTarget === 'this session' ? 'This session' : 'A session'} can read the logs, fix the cause and push.
          </p>
          <button type="button" className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent" onClick={onFixChecks}>
            <Wrench size={13} aria-hidden="true" />
            Fix failing checks in {fixTarget}
          </button>
        </div>
      )}
      <ul className="inbox-detail-checklist">
        {sortChecks(checks).map((check, index) => {
          const outcome = checkOutcome(check.state);
          return (
            <li className="inbox-detail-check" key={`${check.name}:${index}`}>
              <CheckIcon outcome={outcome} />
              <span className="inbox-detail-check-name">
                {check.url ? (
                  <a className="inbox-detail-text-link" href={check.url} target="_blank" rel="noreferrer">
                    {check.name}
                  </a>
                ) : (
                  check.name
                )}
              </span>
              <span className="inbox-detail-check-state inbox-detail-toned" data-tone={OUTCOME_TONE[outcome]}>
                {checkLabel(check.state)}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
