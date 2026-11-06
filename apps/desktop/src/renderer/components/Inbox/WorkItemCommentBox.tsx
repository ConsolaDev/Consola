import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, CircleCheck, CircleSlash, GitPullRequestClosed, RotateCcw } from 'lucide-react';
import { MOD_KEY } from './inboxPresentation';
import { closeLabel, reopenLabel } from './workItemDetailPresentation';
import { Avatar, Messages, useWorkItemDetail } from './WorkItemDetailParts';
import { MarkdownEditor, type MarkdownEditorHandle } from './WorkItemMarkdownEditor';

type CloseReason = 'completed' | 'not-planned';

/**
 * The last thing in the stream, as on GitHub: say something, or close (or
 * reopen) the item with what was typed as its closing comment. Comment
 * carries no verdict: reviewing is Files changed's.
 */
export function CommentBox({ ref }: { ref?: Ref<MarkdownEditorHandle> }) {
  const { details, isPr, ref: itemRef, busy, perform } = useWorkItemDetail();
  const [body, setBody] = useState('');
  const [closing, setClosing] = useState<CloseReason | 'pull-request' | null>(null);
  const editor = useRef<MarkdownEditorHandle>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const closeTrigger = useRef<HTMLButtonElement>(null);
  const heading = useId();
  useImperativeHandle(ref, () => ({
    focus: () => editor.current?.focus(),
    insert: (text) => editor.current?.insert(text),
  }));

  useEffect(() => {
    if (closing) confirmButton.current?.focus();
  }, [closing]);

  const hasText = body.trim().length > 0;
  const noun = isPr ? 'Pull request' : 'Issue';
  const merged = details.state === 'merged';
  const closed = details.state === 'closed';
  const withComment = hasText ? { comment: body } : {};

  const comment = async () => {
    if (!hasText || busy) return;
    if (await perform({ kind: 'comment', body }, 'Comment posted.', 'composer')) setBody('');
  };
  const close = async () => {
    if (!closing || busy) return;
    const reason = closing === 'pull-request' ? undefined : closing;
    if (await perform({ kind: 'close', ...(reason ? { reason } : {}), ...withComment }, `${noun} closed.`, 'composer')) {
      setBody('');
      setClosing(null);
    }
  };
  const reopen = async () => {
    if (!busy && (await perform({ kind: 'reopen', ...withComment }, `${noun} reopened.`, 'composer'))) setBody('');
  };
  const dismiss = () => {
    setClosing(null);
    requestAnimationFrame(() => closeTrigger.current?.focus());
  };

  return (
    <section className="inbox-detail-composer" aria-labelledby={heading}>
      <h3 id={heading} className="inbox-detail-composer-title">
        <Avatar person={details.viewer} />
        Add a comment
      </h3>
      <MarkdownEditor
        ref={editor}
        value={body}
        onChange={setBody}
        label="Comment"
        placeholder="Leave a comment"
        rows={4}
        disabled={busy}
        onSubmit={() => void comment()}
      />
      <div className="inbox-detail-composer-foot">
        <span className="inbox-detail-hint" aria-hidden="true">
          Markdown is supported · <kbd>{MOD_KEY}</kbd><kbd>↵</kbd> to comment
        </span>
        <div className="inbox-detail-composer-actions">
          {!merged && (closed ? (
            <button type="button" className="inbox-detail-btn" disabled={busy} onClick={() => void reopen()}>
              <RotateCcw size={14} className="inbox-detail-tone-icon" data-tone="success" aria-hidden="true" />
              {reopenLabel(itemRef.type, hasText)}
            </button>
          ) : isPr ? (
            <button
              ref={closeTrigger}
              type="button"
              className="inbox-detail-btn"
              disabled={busy}
              aria-expanded={closing !== null}
              onClick={() => setClosing('pull-request')}
            >
              <GitPullRequestClosed size={14} className="inbox-detail-tone-icon" data-tone="error" aria-hidden="true" />
              {closeLabel('pr', hasText)}
            </button>
          ) : (
            <div className="inbox-detail-split">
              <button
                ref={closeTrigger}
                type="button"
                className="inbox-detail-btn"
                disabled={busy}
                aria-expanded={closing !== null}
                onClick={() => setClosing('completed')}
              >
                <CircleCheck size={14} className="inbox-detail-tone-icon" data-tone="merged" aria-hidden="true" />
                {closeLabel('issue', hasText)}
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild disabled={busy}>
                  <button type="button" className="inbox-detail-btn inbox-detail-split-caret" aria-label="Close as…">
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
                    <DropdownMenu.Item className="dropdown-item" onSelect={() => setClosing('completed')}>
                      <CircleCheck size={14} aria-hidden="true" />
                      <span>Close as completed</span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className="dropdown-item" onSelect={() => setClosing('not-planned')}>
                      <CircleSlash size={14} aria-hidden="true" />
                      <span>Close as not planned</span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          ))}
          <button
            type="button"
            className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent"
            disabled={busy || !hasText}
            onClick={() => void comment()}
          >
            {busy ? 'Sending…' : 'Comment'}
          </button>
        </div>
      </div>
      {closing && (
        <div
          className="inbox-detail-confirm"
          data-tone="error"
          role="group"
          aria-label="Confirm close"
          onKeyDown={(event) => {
            // Handled here, so the Inbox's own Esc does not close the whole pane.
            if (event.key === 'Escape' && !busy) {
              event.preventDefault();
              dismiss();
            }
          }}
        >
          <p className="inbox-detail-confirm-title">
            {isPr ? <GitPullRequestClosed size={15} aria-hidden="true" /> : <CircleCheck size={15} aria-hidden="true" />}
            {isPr
              ? `Close pull request #${itemRef.number}?`
              : `Close issue #${itemRef.number} as ${closing === 'not-planned' ? 'not planned' : 'completed'}?`}
          </p>
          <p className="inbox-detail-hint">
            {hasText ? 'Your comment is posted as it closes. ' : ''}It can be reopened later.
          </p>
          <div className="inbox-detail-form-foot">
            <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={dismiss}>Cancel</button>
            <button
              ref={confirmButton}
              type="button"
              className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--danger-solid"
              disabled={busy}
              onClick={() => void close()}
            >
              {busy ? 'Working…' : 'Confirm close'}
            </button>
          </div>
        </div>
      )}
      <Messages at="composer" />
    </section>
  );
}
