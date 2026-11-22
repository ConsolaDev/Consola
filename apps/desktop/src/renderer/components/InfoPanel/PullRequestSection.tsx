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
import type { ReactNode } from 'react';
import { PROVIDER_META } from '../../../shared/providers';
import type { WorkItemDetails } from '../../../shared/workItemDetails';
import { sameWorkItem, type WorkItemRef, workItemUrl } from '../../../shared/workItems';
import { useSettings } from '../../contexts/SettingsContext';
import {
  checksLine,
  commentsLine,
  type InfoLine,
  mergeLine,
  reviewersSaid,
  reviewLine,
  threadsLine,
} from '../../infoPanel/pullRequestLines';
import { detailsTargetOf, type PullRequestSectionView } from '../../infoPanel/sessionPullRequest';
import { type TabFacts, tabKind } from '../../sidePanel/tabKinds';
import { useInboxStore } from '../../stores/inboxStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
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
 */
export function PullRequestSection({ facts, view }: { facts: TabFacts; view: ShownView }) {
  const title = view.ref?.type === 'issue' ? 'Issue' : 'Pull request';
  const target = view.kind === 'item' ? detailsTargetOf(facts.workspace, view.ref) : null;
  if (!target) {
    return (
      <InfoSection
        id="pull-request"
        title={title}
        actions={view.ref && <OpenOnProvider item={view.ref} url={workItemUrl(view.ref)} />}
      >
        <NoAccountRows />
      </InfoSection>
    );
  }
  return (
    <InfoSection
      id="pull-request"
      title={title}
      actions={<ItemActions facts={facts} target={target} />}
    >
      <ItemRows facts={facts} target={target} />
    </InfoSection>
  );
}

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

/** Open on the provider, refresh, and the Run menu for a linked session. */
function ItemActions({ facts, target }: { facts: TabFacts; target: DetailsTarget }) {
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
        onClick={() => readAgain(target)}
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

function ItemRows({ facts, target }: { facts: TabFacts; target: DetailsTarget }) {
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
  const name = details?.title ?? item?.title;
  const label = `${name ?? (ref.type === 'pr' ? 'Pull request' : 'Issue')} #${ref.number}`;
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
  const checks = checksLine(details.checks);
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

/** Nothing to read the item with: the way to give the workspace an account. */
function NoAccountRows() {
  const { openSettings } = useSettings();
  return (
    <QuietLine
      text="This workspace has no account to read pull requests with."
      action={{ label: 'Workspace settings', run: () => openSettings('provider') }}
    />
  );
}

/** One muted sentence, wrapped rather than cut, and at most one thing to do about it. */
function QuietLine({
  text,
  action,
}: {
  text: string;
  action?: { label: string; run: () => void };
}) {
  return (
    <div className="info-quiet">
      <p className="info-quiet-text">{text}</p>
      {action && (
        <button type="button" className="info-quiet-action" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
