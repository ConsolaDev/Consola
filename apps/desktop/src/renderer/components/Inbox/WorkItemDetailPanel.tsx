import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  CircleAlert,
  CircleCheck,
  Ellipsis,
  GitPullRequestDraft,
  RefreshCw,
  X,
} from 'lucide-react';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import type { WorkItemDetails, WorkItemMutation } from '../../../shared/workItemDetails';
import { inboxBridge } from '../../services/inboxBridge';
import {
  type DetailsTarget,
  detailsKey,
  useWorkItemDetails,
  useWorkItemDetailsStore,
} from '../../stores/workItemDetailsStore';
import type { RevealTarget } from '../../infoPanel/pullRequestLines';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import {
  conversationCount,
  errorAfterRead,
  quoteReply,
  readFailureMessage,
  type SaidReadFailure,
} from './workItemDetailPresentation';
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
  /**
   * Whether the pane is on screen. Only then is the item read, and kept
   * current; one that is not shows what was last read. Defaults to true.
   */
  active?: boolean;
  /**
   * A place the person asked to see from the info panel: the merge card, or
   * Files changed. Each `seq` is one ask, acted on once.
   */
  reveal?: { at: RevealTarget; seq: number };
}

type Tab = 'Conversation' | 'Files changed';
const TABS: Tab[] = ['Conversation', 'Files changed'];

/** A confirmation is read, then gone; an error stays until dismissed or retried. */
const NOTICE_MS = 5000;

/**
 * The newest ask a pane has acted on, for every pane in this window: asks
 * are numbered across the window, so a pane that mounts again (the session
 * left and come back to, the item relinked) never replays one already
 * answered, while the pane an ask mounts still acts on it.
 */
let revealedSeq = 0;

function claimReveal(seq: number): boolean {
  if (seq <= revealedSeq) return false;
  revealedSeq = seq;
  return true;
}

/**
 * A pull request or issue as on github.com, in Consola's own look: one
 * Conversation stream (description, the whole timeline, the merge card, a
 * comment box) and, for a pull request, Files changed, where a review is
 * written. Every write goes through `perform`, one at a time, says its
 * outcome beside what asked for it, and reads the item again after.
 *
 * The item's details come from `workItemDetailsStore`, shared with every
 * other viewer of it, which reads only while some viewer is active, and asks
 * GitHub again about a mergeability it is still working out.
 */
export function WorkItemDetailPanel({
  workspaceId,
  accountLogin,
  item,
  headSlot,
  onFix,
  fixTarget = 'a session',
  onDetails,
  onOpenWorkItem,
  active = true,
  reveal,
}: Props) {
  const ref = item.workItem;
  const target: DetailsTarget = { workspaceId, accountLogin, ref };
  const entry = useWorkItemDetails(target, active);
  // The store drops the details of items nobody watches past its cap. A pane
  // behind another tab still holds its drafts and scroll in what it shows, so
  // it keeps the last details it showed until it reads again or unmounts, as
  // it kept them itself before the store.
  const key = detailsKey(target);
  const shown = useRef<{ key: string; details: WorkItemDetails } | null>(null);
  if (entry?.details) shown.current = { key, details: entry.details };
  const details = entry?.details ?? (shown.current?.key === key ? shown.current.details : null);
  const loading = entry?.loading ?? true;
  const [tab, setTab] = useState<Tab>('Conversation');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [messageAt, setMessageAt] = useState<MessageAt>('head');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const [revealingMerge, setRevealingMerge] = useState(false);
  const alive = useRef(true);
  const writing = useRef(false);
  const composer = useRef<MarkdownEditorHandle>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const isPr = ref.type === 'pr';

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Reads the item again now, for every viewer of it. A quiet read neither
   * shows the spinner nor clears an error the person has yet to read.
   */
  async function refresh({ quiet = false } = {}): Promise<WorkItemDetails | null> {
    if (!quiet) setError('');
    const answer = await useWorkItemDetailsStore.getState().load(target, { force: true, quiet });
    if (!quiet && answer.error && alive.current) {
      setMessageAt('head');
      setError(readFailureMessage(answer.error));
    }
    return answer.details ?? null;
  }

  // A failed read the pane did not start (the one watching starts, a
  // re-check, another viewer's Refresh) is said here as `refresh` says its
  // own. One that failed before the pane mounted is not news. Each one said
  // is remembered, so a later good read, whoever asked for it, takes it back.
  const failedAt = entry?.errorAt;
  const failure = entry?.error;
  const fetchedAt = entry?.fetchedAt ?? 0;
  const shownFailureAt = useRef(failedAt);
  const saidFailure = useRef<SaidReadFailure | null>(null);
  useEffect(() => {
    if (!failedAt || failedAt === shownFailureAt.current) return;
    shownFailureAt.current = failedAt;
    const message = readFailureMessage(failure ?? '');
    saidFailure.current = { message, at: failedAt };
    setMessageAt('head');
    setError(message);
  }, [failedAt, failure]);
  useEffect(() => {
    const said = saidFailure.current;
    if (said) setError((shown) => errorAfterRead(shown, said, fetchedAt));
  }, [fetchedAt]);

  // Every fresh read, whoever asked for it.
  useEffect(() => {
    if (details) onDetails?.(details);
  }, [details, onDetails]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function perform(
    mutation: WorkItemMutation,
    success: string,
    at: MessageAt,
  ): Promise<boolean> {
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
          message +=
            ' New commits were pushed since this diff was loaded, so it has been refreshed. Comment on the lines as they are now.';
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

  // A place asked for from the info panel, once there are details to show it
  // in: the checks and the merge state are in the Conversation's merge card,
  // the threads in Files changed.
  const hasDetails = details !== null;
  const revealAt = reveal?.at;
  const revealSeq = reveal?.seq;
  useEffect(() => {
    if (!hasDetails || revealAt === undefined || revealSeq === undefined) return;
    if (!claimReveal(revealSeq)) return;
    if (revealAt === 'files') {
      setTab('Files changed');
      requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ block: 'start' }));
    } else {
      setTab('Conversation');
      setRevealingMerge(true);
    }
  }, [hasDetails, revealAt, revealSeq]);

  // The merge card, scrolled to once the Conversation is in the DOM. The
  // stream lays out only the cards near the screen (`content-visibility`),
  // sizing the rest by estimate, so a scroll among estimates lands short as
  // they render. While this is set the stream lays out whole, which puts the
  // card where it really is; each card keeps the size it had then
  // (`contain-intrinsic-size: auto`), so nothing moves once it is unset.
  useLayoutEffect(() => {
    if (!revealingMerge || !section) return;
    section.querySelector('[aria-label="Merge"]')?.scrollIntoView({ block: 'start' });
    // Unset only after a frame has laid it out whole, when the sizes are kept.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setRevealingMerge(false));
    });
    return () => cancelAnimationFrame(frame);
  }, [revealingMerge, section]);

  const open = details?.state === 'open';
  const viewerLogin = details?.viewer.login ?? accountLogin;
  const disabled = busy || loading;

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (index + TABS.length - 1) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
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
          <button
            className="inbox-detail-icon-btn"
            aria-label="Dismiss error"
            onClick={() => setError('')}
          >
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
            <RefreshCw
              size={14}
              className={loading ? 'inbox-detail-spin' : undefined}
              aria-hidden="true"
            />
          </button>
          {details && canDraft && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild disabled={disabled}>
                <button
                  className="inbox-detail-icon-btn"
                  aria-label="More actions"
                  title="More actions"
                >
                  <Ellipsis size={15} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
                  <DropdownMenu.Item
                    className="dropdown-item"
                    onSelect={() =>
                      void perform({ kind: 'ready', draft: true }, 'Converted to draft.', 'head')
                    }
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
      <section
        ref={setSection}
        className="inbox-detail"
        aria-label="Remote item details"
        aria-busy={busy || loading}
        data-revealing={revealingMerge || undefined}
      >
        {!details && loading && (
          <div className="inbox-detail-skeleton" role="status">
            <span className="sr-only">Loading details…</span>
            <i />
            <i />
            <i />
            <i />
          </div>
        )}

        {details && context && (
          <WorkItemDetailContext.Provider value={context}>
            {isPr && (
              <div
                ref={tabsRef}
                className="inbox-detail-tabs"
                role="tablist"
                aria-label="Item details"
              >
                {TABS.map((name, index) => {
                  const count =
                    name === 'Conversation'
                      ? conversationCount(details.timeline)
                      : details.files.length;
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
                      {name === 'Files changed' ? (
                        <>
                          Files<span className="inbox-detail-tab-long"> changed</span>
                        </>
                      ) : (
                        name
                      )}
                      <span className="inbox-detail-tab-count">{count}</span>
                    </button>
                  );
                })}
                {details.additions !== undefined && (
                  <span
                    className="inbox-detail-tabs-stat"
                    aria-label={`${details.additions} additions, ${details.deletions ?? 0} deletions`}
                  >
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
                <FilesChanged
                  reviewOpen={reviewOpen}
                  onReviewOpenChange={setReviewOpen}
                  boundary={section}
                />
              )}
            </div>
          </WorkItemDetailContext.Provider>
        )}
      </section>
    </>
  );
}
