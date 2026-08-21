import { ExternalLink } from 'lucide-react';
import { sameWorkItem, workItemUrl } from '../../../shared/github';
import type { Session } from '../../../shared/workspace';
import { useInboxStore } from '../../stores/inboxStore';
import { dotClassFor, metaLineFor } from '../Inbox/inboxPresentation';
import '../Inbox/styles.css';
import './styles.css';

interface WorkItemStripProps {
  workspaceId: string;
  session: Session;
}

/**
 * The thin strip above a work-item session's terminal (mockup scene 3): live
 * PR/issue facts and where the session physically runs. It reads the same
 * cache as the Inbox — one fetcher, one rate-limit budget — and is read-only:
 * every GitHub write happens through the agent in the terminal below it.
 *
 * A merged/closed item drops out of the inbox; the strip then falls back to
 * the immutable workItem on the session record, because the session and its
 * transcript outlive the work item.
 */
export function WorkItemStrip({ workspaceId, session }: WorkItemStripProps) {
  const workItem = session.workItem;
  const item = useInboxStore((state) =>
    workItem
      ? state.snapshots[workspaceId]?.items.find((candidate) =>
          sameWorkItem(candidate.workItem, workItem)
        )
      : undefined
  );

  if (!workItem) return null;
  const label = workItem.type === 'pr' ? 'PR' : 'Issue';

  return (
    <div className="work-item-strip">
      <span className={`inbox-dot ${item ? dotClassFor(item) : 'inbox-dot--idle'}`} />
      <div className="work-item-strip-text">
        <span className="work-item-strip-title">
          #{workItem.number} {item?.title ?? `${label} in ${workItem.repo}`}
        </span>
        <span className="work-item-strip-meta">
          {item ? metaLineFor(item) : `${workItem.repo} · no longer in the inbox`}
        </span>
      </div>
      {session.cwd && (
        <span className="work-item-strip-pill">
          worktree · {workItem.type}-{workItem.number}
        </span>
      )}
      <a
        className="work-item-strip-link"
        href={item?.url ?? workItemUrl(workItem)}
        target="_blank"
        rel="noreferrer"
      >
        Open on GitHub <ExternalLink size={12} />
      </a>
    </div>
  );
}
