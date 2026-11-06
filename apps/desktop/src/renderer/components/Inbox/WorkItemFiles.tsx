import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileDiff,
  FileMinus,
  FilePlus,
  FileSymlink,
  MessageSquare,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import type { WorkItemDetails, WorkItemThread } from '../../../shared/workItemDetails';
import { MOD_KEY, isSubmitChord } from './inboxPresentation';
import {
  diffBlocks,
  fileStatus,
  hunkOf,
  parsePatch,
  rangeLabel,
  rowAnchor,
  selectionRange,
  splitPath,
  suggestionText,
  threadRow,
  type DiffRow,
  type LineRange,
} from './workItemDetailPresentation';
import { DiffCounts, Messages, useWorkItemDetail } from './WorkItemDetailParts';
import { MarkdownEditor } from './WorkItemMarkdownEditor';
import { ReviewThread } from './WorkItemThread';

type DetailFile = WorkItemDetails['files'][number];
type ReviewEvent = 'comment' | 'approve' | 'request-changes';

const FILE_ICONS: Record<string, LucideIcon> = {
  added: FilePlus,
  removed: FileMinus,
  renamed: FileSymlink,
  copied: FileSymlink,
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function DiffBlocks({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inbox-detail-blocks" aria-hidden="true">
      {diffBlocks(additions, deletions).map((block, index) => (
        <i key={index} className={`inbox-detail-block inbox-detail-block--${block}`} />
      ))}
    </span>
  );
}

const sign = (row: DiffRow) => (row.kind === 'del' ? `−${row.oldLine}` : `+${row.newLine}`);

/** One line of a diff. Memoised: selecting a range re-renders the lines it touches, not the file. */
const DiffLine = memo(function DiffLine({
  row,
  index,
  id,
  commentable,
  selected,
  active,
  onBegin,
  onExtend,
}: {
  row: DiffRow;
  index: number;
  id: string;
  commentable: boolean;
  selected: boolean;
  active: boolean;
  onBegin: (index: number, event: MouseEvent) => void;
  onExtend: (index: number) => void;
}) {
  const anchor = commentable ? rowAnchor(row) : null;
  const begin = anchor ? (event: MouseEvent) => onBegin(index, event) : undefined;
  return (
    <div
      id={id}
      className={`diff-row diff-row--${row.kind}`}
      data-selected={selected || undefined}
      data-active={active || undefined}
      data-commentable={anchor ? '' : undefined}
      onMouseEnter={anchor ? () => onExtend(index) : undefined}
    >
      <span className="diff-num" aria-hidden="true" onMouseDown={begin}>{row.oldLine || ''}</span>
      <span className="diff-num" aria-hidden="true" onMouseDown={begin}>{row.newLine || ''}</span>
      {commentable && (
        <span className="diff-gutter">
          {anchor && (
            <button type="button" tabIndex={-1} className="diff-add" aria-label={`Comment on line ${sign(row)}`} onMouseDown={begin}>
              <Plus size={12} strokeWidth={2.5} aria-hidden="true" />
            </button>
          )}
        </span>
      )}
      <span className="diff-text">{row.text}</span>
    </div>
  );
});

function LineCommentForm({
  path,
  range,
  suggestion,
  draft,
  onDraft,
  onClose,
}: {
  path: string;
  range: LineRange;
  suggestion: string | null;
  draft: string;
  onDraft: (value: string) => void;
  onClose: (posted: boolean) => void;
}) {
  const { details, busy, perform } = useWorkItemDetail();
  const pending = details.pendingReview;
  const at = `line:${path}`;
  const submit = async (mode: 'single' | 'review') => {
    if (busy || !draft.trim() || !details.headOid) return;
    const ok = await perform(
      { kind: 'line-comment', mode, ...(mode === 'review' && pending ? { pendingReviewId: pending.id } : {}), headOid: details.headOid, path, ...range, body: draft },
      mode === 'single' ? 'Comment posted.' : pending ? 'Added to your review.' : 'Review started: your comment is pending until you submit it.',
      at
    );
    if (ok) onClose(true);
  };
  const label = rangeLabel(range);
  return (
    <div className="inbox-detail-line-form" role="group" aria-label={label}>
      <p className="inbox-detail-line-form-title">{label}</p>
      <MarkdownEditor
        value={draft}
        onChange={onDraft}
        label="Line comment"
        placeholder="Leave a comment"
        toolbar="compact"
        rows={3}
        autoFocus
        disabled={busy}
        suggestion={suggestion}
        onSubmit={() => void submit(pending ? 'review' : 'single')}
        onCancel={() => onClose(false)}
      />
      <div className="inbox-detail-form-foot">
        <span className="inbox-detail-kbd-hint" aria-hidden="true"><kbd>{MOD_KEY}</kbd><kbd>↵</kbd> {pending ? 'add' : 'comment'} · <kbd>Esc</kbd> cancel</span>
        <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={() => onClose(false)}>Cancel</button>
        {pending ? (
          <button type="button" className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent" disabled={busy || !draft.trim()} onClick={() => void submit('review')}>
            Add review comment
          </button>
        ) : (
          <>
            {/* GitHub keeps one pending review per person, and a single comment cannot be posted beside one. */}
            <button type="button" className="inbox-detail-btn" disabled={busy || !draft.trim()} onClick={() => void submit('single')}>
              Add single comment
            </button>
            <button type="button" className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent" disabled={busy || !draft.trim()} onClick={() => void submit('review')}>
              Start a review
            </button>
          </>
        )}
      </div>
      <Messages at={at} />
    </div>
  );
}

/**
 * A file's diff, with its threads under their lines and, on an open pull
 * request, comments made on lines as on github.com: the + beside a line,
 * Shift-click or a drag for a range inside one hunk. From the keyboard, the
 * diff is one tab stop: arrows move between lines, Shift extends, Enter (or
 * C) comments, Esc lets go.
 */
function DiffView({ file, threads, commentable }: { file: DetailFile; threads: WorkItemThread[]; commentable: boolean }) {
  const rows = useMemo(() => parsePatch(file.patch ?? ''), [file.patch]);
  const hunks = useMemo(() => hunkOf(rows), [rows]);
  const placed = useMemo(() => {
    const at = new Map<number, WorkItemThread[]>();
    for (const thread of threads) {
      const index = threadRow(rows, thread);
      if (index >= 0) at.set(index, [...(at.get(index) ?? []), thread]);
    }
    return at;
  }, [rows, threads]);
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  // The form's last place: where its outcome is said once it has closed.
  const [formRow, setFormRow] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const dragging = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const uid = useId();
  const rowId = (index: number) => `${uid}-row-${index}`;
  const lineable = useCallback((index: number) => commentable && !!rows[index] && rowAnchor(rows[index]) !== null, [commentable, rows]);

  const onBegin = useCallback((index: number, event: MouseEvent) => {
    if (event.button !== 0 || !lineable(index)) return;
    event.preventDefault();
    const current = selectionRef.current;
    setSelection(event.shiftKey && current && hunks[current.anchor] === hunks[index] ? { anchor: current.anchor, focus: index } : { anchor: index, focus: index });
    setActive(index);
    dragging.current = true;
    const end = () => {
      dragging.current = false;
      setFormOpen(true);
      window.removeEventListener('mouseup', end);
    };
    window.addEventListener('mouseup', end);
  }, [hunks, lineable]);

  const onExtend = useCallback((index: number) => {
    const current = selectionRef.current;
    if (!dragging.current || !current || hunks[index] !== hunks[current.anchor]) return;
    setSelection({ anchor: current.anchor, focus: index });
  }, [hunks]);

  const [lo, hi] = selection ? [Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)] : [-1, -1];
  const range = selection ? selectionRange(rows, selection.anchor, selection.focus) : null;
  useEffect(() => {
    if (formOpen && range) setFormRow(hi);
  }, [formOpen, hi, range !== null]);

  const close = (posted: boolean) => {
    setFormOpen(false);
    setSelection(null);
    if (posted) setDraft('');
    // The form that had focus is gone: the diff it came from takes it back.
    requestAnimationFrame(() => container.current?.focus({ preventScroll: true }));
  };

  const step = (from: number | null, direction: 1 | -1): number | null => {
    let index = from ?? (direction > 0 ? -1 : rows.length);
    do index += direction;
    while (index >= 0 && index < rows.length && !lineable(index));
    return index >= 0 && index < rows.length ? index : from;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in a thread or the form below a line are theirs.
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      // Each run of lines scrolls on its own; from the keyboard they move together.
      event.preventDefault();
      const by = event.key === 'ArrowRight' ? 48 : -48;
      event.currentTarget.querySelectorAll<HTMLElement>('.inbox-detail-diff-lines').forEach((run) => { run.scrollLeft += by; });
      return;
    }
    if (!commentable) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = step(active, event.key === 'ArrowDown' ? 1 : -1);
      if (next === null) return;
      setActive(next);
      if (event.shiftKey) {
        const anchor = selection?.anchor ?? active ?? next;
        if (hunks[anchor] === hunks[next]) setSelection({ anchor, focus: next });
      } else if (!formOpen) {
        setSelection(null);
      }
      document.getElementById(rowId(next))?.scrollIntoView({ block: 'nearest' });
    } else if ((event.key === 'Enter' || event.key === 'c') && (selection || active !== null) && !isSubmitChord(event)) {
      event.preventDefault();
      if (!selection && active !== null) setSelection({ anchor: active, focus: active });
      setFormOpen(true);
    } else if (event.key === 'Escape' && (selection || active !== null)) {
      event.preventDefault();
      setSelection(null);
      setActive(null);
      setFormOpen(false);
    }
  };

  const blocks: ReactNode[] = [];
  let lines: ReactNode[] = [];
  const flush = (key: string) => {
    if (lines.length) {
      blocks.push(
        <div key={`lines-${key}`} className="inbox-detail-diff-lines">
          <div className="inbox-detail-diff-rows">{lines}</div>
        </div>
      );
    }
    lines = [];
  };
  rows.forEach((row, index) => {
    lines.push(
      <DiffLine
        key={index}
        row={row}
        index={index}
        id={rowId(index)}
        commentable={commentable}
        selected={index >= lo && index <= hi}
        active={index === active}
        onBegin={onBegin}
        onExtend={onExtend}
      />
    );
    const here = placed.get(index);
    const form = formOpen && range && index === hi;
    const said = !formOpen && formRow === index;
    if (here || form || said) {
      flush(String(index));
      blocks.push(
        <div key={`inline-${index}`} className="inbox-detail-diff-inline">
          {here?.map((thread) => <ReviewThread key={thread.id} thread={thread} placement="diff" />)}
          {form && (
            <LineCommentForm
              path={file.path}
              range={range}
              suggestion={suggestionText(rows, lo, hi)}
              draft={draft}
              onDraft={setDraft}
              onClose={close}
            />
          )}
          {said && <Messages at={`line:${file.path}`} />}
        </div>
      );
    }
  });
  flush('end');

  return (
    <div
      ref={container}
      className="inbox-detail-diff"
      role="group"
      aria-label={`Diff for ${file.path}`}
      aria-describedby={`${uid}-keys`}
      aria-activedescendant={active !== null ? rowId(active) : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <span id={`${uid}-keys`} className="sr-only">
        {commentable
          ? 'Up and down move between lines, Shift with them selects several, Enter comments on them. Left and right scroll.'
          : 'Left and right scroll.'}
      </span>
      {blocks}
    </div>
  );
}

/** A collapsed file renders no diff at all: a large PR stays cheap until opened. */
function ChangedFile({
  file,
  open,
  onToggle,
  threads,
  commentable,
}: {
  file: DetailFile;
  open: boolean;
  onToggle: (open: boolean) => void;
  threads: WorkItemThread[];
  commentable: boolean;
}) {
  const { dir, name } = splitPath(file.path);
  const status = fileStatus(file.status);
  const Icon = FILE_ICONS[file.status] ?? FileDiff;
  const conversations = threads.filter((thread) => !thread.isResolved).length;
  return (
    <details className="inbox-detail-file" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary title={`${status.label} · ${file.path}`}>
        <ChevronRight size={14} className="inbox-detail-file-chevron" aria-hidden="true" />
        <Icon size={14} className="inbox-detail-tone-icon" data-tone={status.tone} aria-hidden="true" />
        <span className="sr-only">{status.label}: </span>
        <span className="inbox-detail-file-path">
          <span className="inbox-detail-file-dir">{dir}</span>
          <span className="inbox-detail-file-name">{name}</span>
        </span>
        {conversations > 0 && (
          <span className="inbox-detail-file-threads" title={`${plural(conversations, 'open conversation')}`}>
            <MessageSquare size={12} aria-hidden="true" />
            {conversations}
            <span className="sr-only"> open conversation{conversations === 1 ? '' : 's'}</span>
          </span>
        )}
        <span className="inbox-detail-file-stat">
          <DiffCounts additions={file.additions} deletions={file.deletions} />
          <DiffBlocks additions={file.additions} deletions={file.deletions} />
        </span>
      </summary>
      {open &&
        (file.patch ? (
          <DiffView file={file} threads={threads} commentable={commentable} />
        ) : (
          <p className="inbox-detail-hint inbox-detail-file-note">
            GitHub did not provide a text diff for this file. It may be binary or too large to show.
          </p>
        ))}
    </details>
  );
}

const EVENTS: Array<{ event: ReviewEvent; label: string; description: string; verdict: boolean }> = [
  { event: 'comment', label: 'Comment', description: 'Submit general feedback without explicit approval.', verdict: false },
  { event: 'approve', label: 'Approve', description: 'Give your approval to merge these changes.', verdict: true },
  { event: 'request-changes', label: 'Request changes', description: 'Submit feedback that must be addressed before merging.', verdict: true },
];

/** GitHub's "Finish your review": a summary, a verdict, and the pending comments it sends. */
function SubmitReview({ open, onOpenChange, boundary }: { open: boolean; onOpenChange: (open: boolean) => void; boundary: HTMLElement | null }) {
  const { details, ownItem, busy, perform } = useWorkItemDetail();
  const pending = details.pendingReview;
  const pendingCount = pending?.commentCount ?? 0;
  const [event, setEvent] = useState<ReviewEvent>('comment');
  const [body, setBody] = useState('');
  const [discarding, setDiscarding] = useState(false);
  const summaryField = useRef<HTMLTextAreaElement>(null);
  const uid = useId();
  const blocked = ownItem && event !== 'comment';
  // Approving needs nothing more; anything else says something or sends comments.
  const canSubmit = !busy && !blocked && (event === 'approve' || body.trim().length > 0 || pendingCount > 0);

  const submit = async () => {
    if (!canSubmit) return;
    if (await perform({ kind: 'review', event, body, ...(pending ? { pendingReviewId: pending.id } : {}) }, 'Review submitted.', 'review')) {
      setBody('');
      setEvent('comment');
      onOpenChange(false);
    }
  };
  const discard = async () => {
    if (!pending || busy) return;
    if (await perform({ kind: 'discard-review', reviewId: pending.id }, 'Review discarded.', 'review')) {
      setDiscarding(false);
      onOpenChange(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setDiscarding(false); }}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`inbox-detail-btn inbox-detail-btn--small ${pending ? 'inbox-detail-btn--solid inbox-detail-btn--accent' : 'inbox-detail-btn--tinted'}`}
          data-tone="accent"
        >
          Submit review
          {pending && <span className="inbox-detail-btn-count">{pendingCount}</span>}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      {/* On <body>, like every menu: inside the pane, its container query would
          become the popover's containing block and misplace it. The pane is
          still its boundary, so it is never wider than the pane. */}
      <Popover.Portal>
        <Popover.Content
          className="inbox-detail inbox-detail-review-popover"
          align="end"
          sideOffset={6}
          collisionBoundary={boundary}
          collisionPadding={{ top: 8, bottom: 8 }}
          aria-labelledby={`${uid}-title`}
          onOpenAutoFocus={(focusEvent) => {
            focusEvent.preventDefault();
            summaryField.current?.focus();
          }}
        >
          <h3 id={`${uid}-title`} className="inbox-detail-review-title">Finish your review</h3>
          <textarea
            ref={summaryField}
            aria-label="Review summary"
            placeholder="Leave a summary (optional). Markdown supported."
            value={body}
            rows={4}
            maxLength={65536}
            disabled={busy}
            onChange={(change) => setBody(change.target.value)}
            onKeyDown={(key) => {
              if (isSubmitChord(key)) {
                key.preventDefault();
                void submit();
              }
            }}
          />
          <fieldset className="inbox-detail-review-events" disabled={busy}>
            <legend className="sr-only">Review verdict</legend>
            {EVENTS.map((option) => {
              const unavailable = option.verdict && ownItem;
              return (
                <label key={option.event} className="inbox-detail-review-event" data-disabled={unavailable || undefined}>
                  <input
                    type="radio"
                    name={`${uid}-event`}
                    value={option.event}
                    checked={event === option.event}
                    disabled={unavailable}
                    onChange={() => setEvent(option.event)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <span className="inbox-detail-hint">{option.description}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {ownItem && <p className="inbox-detail-hint">You can’t approve or request changes on your own pull request.</p>}
          {discarding ? (
            <div className="inbox-detail-confirm" data-tone="error" role="group" aria-label="Confirm discard">
              <p className="inbox-detail-confirm-title">
                Discard your pending review{pendingCount ? ` and its ${plural(pendingCount, 'comment')}` : ''}?
              </p>
              <div className="inbox-detail-form-foot">
                <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={() => setDiscarding(false)}>Keep review</button>
                <button type="button" autoFocus className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--danger-solid" disabled={busy} onClick={() => void discard()}>
                  Discard review
                </button>
              </div>
            </div>
          ) : (
            <div className="inbox-detail-form-foot">
              {pendingCount > 0 && <span className="inbox-detail-kbd-hint">Sends {plural(pendingCount, 'pending comment')}</span>}
              {pending && (
                <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={() => setDiscarding(true)}>
                  Discard review
                </button>
              )}
              <button type="button" className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent" disabled={!canSubmit} onClick={() => void submit()}>
                {busy ? 'Submitting…' : 'Submit review'}
              </button>
            </div>
          )}
          <Messages at="review" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Files changed: the diff to review, threads where they were left, and on
 * an open pull request, comments on lines and a review to submit. Once it is
 * merged or closed the diff is read-only, as on GitHub, though its threads
 * can still be answered and resolved.
 */
export function FilesChanged({
  reviewOpen,
  onReviewOpenChange,
  boundary,
}: {
  reviewOpen: boolean;
  onReviewOpenChange: (open: boolean) => void;
  boundary: HTMLElement | null;
}) {
  const { details, open } = useWorkItemDetail();
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const files = details.files;
  const allOpen = files.length > 0 && files.every((file) => opened.has(file.path));
  const threadsByPath = useMemo(() => {
    const byPath = new Map<string, WorkItemThread[]>();
    for (const thread of details.threads) {
      // Outdated threads are about lines no longer here; Conversation keeps them.
      if (thread.isOutdated || thread.line === undefined) continue;
      byPath.set(thread.path, [...(byPath.get(thread.path) ?? []), thread]);
    }
    return byPath;
  }, [details.threads]);
  const additions = details.additions ?? files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = details.deletions ?? files.reduce((sum, file) => sum + file.deletions, 0);
  const toggle = (path: string, next: boolean) =>
    setOpened((current) => {
      if (current.has(path) === next) return current;
      const copy = new Set(current);
      if (next) copy.add(path);
      else copy.delete(path);
      return copy;
    });

  return (
    <>
      <div className="inbox-detail-files-head">
        <span className="inbox-detail-files-count">
          {plural(files.length, 'file')} <DiffCounts additions={additions} deletions={deletions} />
        </span>
        {files.length > 0 && (
          <button
            type="button"
            className="inbox-detail-btn inbox-detail-btn--small inbox-detail-btn--quiet"
            onClick={() => setOpened(allOpen ? new Set() : new Set(files.map((file) => file.path)))}
          >
            {allOpen ? <ChevronsDownUp size={13} aria-hidden="true" /> : <ChevronsUpDown size={13} aria-hidden="true" />}
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        )}
        {open && <SubmitReview open={reviewOpen} onOpenChange={onReviewOpenChange} boundary={boundary} />}
      </div>
      {!reviewOpen && <Messages at="review" />}
      {files.length === 0 ? (
        <p className="inbox-detail-empty">No changed files.</p>
      ) : (
        <div className="inbox-detail-files">
          {files.map((file) => (
            <ChangedFile
              key={file.path}
              file={file}
              open={opened.has(file.path)}
              onToggle={(next) => toggle(file.path, next)}
              threads={threadsByPath.get(file.path) ?? []}
              commentable={open}
            />
          ))}
        </div>
      )}
    </>
  );
}
