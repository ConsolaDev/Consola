import { memo, useMemo, useState, type ReactNode, type Ref } from 'react';
import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  Eye,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  MessageSquare,
  Pencil,
  Tag,
  Upload,
  UserRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { WorkItemCommitItem, WorkItemPost, WorkItemReference, WorkItemReviewer } from '../../../shared/workItemDetails';
import { MOD_KEY, isSubmitChord } from './inboxPresentation';
import {
  buildStream,
  checkOutcome,
  checkLabel,
  commitRunSentence,
  reviewVerb,
  type EventIcon,
  type Segment,
  type StreamEntry,
  type StreamEvent,
} from './workItemDetailPresentation';
import {
  Avatar,
  CheckIcon,
  Chip,
  ItemLabel,
  Messages,
  Reactions,
  RelativeTime,
  TONE_ICONS,
  useWorkItemDetail,
} from './WorkItemDetailParts';
import { MarkdownEditor, type MarkdownEditorHandle } from './WorkItemMarkdownEditor';
import { BodyEditor, PostBody, PostMenu, ReviewThread } from './WorkItemThread';
import { MergeCard } from './WorkItemMergeCard';
import { CommentBox } from './WorkItemCommentBox';

const EVENT_ICONS: Record<EventIcon, LucideIcon> = {
  label: Tag,
  pencil: Pencil,
  push: Upload,
  eye: Eye,
  person: UserRound,
  link: Link2,
  draft: GitPullRequestDraft,
  ready: Eye,
  'pr-closed': GitPullRequestClosed,
  'issue-closed': CircleCheck,
  'not-planned': CircleSlash,
  reopened: CircleDot,
  merged: GitMerge,
  branch: GitBranch,
  approved: CircleCheck,
  changes: FileDiff,
  review: MessageSquare,
  commit: GitCommitHorizontal,
};

const REVIEWER_MARKS: Record<WorkItemReviewer['state'], { icon: LucideIcon; tone: 'success' | 'error' | 'warning' | 'neutral'; words: string }> = {
  approved: { icon: CircleCheck, tone: 'success', words: 'approved' },
  'changes-requested': { icon: FileDiff, tone: 'error', words: 'requested changes' },
  requested: { icon: CircleDot, tone: 'warning', words: 'review requested' },
  commented: { icon: MessageSquare, tone: 'neutral', words: 'commented' },
  dismissed: { icon: CircleSlash, tone: 'neutral', words: 'review dismissed' },
};

/** Reviewers, assignees and labels, read-only, each group gone when empty: the facts at a glance. */
function ChipRow() {
  const { details } = useWorkItemDetail();
  const groups: Array<[string, ReactNode]> = [];
  if (details.reviewers.length) {
    groups.push(['Reviewers', details.reviewers.map((reviewer) => {
      const mark = REVIEWER_MARKS[reviewer.state];
      const Icon = mark.icon;
      return (
        <li key={`${reviewer.isTeam ? 'team' : 'user'}:${reviewer.who.login}`} className="inbox-detail-person" title={`${reviewer.who.login}: ${mark.words}`}>
          <Avatar person={reviewer.who} size={16} />
          <span>{reviewer.who.login}</span>
          <Icon size={13} className="inbox-detail-tone-icon" data-tone={mark.tone} aria-hidden="true" />
          <span className="sr-only">, {mark.words}</span>
        </li>
      );
    })]);
  }
  if (details.assignees.length) {
    groups.push(['Assignees', details.assignees.map((person) => (
      <li key={person.login} className="inbox-detail-person">
        <Avatar person={person} size={16} />
        <span>{person.login}</span>
      </li>
    ))]);
  }
  if (details.labels.length) {
    groups.push(['Labels', details.labels.map((label) => <li key={label.name}><ItemLabel label={label} /></li>)]);
  }
  if (groups.length === 0) return null;
  return (
    <div className="inbox-detail-chips">
      {groups.map(([name, chips]) => (
        <div key={name} className="inbox-detail-chip-group">
          <span className="inbox-detail-chip-label">{name}</span>
          <ul aria-label={name}>{chips}</ul>
        </div>
      ))}
    </div>
  );
}

/**
 * One voice in the conversation: who, what they did, when, then what they
 * wrote. The description, comments and reviews are all one of these.
 */
function PostCard({
  post,
  verb,
  verdict,
  at,
  quotable = true,
  edit,
  empty,
  fix,
  children,
}: {
  post: WorkItemPost;
  verb: string;
  verdict?: { tone: 'success' | 'error' };
  at: string;
  quotable?: boolean;
  /** How Edit replaces the body, when the viewer may edit it. */
  edit?: (close: () => void) => ReactNode;
  empty?: ReactNode;
  fix?: () => void;
  children?: ReactNode;
}) {
  const { details, fixTarget, quoteReply } = useWorkItemDetail();
  const [editing, setEditing] = useState(false);
  const isAuthor = post.author.login === details.author && verb !== 'opened this';
  const VerdictIcon = verdict ? TONE_ICONS[verdict.tone] : null;
  return (
    <article className="inbox-detail-card" aria-label={`${post.author.login} ${verb}`}>
      <header className="inbox-detail-post-head inbox-detail-card-head">
        <Avatar person={post.author} />
        <strong className="inbox-detail-post-author">{post.author.login}</strong>
        {VerdictIcon ? (
          <span className="inbox-detail-pill" data-tone={verdict!.tone}>
            <VerdictIcon size={12} aria-hidden="true" />
            {verb}
          </span>
        ) : (
          <span className="inbox-detail-verb">{verb}</span>
        )}
        <RelativeTime iso={post.createdAt} />
        {post.editedAt && <span className="inbox-detail-edited">· edited</span>}
        {post.author.isBot && <Chip>Bot</Chip>}
        {isAuthor && <Chip>Author</Chip>}
        <PostMenu
          post={post}
          at={at}
          onQuote={quotable && post.body.trim() ? () => quoteReply(post.body) : undefined}
          onEdit={edit ? () => setEditing(true) : undefined}
        />
      </header>
      {(editing || post.body.trim() || empty || post.minimized) && (
        <div className="inbox-detail-card-body">
          {editing && edit ? edit(() => setEditing(false)) : <PostBody post={post} empty={empty} />}
          <Reactions reactions={post.reactions} />
          {fix && (
            <button type="button" className="inbox-detail-btn inbox-detail-btn--small inbox-detail-btn--tinted inbox-detail-fix" data-tone="accent" onClick={fix}>
              <Wrench size={13} aria-hidden="true" />
              Fix in {fixTarget}
            </button>
          )}
          <Messages at={at} />
        </div>
      )}
      {children && <div className="inbox-detail-card-threads">{children}</div>}
    </article>
  );
}

/** Today's title and description form, now in place of the description it edits. */
function DescriptionEditor({ onClose }: { onClose: () => void }) {
  const { details, busy, perform } = useWorkItemDetail();
  const [title, setTitle] = useState(details.title);
  const [body, setBody] = useState(details.body);
  const save = async () => {
    if (!busy && title.trim() && (await perform({ kind: 'edit', title, body }, 'Changes saved.', 'description'))) onClose();
  };
  return (
    <form
      className="inbox-detail-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          onClose();
        }
        if (isSubmitChord(event)) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <label className="inbox-detail-field">
        <span>Title</span>
        <input className="inbox-detail-title-input" value={title} maxLength={256} disabled={busy} autoFocus onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className="inbox-detail-field">
        <span>Description</span>
        <MarkdownEditor value={body} onChange={setBody} label="Description" placeholder="Markdown supported" rows={10} disabled={busy} />
      </div>
      <div className="inbox-detail-form-foot">
        <span className="inbox-detail-kbd-hint" aria-hidden="true"><kbd>{MOD_KEY}</kbd><kbd>↵</kbd> save · <kbd>Esc</kbd> cancel</span>
        <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={onClose}>Cancel edit</button>
        <button className="inbox-detail-btn inbox-detail-btn--solid inbox-detail-btn--accent" disabled={busy || !title.trim()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function ReferenceLink({ source }: { source: WorkItemReference }) {
  const { ref, openWorkItem } = useWorkItemDetail();
  const elsewhere = source.repo.toLowerCase() !== ref.repo.toLowerCase();
  return (
    <a
      className="inbox-detail-ref"
      href={source.url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        // In the Inbox when it is there; otherwise the link opens it on GitHub.
        if (openWorkItem?.({ provider: ref.provider, repo: source.repo, type: source.type, number: source.number })) event.preventDefault();
      }}
    >
      <strong>{source.title}</strong> <span className="inbox-detail-ref-number">{elsewhere ? source.repo : ''}#{source.number}</span>
    </a>
  );
}

function Sentence({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((segment, index) => {
        const space = index > 0 ? ' ' : '';
        if ('text' in segment) return <span key={index}>{space}{segment.text}</span>;
        if ('strong' in segment) return <span key={index}>{space}<strong>{segment.strong}</strong></span>;
        if ('code' in segment) return <span key={index}>{space}<code className="inbox-detail-code">{segment.code}</code></span>;
        if ('del' in segment) return <span key={index}>{space}<del>{segment.del}</del></span>;
        if ('label' in segment) return <span key={index}>{space}<ItemLabel label={segment.label} /></span>;
        return <span key={index}>{space}<ReferenceLink source={segment.ref} /></span>;
      })}
    </>
  );
}

function EventLine({ icon, tone, actor, createdAt, children }: Pick<StreamEvent, 'icon' | 'tone' | 'actor' | 'createdAt'> & { children: ReactNode }) {
  const Icon = EVENT_ICONS[icon];
  return (
    <div className="inbox-detail-event-line">
      <span className="inbox-detail-disc" data-tone={tone}>
        <Icon size={14} aria-hidden="true" />
      </span>
      <p className="inbox-detail-event-text">
        <Avatar person={actor} size={16} />
        <strong className="inbox-detail-event-actor">{actor.login}</strong> {children} <RelativeTime iso={createdAt} />
      </p>
    </div>
  );
}

function CommitRun({ commits }: { commits: WorkItemCommitItem[] }) {
  const { actor, text } = commitRunSentence(commits);
  return (
    <>
      <EventLine icon="commit" actor={actor} createdAt={commits[0].createdAt}>{text}</EventLine>
      <ol className="inbox-detail-commits" aria-label="Commits">
        {commits.map((commit) => {
          const outcome = commit.checkState ? checkOutcome(commit.checkState) : null;
          return (
            <li key={commit.id} className="inbox-detail-commit">
              <Avatar person={commit.author} size={16} />
              <a className="inbox-detail-commit-title" href={commit.url} target="_blank" rel="noreferrer" title={commit.headline}>{commit.headline}</a>
              {outcome && (
                <span className="inbox-detail-commit-checks" title={`Checks: ${checkLabel(commit.checkState!).toLowerCase()}`}>
                  <CheckIcon outcome={outcome} size={13} />
                  <span className="sr-only">Checks {checkLabel(commit.checkState!).toLowerCase()}</span>
                </span>
              )}
              <a className="inbox-detail-sha" href={commit.url} target="_blank" rel="noreferrer">{commit.oid.slice(0, 7)}</a>
            </li>
          );
        })}
      </ol>
    </>
  );
}

const StreamItem = memo(function StreamItem({ entry }: { entry: StreamEntry }) {
  const { item, isPr, open, perform, handOff } = useWorkItemDetail();
  switch (entry.kind) {
    case 'event':
      return (
        <li className="inbox-detail-stream-event">
          <EventLine {...entry}><Sentence segments={entry.sentence} /></EventLine>
        </li>
      );
    case 'commits':
      return (
        <li className="inbox-detail-stream-event">
          <CommitRun commits={entry.commits} />
        </li>
      );
    case 'comment': {
      const at = `post:${entry.item.id}`;
      return (
        <li className="inbox-detail-stream-card">
          <PostCard
            post={entry.item}
            verb="commented"
            at={at}
            edit={entry.item.viewerCanEdit ? (close) => (
              <BodyEditor
                initial={entry.item.body}
                label="Edit comment"
                onSave={(body) => perform({ kind: 'edit-comment', target: 'comment', id: entry.item.id, body }, 'Comment updated.', at)}
                onClose={close}
              />
            ) : undefined}
          />
        </li>
      );
    }
    case 'review': {
      const at = `post:${entry.item.id}`;
      const { verb, tone } = reviewVerb(entry.item.state);
      const synthetic = entry.item.id.startsWith('thread:');
      // Today's rule: a request for changes is something a session can fix.
      const fix = isPr && open && entry.item.state === 'CHANGES_REQUESTED' && entry.item.body.trim()
        ? () => handOff(`Address this review feedback on ${item.url}:\n${entry.item.url}\n\n${entry.item.body}\n\nInspect the current code, implement the fix, and validate it.`, at)
        : undefined;
      return (
        <li className="inbox-detail-stream-card">
          <PostCard
            post={entry.item}
            verb={synthetic ? 'commented' : verb}
            verdict={tone === 'success' || tone === 'error' ? { tone } : undefined}
            at={at}
            fix={fix}
            edit={entry.item.viewerCanEdit && !synthetic ? (close) => (
              <BodyEditor
                initial={entry.item.body}
                label="Edit review"
                onSave={(body) => perform({ kind: 'edit-comment', target: 'review', id: entry.item.id, body }, 'Review updated.', at)}
                onClose={close}
              />
            ) : undefined}
          >
            {entry.threads.length > 0 && entry.threads.map((thread) => <ReviewThread key={thread.id} thread={thread} placement="stream" />)}
          </PostCard>
        </li>
      );
    }
  }
});

/**
 * The item read top to bottom, as on github.com: who reviews and how it is
 * labelled, the description, everything that happened since (comments,
 * reviews with their threads, commits, events), then — while it is open —
 * what stands between it and a merge, and a box to say something.
 */
export function ConversationStream({ composerRef, onAddReview }: { composerRef: Ref<MarkdownEditorHandle>; onAddReview: () => void }) {
  const { details, isPr, open, ref } = useWorkItemDetail();
  const entries = useMemo(() => buildStream(details.timeline, details.threads, ref.type), [details.timeline, details.threads, ref.type]);
  return (
    <>
      <ChipRow />
      <ol className="inbox-detail-stream">
        <li className="inbox-detail-stream-card">
          <PostCard
            post={details.description}
            verb="opened this"
            at="description"
            empty={<p className="inbox-detail-empty">No description provided.</p>}
            edit={details.description.viewerCanEdit ? (close) => <DescriptionEditor onClose={close} /> : undefined}
          />
        </li>
        {entries.map((entry) => (
          <StreamItem key={entry.kind === 'commits' || entry.kind === 'event' ? entry.id : entry.item.id} entry={entry} />
        ))}
      </ol>
      {isPr && open && <MergeCard onAddReview={onAddReview} />}
      <CommentBox ref={composerRef} />
    </>
  );
}
