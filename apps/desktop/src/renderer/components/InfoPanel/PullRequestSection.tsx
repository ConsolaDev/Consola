import {
  CircleDot,
  ExternalLink,
  Eye,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  MessagesSquare,
  RefreshCw,
  Tag,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { PROVIDER_META } from '../../../shared/providers';
import type { WorkItemDetails } from '../../../shared/workItemDetails';
import { sameWorkItem, type WorkItemRef, workItemUrl } from '../../../shared/workItems';
import { useSettings } from '../../contexts/SettingsContext';
import {
  checksLine,
  commentsLine,
  type InfoLine,
  mergeLine,
  noAccountLine,
  reviewersSaid,
  reviewLine,
  threadsLine,
  titleLabel,
} from '../../infoPanel/pullRequestLines';
import { detailsTargetOf, type PullRequestSectionView } from '../../infoPanel/sessionPullRequest';
import { type TabFacts, tabKind } from '../../sidePanel/tabKinds';
import {
  useBranchLookupEntry,
  useBranchPullRequestStore,
} from '../../stores/branchPullRequestStore';
import { useInboxStore } from '../../stores/inboxStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import {
  type DetailsTarget,
  useDetailsEntry,
  useWorkItemDetails,
  useWorkItemDetailsStore,
} from '../../stores/workItemDetailsStore';
import { Avatar, CheckIcon, rollupOutcome, StateBadge } from '../Inbox/WorkItemDetailParts';
import { itemStatus, summarizeChecks } from '../Inbox/workItemDetailPresentation';
import { RunActionMenu } from '../RunActionMenu';
import { InfoRow } from './InfoRow';
import { InfoSection } from './InfoSection';

const ICON_SIZE = 14;

type ShownView = Exclude<PullRequestSectionView, { kind: 'hidden' }>;

/** How a line names its item: `pull request`, or `issue`. */
const nounOf = (ref: WorkItemRef) => (ref.type === 'pr' ? 'pull request' : 'issue');

/**
 * The session's pull request or issue at a glance: its title, state, base
 * and the action it was started with, then a line each for its checks,
 * review, unresolved threads and what stands in the way of a merge (an
 * issue: its comments). Each line opens the Pull request tab, where the pane
 * has more, and goes to the place it has for that line when there is one.
 *
 * The details are the pane's own read, shared through `workItemDetailsStore`:
 * this section and the tab together read an item once. They are read only
 * while the section is open, which is when its rows are mounted, and the
 * info panel is shown.
 *
 * An unlinked session on a branch shows the pull request found from it,
 * with Link to make it the session's own, or what the lookup said: still
 * looking, none, or why it failed. `ContentView` asks for the lookup; this
 * only draws its answer.
 */
export function PullRequestSection({ facts, view }: { facts: TabFacts; view: ShownView }) {
  switch (view.kind) {
    case 'looking':
      return (
        <InfoSection id="pull-request" title="Pull request">
          <QuietLine text="Looking for this branch’s pull request…" />
        </InfoSection>
      );
    case 'none':
      return (
        <InfoSection id="pull-request" title="Pull request">
          <QuietLine text="No pull request for this branch." />
        </InfoSection>
      );
    case 'lookup-failed':
      return (
        <InfoSection id="pull-request" title="Pull request">
          <LookupFailedRows facts={facts} error={view.error} />
        </InfoSection>
      );
    case 'no-account':
      return (
        <InfoSection
          id="pull-request"
          title={titleOf(view.ref)}
          actions={view.ref && <OpenOnProvider item={view.ref} url={workItemUrl(view.ref)} />}
        >
          <NoAccountRows item={view.ref} />
        </InfoSection>
      );
    case 'item': {
      const target = detailsTargetOf(facts.workspace, view.ref);
      // `item` is drawn only with an account, so the target is always there.
      if (!target) return null;
      return (
        <InfoSection
          id="pull-request"
          title={titleOf(view.ref)}
          actions={<ItemActions facts={facts} target={target} found={view.found} />}
        >
          <ItemRows facts={facts} target={target} found={view.found} />
        </InfoSection>
      );
    }
  }
}

/** The section's heading: `Issue` for a linked issue, else `Pull request`. */
const titleOf = (ref: WorkItemRef | undefined) =>
  ref?.type === 'issue' ? 'Issue' : 'Pull request';

/** The Inbox's copy of the item, while it lists it: a title and state before the details arrive. */
function useInboxItem(workspaceId: string, ref: WorkItemRef) {
  return useInboxStore((state) =>
    state.snapshots[workspaceId]?.items.find((candidate) => sameWorkItem(candidate.workItem, ref)),
  );
}

/** Reads the item again now, for every viewer of it: the person's Refresh and Retry. */
function readAgain(target: DetailsTarget): void {
  void useWorkItemDetailsStore.getState().load(target, { force: true });
}

/**
 * Looks the checkout's branch up again now, past main's cache: the person's
 * Retry, and Refresh on a pull request found from the branch.
 */
function lookAgain(facts: TabFacts): void {
  const dir = facts.checkoutPath;
  if (!dir) return;
  const branch = facts.checkout?.kind === 'none' ? undefined : facts.checkout?.branch;
  void useBranchPullRequestStore.getState().find(facts.workspace.id, dir, { force: true, branch });
}

/** Open on the provider, refresh, and the Run menu for a linked session. */
function ItemActions({
  facts,
  target,
  found,
}: {
  facts: TabFacts;
  target: DetailsTarget;
  found: boolean;
}) {
  // The rows watch the item; the heading only reads what they keep current.
  const entry = useDetailsEntry(target);
  const item = useInboxItem(target.workspaceId, target.ref);
  const refresh = `Refresh ${nounOf(target.ref)}`;
  const loading = entry?.loading ?? false;
  return (
    <>
      <OpenOnProvider
        item={target.ref}
        url={entry?.details?.url ?? item?.url ?? workItemUrl(target.ref)}
      />
      <button
        type="button"
        className="info-section-action"
        aria-label={refresh}
        title={refresh}
        aria-busy={loading}
        onClick={() => {
          readAgain(target);
          // Found from the branch: whether it is still the branch's is asked again too.
          if (found) lookAgain(facts);
        }}
      >
        <RefreshCw
          size={13}
          aria-hidden="true"
          className={loading ? 'info-section-action-spin' : undefined}
        />
      </button>
      {/* Run sends an action into this session: only a linked one has the item's actions. */}
      {facts.session.workItem && (
        <RunActionMenu
          workspace={facts.workspace}
          session={facts.session}
          triggerClassName="info-section-action info-section-run"
        />
      )}
    </>
  );
}

function OpenOnProvider({ item, url }: { item: WorkItemRef; url: string }) {
  const label = `Open on ${PROVIDER_META[item.provider].displayName}`;
  return (
    <a
      className="info-section-action"
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
    >
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}

function ItemRows({
  facts,
  target,
  found,
}: {
  facts: TabFacts;
  target: DetailsTarget;
  found: boolean;
}) {
  // Mounted only while the section is open, so this is the active viewer the
  // read waits for: a folded section or a hidden panel reads nothing.
  const entry = useWorkItemDetails(target, true);
  const item = useInboxItem(target.workspaceId, target.ref);
  const openKind = useSidePanelStore((state) => state.openKind);
  const reveal = useSidePanelStore((state) => state.reveal);
  const { ref } = target;
  const details = entry?.details;
  const noun = nounOf(ref);

  // A row opens the tab only while the tab can show the item.
  const opens = tabKind('pull-request')?.availability(facts).available ?? false;
  const activate = (line?: InfoLine) => {
    if (!opens) return undefined;
    const place = line?.reveal;
    return place
      ? () => reveal('pull-request', facts.session.id, place)
      : () => openKind('pull-request');
  };

  // The Inbox's copy names the item until the details do.
  const label = titleLabel(ref, details?.title ?? item?.title);
  const state = details
    ? itemStatus(ref.type, details.state, details.isDraft, details.stateReason)
    : item?.state
      ? itemStatus(ref.type, item.state, item.isDraft)
      : null;
  const base = ref.type === 'pr' ? details?.baseBranch : undefined;
  // The action belongs to the session's link, never to an item found from its branch.
  const action = facts.session.workItem ? facts.session.workItemAction : undefined;
  const failed = entry?.error && !entry.loading ? entry.error : undefined;

  return (
    <>
      <InfoRow
        icon={
          ref.type === 'pr' ? <GitPullRequest size={ICON_SIZE} /> : <CircleDot size={ICON_SIZE} />
        }
        label={label}
        title={label}
        onActivate={activate()}
      />
      {(state || base || action) && (
        <div className="info-pr-meta">
          {/* Keyed by the state it shows, so a merge or close visibly lands. */}
          {state && <StateBadge key={state.kind} {...state} />}
          {base && (
            <span>
              into <span className="info-branch">{base}</span>
            </span>
          )}
          {action && (
            <span className="info-pr-action" title={`Started with the ${action} action`}>
              {/* A label, not a verb: a play glyph would read as "run this". */}
              <Tag size={11} aria-hidden="true" />
              {action}
            </span>
          )}
        </div>
      )}
      {/* Keyed by session: the panel stays mounted across a switch, and a
          refusal or a link in flight belongs to the session it was for. */}
      {found && <FoundRow key={facts.session.id} facts={facts} item={ref} />}
      {details && ref.type === 'pr' && (
        <PullRequestLines workspaceId={target.workspaceId} details={details} activate={activate} />
      )}
      {details && ref.type === 'issue' && (
        <InfoRow
          icon={<MessageSquare size={ICON_SIZE} />}
          label={commentsLine(details.timeline).text}
          onActivate={activate()}
        />
      )}
      {failed ? (
        <QuietLine
          text={`Couldn’t read the ${noun}: ${failed}`}
          action={{ label: 'Retry', run: () => readAgain(target) }}
        />
      ) : (
        !details && <QuietLine text={`Reading the ${noun}…`} />
      )}
    </>
  );
}

/** A pull request's lines: checks, review, unresolved threads, and what is in the way of a merge. */
function PullRequestLines({
  workspaceId,
  details,
  activate,
}: {
  workspaceId: string;
  details: WorkItemDetails;
  activate: (line?: InfoLine) => (() => void) | undefined;
}) {
  const checks = checksLine(details);
  const outcome = rollupOutcome(summarizeChecks(details.checks));
  const review = reviewLine(details);
  const threads = threadsLine(details.threads);
  const merge = mergeLine(details);
  return (
    <>
      {checks && outcome && (
        <LineRow line={checks} icon={<CheckIcon outcome={outcome} />} activate={activate} />
      )}
      <InfoRow
        icon={<Eye size={ICON_SIZE} />}
        label={review.text}
        tone={review.tone}
        value={
          review.reviewers.length > 0 ? (
            <span className="info-reviewers">
              {review.reviewers.map(({ who, ring }) => (
                <span key={who.login} className="info-reviewer" data-ring={ring}>
                  <Avatar person={who} size={16} workspaceId={workspaceId} />
                </span>
              ))}
            </span>
          ) : undefined
        }
        title={review.reviewers.length > 0 ? reviewersSaid(review.reviewers) : undefined}
        onActivate={activate()}
      />
      {threads && (
        <LineRow line={threads} icon={<MessagesSquare size={ICON_SIZE} />} activate={activate} />
      )}
      {merge && <LineRow line={merge} icon={<GitMerge size={ICON_SIZE} />} activate={activate} />}
    </>
  );
}

function LineRow({
  line,
  icon,
  activate,
}: {
  line: InfoLine;
  icon: ReactNode;
  activate: (line?: InfoLine) => (() => void) | undefined;
}) {
  return (
    <InfoRow
      icon={icon}
      label={line.text}
      value={line.value}
      tone={line.tone}
      onActivate={activate(line)}
    />
  );
}

/**
 * Where a pull request found from the branch came from, and the way to make
 * it the session's own. Linking writes the session's item, as the Link
 * dialog does; until then nothing is written. A refusal (main's, such as a
 * conductor's) is said under the button.
 */
function FoundRow({ facts, item }: { facts: TabFacts; item: WorkItemRef }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const link = async () => {
    if (linking) return;
    setRefusal(null);
    setLinking(true);
    try {
      await useWorkspaceStore
        .getState()
        .updateSession(facts.workspace.id, facts.session.id, { workItem: item });
    } catch (error) {
      setRefusal(ipcErrorMessage(error));
    } finally {
      setLinking(false);
    }
  };
  return (
    <QuietLine
      text="Found from the branch"
      action={{ label: 'Link', run: () => void link(), busy: linking }}
      error={refusal ?? undefined}
    />
  );
}

/** The lookup failed: why, and the way to ask again. */
function LookupFailedRows({ facts, error }: { facts: TabFacts; error: string }) {
  const loading = useBranchLookupEntry(facts.workspace, facts.session)?.loading ?? false;
  return (
    <QuietLine
      text={`Couldn’t look for this branch’s pull request: ${error}`}
      action={{ label: 'Retry', run: () => lookAgain(facts), busy: loading }}
    />
  );
}

/** Nothing to read the item with: the way to give the workspace an account. */
function NoAccountRows({ item }: { item: WorkItemRef | undefined }) {
  const { openSettings } = useSettings();
  return (
    <QuietLine
      text={noAccountLine(item)}
      action={{ label: 'Workspace settings', run: () => openSettings('provider') }}
    />
  );
}

/**
 * One muted sentence, wrapped rather than cut, and at most one thing to do
 * about it, with why that was refused under it. A busy action stays
 * focusable: disabling it would drop the keyboard to the body.
 */
function QuietLine({
  text,
  action,
  error,
}: {
  text: string;
  action?: { label: string; run: () => void; busy?: boolean };
  error?: string;
}) {
  return (
    <div className="info-quiet">
      <p className="info-quiet-text">{text}</p>
      {action && (
        <button
          type="button"
          className="info-quiet-action"
          aria-busy={action.busy}
          onClick={action.run}
        >
          {action.label}
        </button>
      )}
      {error && (
        <p className="info-quiet-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
