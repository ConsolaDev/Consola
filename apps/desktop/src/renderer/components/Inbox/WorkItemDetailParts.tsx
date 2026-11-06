import { createContext, useCallback, useContext, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import type { WorkItemDetails, WorkItemLabel, WorkItemMutation, WorkItemPerson, WorkItemReaction } from '../../../shared/workItemDetails';
import { workItemAssetUrl } from '../../../shared/workItemAssets';
import { MarkdownRenderer } from '../Markdown';
import {
  OUTCOME_TONE,
  REACTION_EMOJI,
  commentAge,
  initial,
  labelColors,
  type CheckOutcome,
  type CheckSummary,
  type StatusKind,
  type Tone,
} from './workItemDetailPresentation';

/** Who a Fix button hands its prompt to, in the words the buttons use. */
export type FixTarget = 'a session' | 'this session';

/**
 * Where the outcome of an action is said: beside what asked for it — the
 * strip, the merge card, the comment box, one thread, one file's line form.
 */
export type MessageAt = string;

/**
 * What every part of the pane needs from the panel that owns the item: the
 * details, the one write in flight, and where its outcome is said. A
 * context rather than props, because a reply box sits four components below
 * the panel; drafts stay local to the component that holds them, so typing
 * never re-renders the stream.
 */
export interface WorkItemDetailContextValue {
  workspaceId: string;
  item: InboxItem;
  ref: WorkItemRef;
  details: WorkItemDetails;
  isPr: boolean;
  /** The item is open, so verdicts, merges and fixes apply. */
  open: boolean;
  /** The account actions run as. */
  accountLogin: string;
  ownItem: boolean;
  /** A write in flight, or a read under way. */
  busy: boolean;
  /** Resolves to whether the write succeeded, so the form that asked can clear itself. */
  perform: (mutation: WorkItemMutation, success: string, at: MessageAt) => Promise<boolean>;
  notify: (notice: string, at: MessageAt) => void;
  fixTarget: FixTarget;
  /** Hands a fix prompt to a session; a refusal is said at `at`. */
  handOff: (prompt: string, at: MessageAt) => void;
  /** Opens another item in the Inbox pane; false when it is not there to open. */
  openWorkItem?: (ref: WorkItemRef) => boolean;
  /** Puts a quoted comment in the comment box. */
  quoteReply: (body: string) => void;
  messageAt: MessageAt;
  error: string;
  notice: string;
  dismissError: () => void;
}

export const WorkItemDetailContext = createContext<WorkItemDetailContextValue | null>(null);

export function useWorkItemDetail(): WorkItemDetailContextValue {
  const value = useContext(WorkItemDetailContext);
  if (!value) throw new Error('useWorkItemDetail outside WorkItemDetailPanel');
  return value;
}

/** The outcome of the last action, if it was asked for here. */
export function Messages({ at }: { at: MessageAt }) {
  const { messageAt, error, notice, dismissError } = useWorkItemDetail();
  if (messageAt !== at) return null;
  return (
    <>
      {error && (
        <div className="inbox-detail-message" data-tone="error" role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          <p>{error}</p>
          <button type="button" className="inbox-detail-icon-btn" aria-label="Dismiss error" onClick={dismissError}>
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
}

const STATUS_ICONS: Record<StatusKind, LucideIcon> = {
  'pr-open': GitPullRequest,
  'pr-draft': GitPullRequestDraft,
  'pr-merged': GitMerge,
  'pr-closed': GitPullRequestClosed,
  'issue-open': CircleDot,
  'issue-closed': CircleCheck,
  'issue-not-planned': CircleSlash,
};

export const OUTCOME_ICONS: Record<CheckOutcome, LucideIcon> = {
  failing: CircleX,
  pending: CircleDashed,
  passing: CircleCheck,
  skipped: CircleSlash,
};

export const TONE_ICONS: Record<Tone, LucideIcon> = {
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
  merged: GitMerge,
  accent: CircleDot,
  neutral: CircleDashed,
};

/** Keyed by the state it shows, so a merge or close visibly lands. */
export function StateBadge({ kind, label, tone }: { kind: StatusKind; label: string; tone: Tone }) {
  const Icon = STATUS_ICONS[kind];
  return (
    <span className="inbox-detail-state" data-tone={tone}>
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * One branch name, cut short with an ellipsis when the row runs out. Hovering
 * a cut-short chip shows the whole name; a chip that fits shows nothing, since
 * the tooltip would only repeat it. Radix rather than `title`, like every
 * other tooltip here: the native one did not appear in this window.
 */
function BranchChip({ name }: { name: string }) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const isCut = () => !!ref.current && ref.current.scrollWidth > ref.current.clientWidth;
  return (
    <Tooltip.Root open={open} onOpenChange={(next) => setOpen(next && isCut())}>
      <Tooltip.Trigger asChild>
        <code ref={ref}>{name}</code>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content inbox-detail-branch-tooltip" sideOffset={6} align="start">
          {name}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** As GitHub draws it: the base the pull request merges into, then ← the head it comes from. */
export function BranchPair({ head, base }: { head: string; base: string | undefined }) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <span className="inbox-detail-branches" role="group" aria-label={base ? `Merges ${head} into ${base}` : head}>
        <BranchChip name={base ?? ''} />
        <ArrowLeft size={12} aria-hidden="true" />
        <BranchChip name={head} />
      </span>
    </Tooltip.Provider>
  );
}

/** The tone of the checks as a whole: one failure outweighs any number of passes. */
export function rollupOutcome(summary: CheckSummary): CheckOutcome | null {
  if (summary.total === 0) return null;
  if (summary.failing) return 'failing';
  if (summary.pending) return 'pending';
  return summary.passing ? 'passing' : 'skipped';
}

export function CheckIcon({ outcome, size = 14 }: { outcome: CheckOutcome; size?: number }) {
  const Icon = OUTCOME_ICONS[outcome];
  return <Icon size={size} className="inbox-detail-tone-icon" data-tone={OUTCOME_TONE[outcome]} aria-hidden="true" />;
}

export function DiffCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inbox-detail-counts">
      <span className="inbox-detail-add">+{additions}</span>
      <span className="inbox-detail-del">−{deletions}</span>
    </span>
  );
}

/**
 * A description or comment as GitHub would show it: its HTML rendered
 * (sanitized), and its images loaded through main as the workspace's
 * account, so a screenshot pasted into a private repo appears too. A click
 * on an image opens it full-window to zoom into.
 */
export function WorkItemMarkdown({ content }: { content: string }) {
  const { workspaceId } = useWorkItemDetail();
  const resolveImageSrc = useCallback((src: string | undefined) => workItemAssetUrl(workspaceId, src), [workspaceId]);
  return (
    <MarkdownRenderer content={content} enableCommandHighlighting={false} allowHtml resolveImageSrc={resolveImageSrc} zoomableImages />
  );
}

/** Avatars already drawn once this run: shown at once on a remount, without a flash of the initial. */
const loadedAvatars = new Set<string>();

function AvatarImage({ person, src, size }: { person: WorkItemPerson; src: string | undefined; size: number }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>(src && loadedAvatars.has(src) ? 'loaded' : 'loading');
  return (
    <span className="inbox-detail-avatar" data-size={size} data-bot={person.isBot || undefined} aria-hidden="true">
      {state !== 'loaded' && initial(person.login)}
      {src && state !== 'failed' && (
        <img
          src={src}
          alt=""
          loading="lazy"
          draggable={false}
          data-loaded={state === 'loaded' || undefined}
          onLoad={() => {
            loadedAvatars.add(src);
            setState('loaded');
          }}
          onError={() => setState('failed')}
        />
      )}
    </span>
  );
}

/**
 * Someone's picture, through main like every image in an item. Until it has
 * loaded, or if it never does, their initial shows instead: a broken image
 * never does. Round for people, a rounded square for bots.
 */
export function Avatar({ person, size = 20 }: { person: WorkItemPerson; size?: 16 | 20 }) {
  const { workspaceId } = useWorkItemDetail();
  const src = workItemAssetUrl(workspaceId, person.avatarUrl);
  return <AvatarImage key={src ?? 'none'} person={person} src={src} size={size} />;
}

/**
 * A label in the colour its repository gave it on GitHub, drawn as
 * Consola's tinted pill: the one place a colour comes from outside the
 * theme, because teams give those colours meaning. The text keeps the hue,
 * made readable for each theme (labelColors).
 */
export function ItemLabel({ label }: { label: WorkItemLabel }) {
  const colors = labelColors(label.color);
  const style = {
    '--label-fill': colors.fill,
    '--label-border': colors.border,
    '--label-text-dark': colors.dark,
    '--label-text-light': colors.light,
  } as CSSProperties;
  return (
    <span className="inbox-detail-gh-label" style={style}>
      {label.name}
    </span>
  );
}

export function RelativeTime({ iso }: { iso: string }) {
  const age = commentAge(iso);
  if (!age) return null;
  return (
    <time className="inbox-detail-time" dateTime={iso} title={new Date(iso).toLocaleString()}>
      {age}
    </time>
  );
}

/** Read-only: the reactions given, the viewer's own outlined. */
export function Reactions({ reactions }: { reactions: WorkItemReaction[] }) {
  if (reactions.length === 0) return null;
  return (
    <ul className="inbox-detail-reactions" aria-label="Reactions">
      {reactions.map((reaction) => (
        <li
          key={reaction.content}
          className="inbox-detail-reaction"
          data-mine={reaction.viewerReacted || undefined}
          aria-label={`${REACTION_EMOJI[reaction.content]} ${reaction.count}${reaction.viewerReacted ? ', including you' : ''}`}
        >
          <span aria-hidden="true">{REACTION_EMOJI[reaction.content]}</span>
          <span aria-hidden="true">{reaction.count}</span>
        </li>
      ))}
    </ul>
  );
}

/** A small tinted pill: Author, Bot, Pending, Outdated. */
export function Chip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="inbox-detail-chip" data-tone={tone}>
      {children}
    </span>
  );
}
