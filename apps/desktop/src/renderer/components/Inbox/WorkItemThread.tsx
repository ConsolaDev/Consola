import { useMemo, useRef, useState, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ChevronRight, CircleCheck, Ellipsis, ExternalLink, FileCode, Link2, Pencil, Quote, Trash2, Wrench } from 'lucide-react';
import type { WorkItemPost, WorkItemThread, WorkItemThreadComment } from '../../../shared/workItemDetails';
import { MOD_KEY } from './inboxPresentation';
import { parsePatch, threadLocation } from './workItemDetailPresentation';
import { Avatar, Chip, Messages, Reactions, RelativeTime, WorkItemMarkdown, useWorkItemDetail, type MessageAt } from './WorkItemDetailParts';
import { MarkdownEditor } from './WorkItemMarkdownEditor';

/** Lines of a thread's hunk shown before "Show more": the ones leading to the comment. */
const HUNK_TAIL = 4;

/**
 * A post's ⋯ menu: the rare things done to one comment. Each item appears
 * only when it applies, and the menu only when one does.
 */
export function PostMenu({
  post,
  at,
  onQuote,
  onEdit,
  onDelete,
}: {
  post: WorkItemPost;
  at: MessageAt;
  onQuote?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { notify } = useWorkItemDetail();
  // Edit and Quote reply put focus where the writing happens. They run once
  // the menu has closed: while it is open it holds focus, and an editor that
  // mounted then would lose it back to the ⋯ button.
  const afterClose = useRef<(() => void) | null>(null);
  const linkable = !!post.url && !(post as Partial<WorkItemThreadComment>).pending;
  if (!onQuote && !onEdit && !onDelete && !linkable) return null;
  const later = (action: () => void) => () => {
    afterClose.current = action;
  };
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="inbox-detail-icon-btn inbox-detail-post-menu" aria-label={`More actions for ${post.author.login}’s comment`}>
          <Ellipsis size={15} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content"
          sideOffset={4}
          align="end"
          onCloseAutoFocus={(event) => {
            const action = afterClose.current;
            afterClose.current = null;
            if (!action) return;
            event.preventDefault();
            action();
          }}
        >
          {onQuote && (
            <DropdownMenu.Item className="dropdown-item" onSelect={later(onQuote)}>
              <Quote size={14} aria-hidden="true" />
              <span>Quote reply</span>
            </DropdownMenu.Item>
          )}
          {linkable && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={() => {
                void navigator.clipboard.writeText(post.url).then(() => notify('Link copied.', at), () => undefined);
              }}
            >
              <Link2 size={14} aria-hidden="true" />
              <span>Copy link</span>
            </DropdownMenu.Item>
          )}
          {linkable && (
            <DropdownMenu.Item className="dropdown-item" asChild>
              <a href={post.url} target="_blank" rel="noreferrer">
                <ExternalLink size={14} aria-hidden="true" />
                <span>Open on GitHub</span>
              </a>
            </DropdownMenu.Item>
          )}
          {onEdit && (
            <DropdownMenu.Item className="dropdown-item" onSelect={later(onEdit)}>
              <Pencil size={14} aria-hidden="true" />
              <span>Edit</span>
            </DropdownMenu.Item>
          )}
          {onDelete && (
            <>
              <DropdownMenu.Separator className="dropdown-separator" />
              <DropdownMenu.Item className="dropdown-item dropdown-item-destructive" onSelect={onDelete}>
                <Trash2 size={14} aria-hidden="true" />
                <span>Delete</span>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A comment's body rewritten in place. Resolves once saved, so the caller can close it. */
export function BodyEditor({
  initial,
  label,
  saveLabel = 'Update comment',
  onSave,
  onClose,
}: {
  initial: string;
  label: string;
  saveLabel?: string;
  onSave: (body: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { busy } = useWorkItemDetail();
  const [draft, setDraft] = useState(initial);
  const canSave = !busy && draft.trim().length > 0 && draft !== initial;
  const save = async () => {
    if (canSave && (await onSave(draft))) onClose();
  };
  return (
    <div className="inbox-detail-edit">
      <MarkdownEditor value={draft} onChange={setDraft} label={label} autoFocus rows={5} disabled={busy} onSubmit={() => void save()} onCancel={onClose} />
      <div className="inbox-detail-form-foot">
        <span className="inbox-detail-kbd-hint" aria-hidden="true"><kbd>{MOD_KEY}</kbd><kbd>↵</kbd> save · <kbd>Esc</kbd> cancel</span>
        <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent" disabled={!canSave} onClick={() => void save()}>
          {busy ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  );
}

/** A hidden comment stays hidden until asked for, with GitHub's reason. */
export function PostBody({ post, empty }: { post: WorkItemPost; empty?: ReactNode }) {
  const [shown, setShown] = useState(false);
  if (post.minimized && !shown) {
    return (
      <p className="inbox-detail-minimized">
        This comment was marked as {post.minimized}.
        <button type="button" className="inbox-detail-link-btn" onClick={() => setShown(true)}>Show comment</button>
      </p>
    );
  }
  if (!post.body.trim()) return empty ? <>{empty}</> : null;
  return (
    <div className="inbox-detail-post-body">
      <WorkItemMarkdown content={post.body} />
    </div>
  );
}

function HunkPreview({ hunk, path }: { hunk: string; path: string }) {
  const rows = useMemo(() => parsePatch(hunk), [hunk]);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(-HUNK_TAIL);
  const hidden = rows.length - shown.length;
  return (
    <div className="inbox-detail-hunk">
      {hidden > 0 && (
        <button type="button" className="inbox-detail-hunk-more" onClick={() => setAll(true)}>
          <ChevronDown size={13} aria-hidden="true" />
          Show {hidden} more line{hidden === 1 ? '' : 's'}
        </button>
      )}
      {/* Focusable so a keyboard can scroll a wide line. */}
      <div className="inbox-detail-diff-lines" role="group" aria-label={`Code for ${path}`} tabIndex={0}>
        <div className="inbox-detail-diff-rows">
          {shown.map((row, index) => (
            <div key={index} className={`diff-row diff-row--${row.kind}`}>
              <span className="diff-num" aria-hidden="true">{row.oldLine || ''}</span>
              <span className="diff-num" aria-hidden="true">{row.newLine || ''}</span>
              <span className="diff-text">{row.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ThreadComment({ comment, at, fix }: { comment: WorkItemThreadComment; at: MessageAt; fix?: () => void }) {
  const { details, busy, perform, fixTarget } = useWorkItemDetail();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isAuthor = comment.author.login === details.author;
  return (
    <li className="inbox-detail-thread-comment" data-pending={comment.pending || undefined}>
      <header className="inbox-detail-post-head">
        <Avatar person={comment.author} />
        <strong className="inbox-detail-post-author">{comment.author.login}</strong>
        {comment.author.isBot && <Chip>Bot</Chip>}
        {isAuthor && <Chip>Author</Chip>}
        <RelativeTime iso={comment.createdAt} />
        {comment.editedAt && <span className="inbox-detail-edited">· edited</span>}
        {comment.pending && <Chip tone="warning">Pending</Chip>}
        <PostMenu
          post={comment}
          at={at}
          onEdit={comment.viewerCanEdit ? () => setEditing(true) : undefined}
          onDelete={comment.pending && comment.viewerCanDelete ? () => setDeleting(true) : undefined}
        />
      </header>
      {editing ? (
        <BodyEditor
          initial={comment.body}
          label="Edit comment"
          onSave={(body) => perform({ kind: 'edit-comment', target: 'review-comment', id: comment.id, body }, 'Comment updated.', at)}
          onClose={() => setEditing(false)}
        />
      ) : (
        <PostBody post={comment} />
      )}
      <Reactions reactions={comment.reactions} />
      {deleting && (
        <div className="inbox-detail-confirm" data-tone="error" role="group" aria-label="Confirm delete">
          <p className="inbox-detail-confirm-title">Delete this pending comment?</p>
          <div className="inbox-detail-form-foot">
            <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={() => setDeleting(false)}>Cancel</button>
            <button
              type="button"
              autoFocus
              className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--danger-solid"
              disabled={busy}
              onClick={() => void perform({ kind: 'delete-comment', id: comment.id }, 'Pending comment deleted.', at).then((ok) => ok && setDeleting(false))}
            >
              Delete comment
            </button>
          </div>
        </div>
      )}
      {fix && (
        <button type="button" className="inbox-detail-btn inbox-detail-btn--small inbox-detail-btn--tinted inbox-detail-fix" data-tone="accent" onClick={fix}>
          <Wrench size={13} aria-hidden="true" />
          Fix in {fixTarget}
        </button>
      )}
    </li>
  );
}

function ThreadReply({ thread, at }: { thread: WorkItemThread; at: MessageAt }) {
  const { details, busy, perform } = useWorkItemDetail();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const pending = details.pendingReview;
  const send = async () => {
    if (busy || !body.trim()) return;
    const ok = await perform(
      { kind: 'reply', threadId: thread.id, body, ...(pending ? { pendingReviewId: pending.id } : {}) },
      pending ? 'Added to your pending review.' : 'Reply posted.',
      at
    );
    if (ok) {
      setBody('');
      setOpen(false);
    }
  };
  if (!open) {
    return (
      <button type="button" className="inbox-detail-reply-trigger" onClick={() => setOpen(true)}>
        <Avatar person={details.viewer} size={16} />
        Reply…
      </button>
    );
  }
  return (
    <div className="inbox-detail-reply">
      <MarkdownEditor
        value={body}
        onChange={setBody}
        label="Reply"
        placeholder="Reply…"
        toolbar="compact"
        rows={3}
        autoFocus
        disabled={busy}
        onSubmit={() => void send()}
        onCancel={() => setOpen(false)}
      />
      <div className="inbox-detail-form-foot">
        <span className="inbox-detail-kbd-hint" aria-hidden="true"><kbd>{MOD_KEY}</kbd><kbd>↵</kbd> send</span>
        <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent" disabled={busy || !body.trim()} onClick={() => void send()}>
          {busy ? 'Sending…' : pending ? 'Add review comment' : 'Reply'}
        </button>
      </div>
      {/* Spoken where it matters: until the review is submitted, nobody else sees this. */}
      {pending && <p className="inbox-detail-hint">This joins your pending review. Others see it once you submit the review.</p>}
    </div>
  );
}

/**
 * One conversation on lines of the diff: where it is (and, in the stream,
 * the code it was written on), its comments, a reply, and resolving it. A
 * resolved thread starts folded to one line, as on GitHub.
 */
export function ReviewThread({ thread, placement }: { thread: WorkItemThread; placement: 'stream' | 'diff' }) {
  const { item, isPr, open: itemOpen, busy, perform, handOff } = useWorkItemDetail();
  const [expanded, setExpanded] = useState(!thread.isResolved);
  const at = `thread:${thread.id}`;
  const first = thread.comments[0];
  const location = threadLocation(thread);
  if (!first) return null;

  if (!expanded) {
    return (
      <div className="inbox-detail-thread" data-resolved="">
        <button type="button" className="inbox-detail-thread-folded" aria-expanded={false} onClick={() => setExpanded(true)}>
          <ChevronRight size={13} aria-hidden="true" />
          <span>
            <strong>{first.author.login}</strong>’s thread on <code>{location}</code> — resolved
          </span>
        </button>
      </div>
    );
  }

  const line = thread.line ?? thread.originalLine;
  const fix = isPr && itemOpen
    ? () => handOff(
      `Address this review feedback on ${item.url}:\n${first.url}\n\n${thread.path}${line ? `:${line}` : ''}\n${first.body}\n\nInspect the current code, implement the fix, and validate it.`,
      at
    )
    : undefined;
  const resolvable = thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve;
  return (
    <section className="inbox-detail-thread" data-resolved={thread.isResolved ? '' : undefined} data-placement={placement} aria-label={`Thread on ${location}`}>
      {(placement === 'stream' || thread.isResolved) && (
        <header className="inbox-detail-thread-head">
          {placement === 'stream' && (
            <>
              <FileCode size={13} aria-hidden="true" />
              <code className="inbox-detail-thread-path" title={thread.path}>
                {thread.path}
                {line ? `:${line}` : ''}
              </code>
              {thread.isOutdated && <Chip tone="warning">Outdated</Chip>}
            </>
          )}
          {thread.isResolved && (
            <button type="button" className="inbox-detail-link-btn inbox-detail-thread-fold" aria-expanded onClick={() => setExpanded(false)}>
              <CircleCheck size={13} aria-hidden="true" />
              Resolved · hide
            </button>
          )}
        </header>
      )}
      {placement === 'stream' && thread.diffHunk && <HunkPreview hunk={thread.diffHunk} path={thread.path} />}
      <ol className="inbox-detail-thread-comments">
        {thread.comments.map((comment, index) => (
          <ThreadComment key={comment.id} comment={comment} at={at} fix={index === 0 ? fix : undefined} />
        ))}
      </ol>
      <div className="inbox-detail-thread-foot">
        {thread.viewerCanReply && <ThreadReply thread={thread} at={at} />}
        {resolvable && (
          <button
            type="button"
            className="inbox-detail-btn inbox-detail-btn--small"
            disabled={busy}
            onClick={() => void perform(
              { kind: 'resolve-thread', threadId: thread.id, resolved: !thread.isResolved },
              thread.isResolved ? 'Conversation unresolved.' : 'Conversation resolved.',
              at
            )}
          >
            {thread.isResolved ? 'Unresolve conversation' : 'Resolve conversation'}
          </button>
        )}
      </div>
      <Messages at={at} />
    </section>
  );
}
