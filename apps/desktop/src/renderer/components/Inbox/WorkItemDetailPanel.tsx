import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { InboxItem } from '../../../shared/workItems';
import type { WorkItemDetails, WorkItemMutation } from '../../../shared/workItemDetails';
import { inboxBridge } from '../../services/inboxBridge';
import { MarkdownRenderer } from '../Markdown';

type Tab = 'Overview' | 'Conversation' | 'Files changed' | 'Checks';
interface Props {
  workspaceId: string;
  accountLogin: string;
  item: InboxItem;
  onFix: (prompt: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkItemDetailPanel({ workspaceId, accountLogin, item, onFix }: Props) {
  const [details, setDetails] = useState<WorkItemDetails | null>(null);
  const [tab, setTab] = useState<Tab>('Overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [body, setBody] = useState('');
  const [review, setReview] = useState<'comment' | 'approve' | 'request-changes'>('comment');
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
  const ref = item.workItem;
  const isPr = ref.type === 'pr';

  async function refresh() {
    const version = ++request.current;
    setLoading(true);
    setError('');
    try {
      const next = await inboxBridge.getDetails(workspaceId, ref);
      if (alive.current && version === request.current) setDetails(next);
    } catch (error) {
      if (alive.current && version === request.current) setError(`Could not refresh details: ${errorText(error)}`);
    } finally {
      if (alive.current && version === request.current) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; request.current++; };
  }, [workspaceId, accountLogin, ref.repo, ref.type, ref.number]);

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
      if (mutation.kind === 'edit') setEditing(false);
      await refresh();
    } catch (error) {
      if (alive.current) setError(errorText(error));
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const open = details?.state === 'open';
  const ownPr = details?.author.toLowerCase() === accountLogin.toLowerCase();
  const disabled = busy || loading;
  const tabs: Tab[] = isPr ? ['Overview', 'Conversation', 'Files changed', 'Checks'] : ['Overview', 'Conversation'];
  return (
    <section className="inbox-detail" aria-label="Remote item details" aria-busy={busy || loading}>
      <div className="inbox-detail-toolbar">
        <span className={`inbox-detail-state inbox-detail-state--${details?.state ?? item.state}`}>
          {details?.isDraft ? 'Draft' : details?.state ?? item.state}
        </span>
        <span className="inbox-detail-account">as {accountLogin}</span>
        <button className="inbox-pane-open" aria-label="Refresh details" disabled={disabled} onClick={() => void refresh()}><RefreshCw size={12} /></button>
      </div>
      {error && <p className="inbox-pane-action-error" role="alert">{error}</p>}
      {notice && <p className="inbox-detail-notice" role="status">{notice}</p>}
      {loading && <p className="inbox-pane-hint" role="status">Loading details…</p>}
      {details && <>
        <div className="inbox-detail-actions">
          <button className="inbox-pane-open" disabled={disabled} onClick={() => {
            setEditing(!editing); setTitleDraft(details.title); setDescriptionDraft(details.body);
          }}>Edit</button>
          {details.state !== 'merged' && <button className="inbox-pane-open" disabled={disabled} onClick={() => {
            if (open) setConfirm('close'); else void perform({ kind: 'reopen' }, 'Item reopened.');
          }}>{open ? 'Close' : 'Reopen'}</button>}
          {isPr && open && <>
            <button className="inbox-pane-open" disabled={disabled} onClick={() => void perform({ kind: 'ready', draft: !details.isDraft }, details.isDraft ? 'Ready for review.' : 'Converted to draft.')}>
              {details.isDraft ? 'Ready for review' : 'Convert to draft'}
            </button>
            <button className="inbox-pane-open" disabled={disabled} onClick={() => { setTab('Conversation'); setComposer('review'); }}>Review</button>
            <button className="inbox-pane-open" disabled={disabled || details.isDraft || !details.headOid} onClick={() => setConfirm('merge')}>Merge…</button>
          </>}
        </div>
        {confirm && <div className="inbox-detail-confirm" role="group" aria-label={`Confirm ${confirm}`}>
          <p>{confirm === 'close' ? `Close ${isPr ? 'pull request' : 'issue'} #${ref.number}?` : `Merge pull request #${ref.number} into ${details.baseBranch}?`}</p>
          {confirm === 'merge' && <>
            <select aria-label="Merge method" value={method} disabled={busy} onChange={(event) => setMethod(event.target.value as typeof method)}>
              <option value="squash">Squash and merge</option><option value="merge">Create a merge commit</option><option value="rebase">Rebase and merge</option>
            </select>
            <label><input type="checkbox" checked={auto} disabled={busy} onChange={(event) => setAuto(event.target.checked)} /> Merge automatically when requirements pass</label>
            <p className="inbox-pane-hint">GitHub enforces repository rules and supported merge methods.</p>
          </>}
          <div className="inbox-detail-actions">
            <button className="inbox-pane-action" disabled={disabled} onClick={() => void perform(confirm === 'close' ? { kind: 'close' } : { kind: 'merge', method, auto, headOid: details.headOid! }, confirm === 'close' ? 'Item closed.' : auto ? 'Auto-merge requested.' : 'Merge requested successfully.')}>
              {busy ? 'Working…' : confirm === 'close' ? 'Confirm close' : auto ? 'Enable auto-merge' : 'Confirm merge'}
            </button>
            <button className="inbox-pane-open" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>}
        {editing && <form className="inbox-detail-editor" onSubmit={(event) => { event.preventDefault(); void perform({ kind: 'edit', title: titleDraft, body: descriptionDraft }, 'Item updated.'); }}>
          <label>Title<input value={titleDraft} maxLength={256} disabled={busy} onChange={(event) => setTitleDraft(event.target.value)} /></label>
          <label>Description<textarea value={descriptionDraft} maxLength={65536} disabled={busy} onChange={(event) => setDescriptionDraft(event.target.value)} rows={8} /></label>
          <div className="inbox-detail-actions"><button className="inbox-pane-action" disabled={disabled || !titleDraft.trim()}>Save changes</button><button type="button" className="inbox-pane-open" disabled={busy} onClick={() => setEditing(false)}>Cancel edit</button></div>
        </form>}
        <div className="inbox-detail-tabs" role="tablist" aria-label="Item details">
          {tabs.map((name) => <button key={name} type="button" role="tab" aria-selected={tab === name} aria-controls="inbox-detail-content" tabIndex={tab === name ? 0 : -1} onKeyDown={(event) => {
            const index = tabs.indexOf(name);
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault(); setTab(tabs[next]);
            (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
          }} onClick={() => setTab(name)}>{name}{name === 'Conversation' ? ` (${details.comments.length})` : name === 'Files changed' ? ` (${details.files.length})` : ''}</button>)}
        </div>
        <div id="inbox-detail-content" role="tabpanel" aria-label={tab} className="inbox-detail-content">
          {tab === 'Overview' && <>
            {isPr && <div className="inbox-detail-summary">
              <div className="inbox-pane-kv"><span>Review</span><span>{({ APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Awaiting approval' } as Record<string, string>)[details.reviewDecision ?? ''] ?? 'No review'}</span></div>
              <div className="inbox-pane-kv"><span>Checks</span><span>{details.checks.filter((check) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.state)).length}/{details.checks.length} passing</span></div>
              <div className="inbox-pane-kv"><span>Diff</span><span>+{details.files.reduce((total, file) => total + file.additions, 0)} −{details.files.reduce((total, file) => total + file.deletions, 0)}</span></div>
            </div>}
            {details.headBranch && <p className="inbox-pane-hint">{details.headBranch} → {details.baseBranch}</p>}
            {isPr && details.mergeState && <p className="inbox-pane-hint">Merge status: {details.mergeState.replace(/_/g, ' ').toLowerCase()}</p>}
            {details.labels.length > 0 && <div className="inbox-detail-labels">{details.labels.map((label) => <span key={label}>{label}</span>)}</div>}
            {details.assignees.length > 0 && <p className="inbox-pane-hint">Assigned to {details.assignees.join(', ')}</p>}
            {details.body ? <MarkdownRenderer content={details.body} enableCommandHighlighting={false} /> : <p className="inbox-pane-empty">No description provided.</p>}
          </>}
          {tab === 'Conversation' && <>
            {details.comments.length === 0 && <p className="inbox-pane-empty">No conversation yet.</p>}
            {details.comments.map((comment) => <article className="inbox-detail-comment" key={comment.id}>
              <div className="inbox-detail-comment-meta"><strong>{comment.author}</strong><span>{comment.state?.replace(/_/g, ' ').toLowerCase() ?? comment.kind}</span></div>
              {comment.createdAt && <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>}
              {comment.path && <p className="inbox-pane-hint">{comment.path}{comment.line ? `:${comment.line}` : ''}</p>}
              <MarkdownRenderer content={comment.body} enableCommandHighlighting={false} />
              <div className="inbox-detail-actions">
                {comment.url && <a className="inbox-pane-link" href={comment.url} target="_blank" rel="noreferrer">View on GitHub</a>}
                {isPr && open && (comment.kind === 'inline' || comment.state === 'CHANGES_REQUESTED') && <button className="inbox-pane-open" onClick={() => onFix(`Address this review feedback on ${item.url}:\n${comment.url}\n\n${comment.body}\n\nInspect the current code, implement the fix, and validate it.`)}>Fix in a session</button>}
              </div>
            </article>)}
            <form className="inbox-detail-editor" onSubmit={(event) => {
              event.preventDefault();
              void perform(composer === 'review' ? { kind: 'review', event: review, body } : { kind: 'comment', body }, composer === 'review' ? 'Review submitted.' : 'Comment posted.');
            }}>
              <label>Response type<select aria-label="Response type" value={composer} disabled={busy} onChange={(event) => setComposer(event.target.value as typeof composer)}><option value="comment">Comment</option>{isPr && open && <option value="review">Review</option>}</select></label>
              {composer === 'review' && <label>Review decision<select aria-label="Review decision" value={review} disabled={busy} onChange={(event) => setReview(event.target.value as typeof review)}><option value="comment">Comment only</option><option value="approve" disabled={ownPr}>Approve</option><option value="request-changes" disabled={ownPr}>Request changes</option></select></label>}
              <label>{composer === 'review' ? 'Review message' : 'Comment'}<textarea aria-label="Response message" placeholder="Write Markdown…" value={body} maxLength={65536} disabled={busy} rows={4} onChange={(event) => setBody(event.target.value)} /></label>
              <button className="inbox-pane-action" disabled={disabled || (composer === 'review' && (!open || (ownPr && review !== 'comment'))) || (!body.trim() && !(composer === 'review' && review === 'approve'))}>{busy ? 'Sending…' : composer === 'review' ? 'Submit review' : 'Post comment'}</button>
            </form>
          </>}
          {tab === 'Files changed' && <>
            {details.files.length === 0 && <p className="inbox-pane-empty">No changed files.</p>}
            {details.files.map((file) => <details className="inbox-detail-file" key={file.path}>
              <summary>{file.path}<span>+{file.additions} −{file.deletions} · {file.status}</span></summary>
              {file.patch ? <pre aria-label={`Diff for ${file.path}`}>{file.patch.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : ''}>{line}{'\n'}</span>)}</pre> : <p className="inbox-pane-hint">GitHub did not provide a text diff for this file.</p>}
            </details>)}
            <a className="inbox-pane-link" href={`${item.url}/files`} target="_blank" rel="noreferrer">View full diff on GitHub</a>
          </>}
          {tab === 'Checks' && <>
            {details.checks.length === 0 && <p className="inbox-pane-empty">No checks reported.</p>}
            {details.checks.map((check, index) => <div className="inbox-detail-check" key={`${check.name}:${index}`}><span>{check.url ? <a className="inbox-pane-link" href={check.url} target="_blank" rel="noreferrer">{check.name}</a> : check.name}</span><span>{check.state.replace(/_/g, ' ').toLowerCase()}</span></div>)}
            {open && details.checks.some((check) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(check.state)) && <button className="inbox-pane-action" onClick={() => onFix(`Investigate and fix the failing CI checks for ${item.url}. Read the check logs, implement fixes, and run the relevant validation before pushing.`)}>Fix failing checks in a session</button>}
          </>}
        </div>
      </>}
    </section>
  );
}
