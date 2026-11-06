import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  CircleAlert,
  CircleCheck,
  Ellipsis,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Pencil,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react';
import type { InboxItem } from '../../../shared/workItems';
import type { WorkItemComment, WorkItemDetails, WorkItemMutation } from '../../../shared/workItemDetails';
import { inboxBridge } from '../../services/inboxBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import {
  BranchPair,
  ChecksTab,
  CheckIcon,
  ConversationTimeline,
  FilesTab,
  OverviewTab,
  rollupOutcome,
  type DetailTab,
  type FixTarget,
} from './WorkItemDetailTabs';
import { mergeGate, mergeStateMeta, summarizeChecks } from './workItemDetailPresentation';
import { MOD_KEY, isSubmitChord } from './inboxPresentation';

interface Props {
  workspaceId: string;
  accountLogin: string;
  item: InboxItem;
  /**
   * Where the item's status strip goes: branches, account, refresh and the ⋯
   * menu, with what that menu opens. The pane puts it above its sessions
   * dock, apart from the tabs. Null until the pane has mounted it.
   */
  headSlot: HTMLElement | null;
  /** Hand a fix prompt to a session. A returned string is why it could not, shown as an error. */
  onFix: (prompt: string) => string | void;
  fixTarget?: FixTarget;
  /** Every fresh read, so the pane's header can follow an edited title. */
  onDetails?: (details: WorkItemDetails) => void;
}

type ReviewEvent = 'comment' | 'approve' | 'request-changes';
type Confirmable = 'close' | 'merge' | 'auto-merge';
/**
 * Where the outcome of an action is said: beside what asked for it. The
 * strip's actions are above the sessions dock and merging is at the foot of
 * Overview, too far apart for one place to serve both.
 */
type MessageAt = 'head' | 'body';

/** A confirmation is read, then gone; an error stays until dismissed or retried. */
const NOTICE_MS = 5000;
/** GitHub works mergeability out lazily; UNKNOWN means "ask again shortly". */
const MERGE_STATE_POLL_MS = 3000;
const MERGE_STATE_POLLS = 5;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

export function WorkItemDetailPanel({ workspaceId, accountLogin, item, headSlot, onFix, fixTarget = 'a session', onDetails }: Props) {
  const [details, setDetails] = useState<WorkItemDetails | null>(null);
  const [tab, setTab] = useState<DetailTab>('Overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [messageAt, setMessageAt] = useState<MessageAt>('head');
  const [body, setBody] = useState('');
  const [review, setReview] = useState<ReviewEvent>('comment');
  const [composer, setComposer] = useState<'comment' | 'review'>('comment');
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [confirm, setConfirm] = useState<Confirmable | null>(null);
  const [method, setMethod] = useState<'squash' | 'merge' | 'rebase'>('squash');
  const alive = useRef(true);
  const writing = useRef(false);
  const request = useRef(0);
  const confirmFocusRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleFieldRef = useRef<HTMLInputElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  // What a ⋯ menu item opened, to focus once the menu has closed. Not before:
  // while it closes, the menu still traps focus and would pull it back.
  const menuFocusTarget = useRef<(() => HTMLElement | null) | null>(null);
  const uid = useId();
  const ref = item.workItem;
  const isPr = ref.type === 'pr';
  const noun = isPr ? 'Pull request' : 'Issue';

  /** A quiet read neither shows the spinner nor clears an error the person has yet to read. */
  async function refresh({ quiet = false } = {}) {
    const version = ++request.current;
    if (!quiet) {
      setLoading(true);
      setError('');
    }
    try {
      const next = await inboxBridge.getDetails(workspaceId, ref);
      if (alive.current && version === request.current) {
        setDetails(next);
        onDetails?.(next);
      }
    } catch (error) {
      if (alive.current && version === request.current && !quiet) {
        setMessageAt('head');
        setError(`Could not refresh details: ${ipcErrorMessage(error)}`);
      }
    } finally {
      if (alive.current && version === request.current && !quiet) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; request.current++; };
  }, [workspaceId, accountLogin, ref.repo, ref.type, ref.number]);

  // GitHub's own page keeps asking while it works mergeability out; without
  // this, a merge button disabled for UNKNOWN would stay so until a refresh.
  const mergeStatePolls = useRef(0);
  useEffect(() => {
    if (details?.mergeState !== 'UNKNOWN' || mergeStatePolls.current >= MERGE_STATE_POLLS) return;
    const timer = window.setTimeout(() => {
      mergeStatePolls.current++;
      void refresh({ quiet: true });
    }, MERGE_STATE_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [details]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Opening a confirmation moves focus into it, so Enter and Escape act on it.
  useEffect(() => {
    if (confirm) confirmFocusRef.current?.focus();
  }, [confirm]);

  async function perform(mutation: WorkItemMutation, success: string, at: MessageAt) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setMessageAt(at);
    try {
      await inboxBridge.mutateItem(workspaceId, ref, mutation);
      if (!alive.current) return;
      setNotice(success);
      setConfirm(null);
      if (mutation.kind === 'comment' || mutation.kind === 'review') setBody('');
      // A review is a one-off verdict: what is typed next is a comment, not a second approval.
      if (mutation.kind === 'review') { setComposer('comment'); setReview('comment'); }
      if (mutation.kind === 'edit') setEditing(false);
      await refresh();
    } catch (error) {
      if (alive.current) setError(ipcErrorMessage(error));
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function openConfirm(kind: Confirmable, trigger: HTMLElement) {
    returnFocusRef.current = trigger;
    setConfirm(kind);
  }

  function dismiss(setClosed: () => void) {
    setClosed();
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  }

  // From the ⋯ menu, which takes focus back once the form is done.
  function startEdit(current: WorkItemDetails) {
    menuFocusTarget.current = () => titleFieldRef.current;
    returnFocusRef.current = menuTriggerRef.current;
    // Choosing Edit again keeps what is being typed.
    if (!editing) {
      setTitleDraft(current.title);
      setDescriptionDraft(current.body);
    }
    setEditing(true);
  }

  function startClose() {
    menuFocusTarget.current = () => confirmFocusRef.current;
    if (menuTriggerRef.current) openConfirm('close', menuTriggerRef.current);
  }

  const open = details?.state === 'open';
  const ownPr = details?.author.toLowerCase() === accountLogin.toLowerCase();
  const disabled = busy || loading;
  const tabs: DetailTab[] = isPr ? ['Overview', 'Conversation', 'Files changed', 'Checks'] : ['Overview', 'Conversation'];
  const summary = summarizeChecks(details?.checks ?? []);
  const checksRollup = rollupOutcome(summary);

  const reviewBlocked = composer === 'review' && (!open || (ownPr && review !== 'comment'));
  const canSend = !disabled && !reviewBlocked && (body.trim().length > 0 || (composer === 'review' && review === 'approve'));
  // The send button wears the verdict it submits.
  const sendTone = composer === 'review' && review === 'approve' ? 'success' : composer === 'review' && review === 'request-changes' ? 'danger-solid' : 'accent';

  function send() {
    void perform(
      composer === 'review' ? { kind: 'review', event: review, body } : { kind: 'comment', body },
      composer === 'review' ? 'Review submitted.' : 'Comment posted.',
      'body'
    );
  }

  function confirmAction(current: WorkItemDetails) {
    if (confirm === 'close') void perform({ kind: 'close' }, `${noun} closed.`, 'head');
    else {
      const auto = confirm === 'auto-merge';
      void perform(
        { kind: 'merge', method, auto, headOid: current.headOid! },
        auto ? 'Auto-merge requested.' : 'Merge requested.',
        'body'
      );
    }
  }

  function handOff(prompt: string) {
    const refusal = onFix(prompt);
    if (refusal) {
      setNotice('');
      setMessageAt('body');
      setError(refusal);
    }
  }

  function fixComment(comment: WorkItemComment) {
    handOff(`Address this review feedback on ${item.url}:\n${comment.url}\n\n${comment.body}\n\nInspect the current code, implement the fix, and validate it.`);
  }

  const mergeWarning = (() => {
    if (!details) return '';
    const parts: string[] = [];
    if (details.mergeState) {
      const meta = mergeStateMeta(details.mergeState, details.baseBranch);
      if (meta.tone === 'warning' || meta.tone === 'error') parts.push(meta.label);
    }
    if (summary.failing) parts.push(`${summary.failing} failing check${summary.failing === 1 ? '' : 's'}`);
    return parts.join(' · ');
  })();
  // The merge button follows GitHub's own: green only when nothing stands in
  // the way, disabled whenever GitHub would refuse -- with auto-merge offered
  // in its place when what refuses it is requirements that can be waited out.
  const gate = mergeGate(details?.mergeState);
  // The one place the merge state is said: over the button it explains,
  // whenever GitHub would not merge cleanly. A disabled button shows no
  // tooltip of its own, and a plain one does not say why it is not green.
  const mergeMeta = details?.mergeState ? mergeStateMeta(details.mergeState, details.baseBranch) : null;
  const mergeNote = gate.button === 'disabled'
    ? `Can’t merge yet: ${lowerFirst(mergeMeta?.label ?? 'Checking mergeability')}.`
    : gate.button === 'plain' && mergeMeta ? `${mergeMeta.label}.` : '';
  const MergeNoteIcon = mergeMeta?.tone === 'error' ? CircleAlert : mergeMeta?.tone === 'warning' ? TriangleAlert : null;
  // Re-checked at confirm time: a refresh may have changed the answer since.
  const confirmAllowed = confirm === 'merge' ? gate.button !== 'disabled' : confirm === 'auto-merge' ? gate.canQueue : true;
  // Queuing auto-merge is a go: waiting for the requirements is what it asks for.
  const confirmGo = confirm === 'auto-merge' || (confirm === 'merge' && gate.button === 'go');

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home' ? 0
            : event.key === 'End' ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next]);
    (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
  };

  const messages = (at: MessageAt): ReactNode => messageAt === at && (
    <>
      {error && (
        <div className="inbox-detail-message" data-tone="error" role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          <p>{error}</p>
          <button className="inbox-detail-icon-btn" aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      {notice && (
        <div className="inbox-detail-message" data-tone="success" role="status">
          <CircleCheck size={15} aria-hidden="true" />
          {notice}
        </div>
      )}
    </>
  );

  /** Opens in place, under what asked: the ⋯ menu for close, the merge box for a merge. */
  const confirmation = (current: WorkItemDetails) => confirm && (
    <div
      className="inbox-detail-confirm"
      data-tone={confirm === 'close' ? 'error' : confirmGo ? 'success' : 'neutral'}
      role="group"
      aria-label={`Confirm ${confirm}`}
      onKeyDown={(event) => {
        // Handled here, so the Inbox's own Esc does not close the whole pane.
        if (event.key === 'Escape' && !busy) { event.preventDefault(); dismiss(() => setConfirm(null)); }
      }}
    >
      <p className="inbox-detail-confirm-title">
        {confirm === 'close' ? <GitPullRequestClosed size={15} aria-hidden="true" /> : <GitMerge size={15} aria-hidden="true" />}
        {confirm === 'close'
          ? `Close ${isPr ? 'pull request' : 'issue'} #${ref.number}?`
          : confirm === 'auto-merge'
            ? `Merge pull request #${ref.number} into ${current.baseBranch} once it can be?`
            : `Merge pull request #${ref.number} into ${current.baseBranch}?`}
      </p>
      {confirm !== 'close' ? (
        <>
          {mergeWarning && (
            <p className="inbox-detail-confirm-warning" data-tone="warning">
              <TriangleAlert size={14} aria-hidden="true" />
              {mergeWarning}
            </p>
          )}
          <label className="inbox-detail-field">
            <span>Method</span>
            <select
              ref={(node) => { confirmFocusRef.current = node; }}
              aria-label="Merge method"
              value={method}
              disabled={busy}
              onChange={(event) => setMethod(event.target.value as typeof method)}
            >
              <option value="squash">Squash and merge</option>
              <option value="merge">Create a merge commit</option>
              <option value="rebase">Rebase and merge</option>
            </select>
          </label>
          <p className="inbox-detail-hint">
            {confirm === 'auto-merge'
              ? 'GitHub merges it as soon as every requirement passes, if the repository allows auto-merge.'
              : 'GitHub enforces repository rules and supported merge methods.'}
          </p>
        </>
      ) : (
        <p className="inbox-detail-hint">It can be reopened later.</p>
      )}
      <div className="inbox-detail-form-foot">
        <button className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={() => dismiss(() => setConfirm(null))}>
          Cancel
        </button>
        <button
          ref={(node) => { if (confirm === 'close') confirmFocusRef.current = node; }}
          className={`inbox-detail-btn ${
            confirm === 'close' ? 'inbox-detail-btn--solid inbox-detail-btn--danger-solid'
              : confirmGo ? 'inbox-detail-btn--solid inbox-detail-btn--success' : ''
          }`}
          disabled={disabled || !confirmAllowed}
          onClick={() => confirmAction(current)}
        >
          {busy ? 'Working…' : confirm === 'close' ? 'Confirm close' : confirm === 'auto-merge' ? 'Enable auto-merge' : 'Confirm merge'}
        </button>
      </div>
    </div>
  );

  // The strip: what the item is built from and who acts on it, plus the
  // occasional edits to the item itself, one click away in the ⋯ menu.
  const head = (
    <div className="inbox-detail inbox-detail-head">
      <div className="inbox-detail-toolbar">
        {details?.headBranch && <BranchPair head={details.headBranch} base={details.baseBranch} />}
        <div className="inbox-detail-toolbar-tail">
          <span className="inbox-detail-account" title="Actions here run as this workspace’s GitHub account">
            <UserRound size={12} aria-hidden="true" />
            as {accountLogin}
          </span>
          <button
            className="inbox-detail-icon-btn"
            aria-label="Refresh details"
            title="Refresh details"
            disabled={disabled}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} className={loading ? 'inbox-detail-spin' : undefined} aria-hidden="true" />
          </button>
          {details && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild disabled={disabled}>
                <button ref={menuTriggerRef} className="inbox-detail-icon-btn" aria-label="More actions" title="More actions">
                  <Ellipsis size={15} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="dropdown-content"
                  sideOffset={4}
                  align="end"
                  onCloseAutoFocus={(event) => {
                    const target = menuFocusTarget.current?.();
                    menuFocusTarget.current = null;
                    if (!target) return;
                    event.preventDefault();
                    target.focus();
                  }}
                >
                  <DropdownMenu.Item className="dropdown-item" onSelect={() => startEdit(details)}>
                    <Pencil size={14} aria-hidden="true" />
                    <span>Edit title and description</span>
                  </DropdownMenu.Item>
                  {isPr && open && !details.isDraft && (
                    <DropdownMenu.Item
                      className="dropdown-item"
                      onSelect={() => void perform({ kind: 'ready', draft: true }, 'Converted to draft.', 'head')}
                    >
                      <GitPullRequestDraft size={14} aria-hidden="true" />
                      <span>Convert to draft</span>
                    </DropdownMenu.Item>
                  )}
                  {details.state !== 'merged' && <DropdownMenu.Separator className="dropdown-separator" />}
                  {details.state !== 'merged' && (open ? (
                    <DropdownMenu.Item className="dropdown-item dropdown-item-destructive" onSelect={startClose}>
                      {isPr ? <GitPullRequestClosed size={14} aria-hidden="true" /> : <CircleCheck size={14} aria-hidden="true" />}
                      <span>Close {noun.toLowerCase()}</span>
                    </DropdownMenu.Item>
                  ) : (
                    <DropdownMenu.Item
                      className="dropdown-item"
                      onSelect={() => void perform({ kind: 'reopen' }, `${noun} reopened.`, 'head')}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      <span>Reopen {noun.toLowerCase()}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      </div>

      {messages('head')}
      {details && confirm === 'close' && confirmation(details)}

      {details && editing && (
        <form
          className="inbox-detail-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && titleDraft.trim()) void perform({ kind: 'edit', title: titleDraft, body: descriptionDraft }, 'Changes saved.', 'head');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) { event.preventDefault(); dismiss(() => setEditing(false)); }
            if (isSubmitChord(event)) { event.preventDefault(); event.currentTarget.requestSubmit(); }
          }}
        >
          <label className="inbox-detail-field">
            <span>Title</span>
            <input
              ref={titleFieldRef}
              className="inbox-detail-title-input"
              value={titleDraft}
              maxLength={256}
              disabled={busy}
              autoFocus
              onChange={(event) => setTitleDraft(event.target.value)}
            />
          </label>
          <label className="inbox-detail-field">
            <span>Description</span>
            <textarea
              value={descriptionDraft}
              maxLength={65536}
              disabled={busy}
              rows={10}
              placeholder="Markdown supported"
              onChange={(event) => setDescriptionDraft(event.target.value)}
            />
          </label>
          <div className="inbox-detail-form-foot">
            <span className="inbox-detail-kbd-hint" aria-hidden="true"><kbd>{MOD_KEY}</kbd><kbd>↵</kbd> save · <kbd>Esc</kbd> cancel</span>
            <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={() => dismiss(() => setEditing(false))}>
              Cancel edit
            </button>
            <button className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent" disabled={disabled || !titleDraft.trim()}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      )}
    </div>
  );

  // At the foot of Overview, as GitHub ends its page with the merge box: the
  // decision comes after reading what is being merged.
  const mergeBox = details && isPr && open && (
    <section className="inbox-detail-merge-box" aria-label="Merge">
      {details.isDraft ? (
        <>
          <p className="inbox-detail-merge-note" data-tone="neutral">
            <GitPullRequestDraft size={13} className="inbox-detail-tone-icon" aria-hidden="true" />
            A draft can’t be merged until it’s marked ready for review.
          </p>
          <div className="inbox-detail-actions">
            <button
              className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent"
              disabled={disabled}
              onClick={() => void perform({ kind: 'ready', draft: false }, 'Ready for review.', 'body')}
            >
              Ready for review
            </button>
          </div>
        </>
      ) : (
        <>
          {mergeNote && (
            <p id={`${uid}-merge-note`} className="inbox-detail-merge-note" data-tone={mergeMeta?.tone ?? 'neutral'}>
              {MergeNoteIcon && <MergeNoteIcon size={13} className="inbox-detail-tone-icon" aria-hidden="true" />}
              {mergeNote}
            </p>
          )}
          <div className="inbox-detail-actions">
            <button
              className={`inbox-detail-btn ${gate.button === 'go' ? 'inbox-detail-btn--solid inbox-detail-btn--success' : ''}`}
              disabled={disabled || !details.headOid || gate.button === 'disabled'}
              aria-expanded={confirm === 'merge'}
              aria-describedby={mergeNote ? `${uid}-merge-note` : undefined}
              onClick={(event) => openConfirm('merge', event.currentTarget)}
            >
              <GitMerge size={14} aria-hidden="true" />
              Merge…
            </button>
            {gate.canQueue && (
              <button
                className="inbox-detail-btn"
                disabled={disabled || !details.headOid}
                aria-expanded={confirm === 'auto-merge'}
                onClick={(event) => openConfirm('auto-merge', event.currentTarget)}
              >
                Enable auto-merge…
              </button>
            )}
          </div>
        </>
      )}
      {(confirm === 'merge' || confirm === 'auto-merge') && confirmation(details)}
    </section>
  );

  return (
    <>
      {headSlot && createPortal(head, headSlot)}
      <section className="inbox-detail" aria-label="Remote item details" aria-busy={busy || loading}>
        {!details && loading && (
          <div className="inbox-detail-skeleton" role="status">
            <span className="sr-only">Loading details…</span>
            <i /><i /><i /><i />
          </div>
        )}

        {details && (
          <>
            <div className="inbox-detail-tabs" role="tablist" aria-label="Item details">
              {tabs.map((name, index) => {
                const count = name === 'Conversation' ? details.comments.length : name === 'Files changed' ? details.files.length : undefined;
                return (
                  <button
                    key={name}
                    id={`${uid}-tab-${index}`}
                    type="button"
                    role="tab"
                    className="inbox-detail-tab"
                    aria-selected={tab === name}
                    aria-controls={`${uid}-panel`}
                    tabIndex={tab === name ? 0 : -1}
                    onKeyDown={(event) => onTabKey(event, index)}
                    onClick={() => setTab(name)}
                  >
                    {name === 'Checks' && checksRollup && <CheckIcon outcome={checksRollup} size={13} />}
                    {/* A narrow pane shows "Files"; the accessible name keeps the whole label. */}
                    {name === 'Files changed' ? <>Files<span className="inbox-detail-tab-long"> changed</span></> : name}
                    {count !== undefined && <span className="inbox-detail-tab-count">{count}</span>}
                  </button>
                );
              })}
            </div>

            <div key={tab} id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${tabs.indexOf(tab)}`} className="inbox-detail-content">
              {tab === 'Overview' && (
                <>
                  <OverviewTab workspaceId={workspaceId} details={details} isPr={isPr} onShow={setTab} />
                  {mergeBox}
                  {messages('body')}
                </>
              )}
              {tab === 'Conversation' && (
                <>
                  <ConversationTimeline workspaceId={workspaceId} comments={details.comments} canFix={isPr && open} fixTarget={fixTarget} onFix={fixComment} />
                  {messages('body')}
                  <form
                    className="inbox-detail-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (canSend) send();
                    }}
                  >
                    <div className="inbox-detail-composer-head">
                      <label className="inbox-detail-inline-field">
                        <span>Reply as</span>
                        <select
                          aria-label="Response type"
                          value={composer}
                          disabled={busy}
                          onChange={(event) => setComposer(event.target.value as typeof composer)}
                        >
                          <option value="comment">Comment</option>
                          {isPr && open && <option value="review">Review</option>}
                        </select>
                      </label>
                      {composer === 'review' && (
                        <label className="inbox-detail-inline-field">
                          <span>Decision</span>
                          <select
                            aria-label="Review decision"
                            value={review}
                            disabled={busy}
                            onChange={(event) => setReview(event.target.value as ReviewEvent)}
                          >
                            <option value="comment">Comment only</option>
                            <option value="approve" disabled={ownPr}>Approve</option>
                            <option value="request-changes" disabled={ownPr}>Request changes</option>
                          </select>
                        </label>
                      )}
                    </div>
                    <textarea
                      aria-label="Response message"
                      aria-keyshortcuts={MOD_KEY === '⌘' ? 'Meta+Enter' : 'Control+Enter'}
                      placeholder={composer === 'review' ? 'Summarise your review. Markdown supported.' : 'Leave a comment. Markdown supported.'}
                      value={body}
                      maxLength={65536}
                      disabled={busy}
                      rows={4}
                      onChange={(event) => setBody(event.target.value)}
                      onKeyDown={(event) => {
                        if (!isSubmitChord(event)) return;
                        event.preventDefault();
                        if (canSend) send();
                      }}
                    />
                    <div className="inbox-detail-form-foot">
                      {composer === 'review' && ownPr && (
                        <span className="inbox-detail-hint">You can’t approve or request changes on your own pull request.</span>
                      )}
                      <span className="inbox-detail-kbd-hint" aria-hidden="true"><kbd>{MOD_KEY}</kbd><kbd>↵</kbd> send</span>
                      <button className={`inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--${sendTone}`} disabled={!canSend}>
                        {busy ? 'Sending…' : composer === 'review' ? 'Submit review' : 'Post comment'}
                      </button>
                    </div>
                  </form>
                </>
              )}
              {tab === 'Files changed' && (
                <>
                  {messages('body')}
                  <FilesTab files={details.files} itemUrl={item.url} />
                </>
              )}
              {tab === 'Checks' && (
                <>
                  {messages('body')}
                  <ChecksTab
                    checks={details.checks}
                    canFix={open}
                    fixTarget={fixTarget}
                    onFixChecks={() =>
                      handOff(`Investigate and fix the failing CI checks for ${item.url}. Read the check logs, implement fixes, and run the relevant validation before pushing.`)
                    }
                  />
                </>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
