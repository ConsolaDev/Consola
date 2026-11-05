import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  CircleAlert,
  CircleCheck,
  Eye,
  GitMerge,
  GitPullRequestClosed,
  Pencil,
  RefreshCw,
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
  StateBadge,
  rollupOutcome,
  type DetailTab,
  type FixTarget,
} from './WorkItemDetailTabs';
import { itemStatus, mergeStateMeta, summarizeChecks } from './workItemDetailPresentation';
import { MOD_KEY, isSubmitChord, prefersReducedMotion } from './inboxPresentation';

interface Props {
  workspaceId: string;
  accountLogin: string;
  item: InboxItem;
  /** Hand a fix prompt to a session. A returned string is why it could not, shown as an error. */
  onFix: (prompt: string) => string | void;
  fixTarget?: FixTarget;
  /** Every fresh read, so the pane's header can follow an edited title. */
  onDetails?: (details: WorkItemDetails) => void;
}

type ReviewEvent = 'comment' | 'approve' | 'request-changes';

/** A confirmation is read, then gone; an error stays until dismissed or retried. */
const NOTICE_MS = 5000;

export function WorkItemDetailPanel({ workspaceId, accountLogin, item, onFix, fixTarget = 'a session', onDetails }: Props) {
  const [details, setDetails] = useState<WorkItemDetails | null>(null);
  const [tab, setTab] = useState<DetailTab>('Overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [body, setBody] = useState('');
  const [review, setReview] = useState<ReviewEvent>('comment');
  const [composer, setComposer] = useState<'comment' | 'review'>('comment');
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [confirm, setConfirm] = useState<'close' | 'merge' | null>(null);
  const [method, setMethod] = useState<'squash' | 'merge' | 'rebase'>('squash');
  const [auto, setAuto] = useState(false);
  const alive = useRef(true);
  const writing = useRef(false);
  const request = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const confirmFocusRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const uid = useId();
  const ref = item.workItem;
  const isPr = ref.type === 'pr';
  const noun = isPr ? 'Pull request' : 'Issue';

  async function refresh() {
    const version = ++request.current;
    setLoading(true);
    setError('');
    try {
      const next = await inboxBridge.getDetails(workspaceId, ref);
      if (alive.current && version === request.current) {
        setDetails(next);
        onDetails?.(next);
      }
    } catch (error) {
      if (alive.current && version === request.current) setError(`Could not refresh details: ${ipcErrorMessage(error)}`);
    } finally {
      if (alive.current && version === request.current) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; request.current++; };
  }, [workspaceId, accountLogin, ref.repo, ref.type, ref.number]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Opening a confirmation moves focus into it, so Enter and Escape act on it.
  useEffect(() => {
    if (confirm) confirmFocusRef.current?.focus();
  }, [confirm]);

  async function perform(mutation: WorkItemMutation, success: string) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError('');
    setNotice('');
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

  function openConfirm(kind: 'close' | 'merge', trigger: HTMLElement) {
    returnFocusRef.current = trigger;
    setConfirm(kind);
  }

  function dismiss(setClosed: () => void) {
    setClosed();
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  }

  function startReview() {
    setTab('Conversation');
    setComposer('review');
    requestAnimationFrame(() => {
      const field = composerRef.current;
      if (!field) return;
      field.focus({ preventScroll: true });
      field.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    });
  }

  // An item the Inbox no longer lists is stood in for with no state (''):
  // no badge until details say, rather than a guess that would flip.
  const knownState = details?.state ?? item.state;
  const status = knownState ? itemStatus(ref.type, knownState, details?.isDraft ?? item.isDraft) : null;
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
      composer === 'review' ? 'Review submitted.' : 'Comment posted.'
    );
  }

  function confirmAction(current: WorkItemDetails) {
    if (confirm === 'close') void perform({ kind: 'close' }, `${noun} closed.`);
    else void perform({ kind: 'merge', method, auto, headOid: current.headOid! }, auto ? 'Auto-merge requested.' : 'Merge requested.');
  }

  function handOff(prompt: string) {
    const refusal = onFix(prompt);
    if (refusal) {
      setNotice('');
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

  return (
    <section className="inbox-detail" aria-label="Remote item details" aria-busy={busy || loading}>
      <div className="inbox-detail-toolbar">
        <div className="inbox-detail-toolbar-lead">
          {status && <StateBadge key={status.kind} {...status} />}
          {details?.headBranch && <BranchPair head={details.headBranch} base={details.baseBranch} />}
        </div>
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
      </div>

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

      {!details && loading && (
        <div className="inbox-detail-skeleton" role="status">
          <span className="sr-only">Loading details…</span>
          <i /><i /><i /><i />
        </div>
      )}

      {details && (
        <>
          <div className="inbox-detail-actions">
            {isPr && open && (
              <div className="inbox-detail-actions-main">
                {details.isDraft ? (
                  <button
                    className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent"
                    disabled={disabled}
                    onClick={() => void perform({ kind: 'ready', draft: false }, 'Ready for review.')}
                  >
                    Ready for review
                  </button>
                ) : (
                  <button
                    className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--success"
                    disabled={disabled || !details.headOid}
                    aria-expanded={confirm === 'merge'}
                    onClick={(event) => openConfirm('merge', event.currentTarget)}
                  >
                    <GitMerge size={14} aria-hidden="true" />
                    Merge…
                  </button>
                )}
                <button className="inbox-detail-btn" disabled={disabled} onClick={startReview}>
                  <Eye size={14} aria-hidden="true" />
                  Review
                </button>
              </div>
            )}
            <div className="inbox-detail-actions-quiet">
              <button
                className="inbox-detail-btn inbox-detail-btn--quiet"
                disabled={disabled}
                aria-expanded={editing}
                onClick={() => {
                  setEditing(!editing);
                  setTitleDraft(details.title);
                  setDescriptionDraft(details.body);
                }}
              >
                <Pencil size={13} aria-hidden="true" />
                Edit
              </button>
              {isPr && open && !details.isDraft && (
                <button
                  className="inbox-detail-btn inbox-detail-btn--quiet"
                  disabled={disabled}
                  onClick={() => void perform({ kind: 'ready', draft: true }, 'Converted to draft.')}
                >
                  Convert to draft
                </button>
              )}
              {details.state !== 'merged' && (
                <button
                  className={`inbox-detail-btn inbox-detail-btn--quiet ${open ? 'inbox-detail-btn--danger' : ''}`}
                  disabled={disabled}
                  aria-expanded={open ? confirm === 'close' : undefined}
                  onClick={(event) => {
                    if (open) openConfirm('close', event.currentTarget);
                    else void perform({ kind: 'reopen' }, `${noun} reopened.`);
                  }}
                >
                  {open ? 'Close' : 'Reopen'}
                </button>
              )}
            </div>
          </div>

          {confirm && (
            <div
              className="inbox-detail-confirm"
              data-tone={confirm === 'merge' ? 'success' : 'error'}
              role="group"
              aria-label={`Confirm ${confirm}`}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !busy) dismiss(() => setConfirm(null));
              }}
            >
              <p className="inbox-detail-confirm-title">
                {confirm === 'merge' ? <GitMerge size={15} aria-hidden="true" /> : <GitPullRequestClosed size={15} aria-hidden="true" />}
                {confirm === 'close'
                  ? `Close ${isPr ? 'pull request' : 'issue'} #${ref.number}?`
                  : `Merge pull request #${ref.number} into ${details.baseBranch}?`}
              </p>
              {confirm === 'merge' ? (
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
                  <label className="inbox-detail-checkbox">
                    <input type="checkbox" checked={auto} disabled={busy} onChange={(event) => setAuto(event.target.checked)} />
                    Merge automatically when requirements pass
                  </label>
                  <p className="inbox-detail-hint">GitHub enforces repository rules and supported merge methods.</p>
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
                  className={`inbox-detail-btn inbox-detail-btn--solid ${confirm === 'merge' ? 'inbox-detail-btn--success' : 'inbox-detail-btn--danger-solid'}`}
                  disabled={disabled}
                  onClick={() => confirmAction(details)}
                >
                  {busy ? 'Working…' : confirm === 'close' ? 'Confirm close' : auto ? 'Enable auto-merge' : 'Confirm merge'}
                </button>
              </div>
            </div>
          )}

          {editing && (
            <form
              className="inbox-detail-editor"
              onSubmit={(event) => {
                event.preventDefault();
                if (!disabled && titleDraft.trim()) void perform({ kind: 'edit', title: titleDraft, body: descriptionDraft }, 'Changes saved.');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !busy) { event.preventDefault(); setEditing(false); }
                if (isSubmitChord(event)) { event.preventDefault(); event.currentTarget.requestSubmit(); }
              }}
            >
              <label className="inbox-detail-field">
                <span>Title</span>
                <input
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
                <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={() => setEditing(false)}>
                  Cancel edit
                </button>
                <button className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent" disabled={disabled || !titleDraft.trim()}>
                  {busy ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          )}

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
            {tab === 'Overview' && <OverviewTab workspaceId={workspaceId} details={details} isPr={isPr} onShow={setTab} />}
            {tab === 'Conversation' && (
              <>
                <ConversationTimeline workspaceId={workspaceId} comments={details.comments} canFix={isPr && open} fixTarget={fixTarget} onFix={fixComment} />
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
                    ref={composerRef}
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
            {tab === 'Files changed' && <FilesTab files={details.files} itemUrl={item.url} />}
            {tab === 'Checks' && (
              <ChecksTab
                checks={details.checks}
                canFix={open}
                fixTarget={fixTarget}
                onFixChecks={() =>
                  handOff(`Investigate and fix the failing CI checks for ${item.url}. Read the check logs, implement fixes, and run the relevant validation before pushing.`)
                }
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
