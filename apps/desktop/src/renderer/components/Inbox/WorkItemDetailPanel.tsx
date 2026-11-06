import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { CircleAlert, CircleCheck, Ellipsis, GitPullRequestDraft, RefreshCw, X } from 'lucide-react';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import type { WorkItemDetails, WorkItemMutation } from '../../../shared/workItemDetails';
import { inboxBridge } from '../../services/inboxBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { conversationCount, quoteReply } from './workItemDetailPresentation';
import {
  BranchPair,
  DiffCounts,
  WorkItemDetailContext,
  type FixTarget,
  type MessageAt,
  type WorkItemDetailContextValue,
} from './WorkItemDetailParts';
import { ConversationStream } from './WorkItemConversation';
import { FilesChanged } from './WorkItemFiles';
import type { MarkdownEditorHandle } from './WorkItemMarkdownEditor';

interface Props {
  workspaceId: string;
  accountLogin: string;
  item: InboxItem;
  /**
   * Where the item's status strip goes: branches, refresh and the ⋯
   * menu. The pane puts it above its sessions dock, apart from the tabs. Null
   * until the pane has mounted it.
   */
  headSlot: HTMLElement | null;
  /** Hand a fix prompt to a session. A returned string is why it could not, shown as an error. */
  onFix: (prompt: string) => string | void;
  fixTarget?: FixTarget;
  /** Every fresh read, so the pane's header can follow an edited title. */
  onDetails?: (details: WorkItemDetails) => void;
  /** Opens another item in the Inbox's pane; false when the Inbox does not list it. */
  onOpenWorkItem?: (ref: WorkItemRef) => boolean;
}

type Tab = 'Conversation' | 'Files changed';
const TABS: Tab[] = ['Conversation', 'Files changed'];

/** A confirmation is read, then gone; an error stays until dismissed or retried. */
const NOTICE_MS = 5000;
/** GitHub works mergeability out lazily; UNKNOWN means "ask again shortly". */
const MERGE_STATE_POLL_MS = 3000;
const MERGE_STATE_POLLS = 5;

/**
 * A pull request or issue as on github.com, in Consola's own look: one
 * Conversation stream (description, the whole timeline, the merge card, a
 * comment box) and, for a pull request, Files changed, where a review is
 * written. Every write goes through `perform`, one at a time, says its
 * outcome beside what asked for it, and reads the item again after.
 */
export function WorkItemDetailPanel({ workspaceId, accountLogin, item, headSlot, onFix, fixTarget = 'a session', onDetails, onOpenWorkItem }: Props) {
  const [details, setDetails] = useState<WorkItemDetails | null>(null);
  const [tab, setTab] = useState<Tab>('Conversation');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [messageAt, setMessageAt] = useState<MessageAt>('head');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const alive = useRef(true);
  const writing = useRef(false);
  const request = useRef(0);
  const composer = useRef<MarkdownEditorHandle>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const ref = item.workItem;
  const isPr = ref.type === 'pr';

  /** A quiet read neither shows the spinner nor clears an error the person has yet to read. */
  async function refresh({ quiet = false } = {}): Promise<WorkItemDetails | null> {
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
      return next;
    } catch (error) {
      if (alive.current && version === request.current && !quiet) {
        setMessageAt('head');
        setError(`Could not refresh details: ${ipcErrorMessage(error)}`);
      }
      return null;
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

  async function perform(mutation: WorkItemMutation, success: string, at: MessageAt): Promise<boolean> {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setMessageAt(at);
    try {
      await inboxBridge.mutateItem(workspaceId, ref, mutation);
      if (!alive.current) return false;
      setNotice(success);
      await refresh();
      return true;
    } catch (error) {
      if (!alive.current) return false;
      let message = ipcErrorMessage(error);
      // A comment is anchored to the diff it was written on. If the pull
      // request moved on, GitHub refuses it: say so, and show the new diff,
      // rather than move it to lines the person never saw.
      if (mutation.kind === 'line-comment') {
        const fresh = await refresh({ quiet: true });
        if (fresh?.headOid && fresh.headOid !== mutation.headOid) {
          message += ' New commits were pushed since this diff was loaded, so it has been refreshed. Comment on the lines as they are now.';
        }
      }
      if (alive.current) setError(message);
      return false;
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const notify = (text: string, at: MessageAt) => {
    setError('');
    setMessageAt(at);
    setNotice(text);
  };

  function handOff(prompt: string, at: MessageAt) {
    const refusal = onFix(prompt);
    if (refusal) {
      setNotice('');
      setMessageAt(at);
      setError(refusal);
    }
  }

  // "Add your review" in the merge card: the review is written in Files changed.
  function openReview() {
    setTab('Files changed');
    setReviewOpen(true);
    requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ block: 'start' }));
  }

  const open = details?.state === 'open';
  const viewerLogin = details?.viewer.login ?? accountLogin;
  const disabled = busy || loading;

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === 'ArrowRight' ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length
          : event.key === 'Home' ? 0
            : event.key === 'End' ? TABS.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(TABS[next]);
    (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
  };

  const headMessages = messageAt === 'head' && (
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

  // The strip: what the item is built from, refresh, and
  // the one rare edit left in a ⋯ menu. Editing moved to the description,
  // closing to the comment box.
  const canDraft = isPr && open && !details?.isDraft;
  const head = (
    <div className="inbox-detail inbox-detail-head">
      <div className="inbox-detail-toolbar">
        {details?.headBranch && <BranchPair head={details.headBranch} base={details.baseBranch} />}
        <div className="inbox-detail-toolbar-tail">
          <button
            className="inbox-detail-icon-btn"
            aria-label="Refresh details"
            title="Refresh details"
            disabled={disabled}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} className={loading ? 'inbox-detail-spin' : undefined} aria-hidden="true" />
          </button>
          {details && canDraft && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild disabled={disabled}>
                <button className="inbox-detail-icon-btn" aria-label="More actions" title="More actions">
                  <Ellipsis size={15} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
                  <DropdownMenu.Item
                    className="dropdown-item"
                    onSelect={() => void perform({ kind: 'ready', draft: true }, 'Converted to draft.', 'head')}
                  >
                    <GitPullRequestDraft size={14} aria-hidden="true" />
                    <span>Convert to draft</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      </div>
      {headMessages}
    </div>
  );

  const context: WorkItemDetailContextValue | null = details && {
    workspaceId,
    item,
    ref,
    details,
    isPr,
    open,
    accountLogin,
    ownItem: details.author.toLowerCase() === viewerLogin.toLowerCase(),
    busy: disabled,
    perform,
    notify,
    fixTarget,
    handOff,
    openWorkItem: onOpenWorkItem,
    quoteReply: (body) => {
      setTab('Conversation');
      requestAnimationFrame(() => composer.current?.insert(quoteReply(body)));
    },
    messageAt,
    error,
    notice,
    dismissError: () => setError(''),
  };

  return (
    <>
      {headSlot && createPortal(head, headSlot)}
      <section ref={setSection} className="inbox-detail" aria-label="Remote item details" aria-busy={busy || loading}>
        {!details && loading && (
          <div className="inbox-detail-skeleton" role="status">
            <span className="sr-only">Loading details…</span>
            <i /><i /><i /><i />
          </div>
        )}

        {details && context && (
          <WorkItemDetailContext.Provider value={context}>
            {isPr && (
              <div ref={tabsRef} className="inbox-detail-tabs" role="tablist" aria-label="Item details">
                {TABS.map((name, index) => {
                  const count = name === 'Conversation' ? conversationCount(details.timeline) : details.files.length;
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
                      {/* A narrow pane shows "Files"; the accessible name keeps the whole label. */}
                      {name === 'Files changed' ? <>Files<span className="inbox-detail-tab-long"> changed</span></> : name}
                      <span className="inbox-detail-tab-count">{count}</span>
                    </button>
                  );
                })}
                {details.additions !== undefined && (
                  <span className="inbox-detail-tabs-stat" aria-label={`${details.additions} additions, ${details.deletions ?? 0} deletions`}>
                    <DiffCounts additions={details.additions} deletions={details.deletions ?? 0} />
                  </span>
                )}
              </div>
            )}
            <div
              key={isPr ? tab : 'stream'}
              id={`${uid}-panel`}
              role={isPr ? 'tabpanel' : undefined}
              aria-labelledby={isPr ? `${uid}-tab-${TABS.indexOf(tab)}` : undefined}
              className="inbox-detail-content"
              data-tab={isPr ? (tab === 'Conversation' ? 'conversation' : 'files') : 'conversation'}
            >
              {tab === 'Conversation' || !isPr ? (
                <ConversationStream composerRef={composer} onAddReview={openReview} />
              ) : (
                <FilesChanged reviewOpen={reviewOpen} onReviewOpenChange={setReviewOpen} boundary={section} />
              )}
            </div>
          </WorkItemDetailContext.Provider>
        )}
      </section>
    </>
  );
}
