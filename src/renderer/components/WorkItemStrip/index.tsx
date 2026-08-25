import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { PROVIDER_META } from '../../../shared/providers';
import { sessionLabel } from '../../../shared/sessionLabel';
import { sameWorkItem, workItemUrl } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import { useInboxStore } from '../../stores/inboxStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { activateSession } from '../../utils/sessionActions';
import { sessionStatusFor } from '../../utils/sessionStatus';
import { dotClassFor, metaLineFor } from '../Inbox/inboxPresentation';
import '../Inbox/styles.css';
import './styles.css';

interface WorkItemStripProps {
  workspaceId: string;
  session: Session;
}

/**
 * The thin strip above a work-item session's terminal: live PR/issue facts,
 * the action this session was started as, its siblings on the same item,
 * and where it physically runs. It reads the same cache as the Inbox — one
 * fetcher, one rate-limit budget — and is read-only: every provider write
 * happens through the agent in the terminal below it.
 *
 * A merged/closed item drops out of the inbox; the strip then falls back to
 * the workItem on the session record, because the session and its
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
  // The whole workspace is selected (a stable reference) and the siblings
  // derived below: a selector returning a fresh array would re-render forever.
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  );
  const terminals = useTerminalStore((state) => state.terminals);

  if (!workItem) return null;
  const label = workItem.type === 'pr' ? 'PR' : 'Issue';
  const noun = workItem.type === 'pr' ? 'PR' : 'issue';
  const providerName = PROVIDER_META[workItem.provider].displayName;
  const siblings = (workspace?.sessions ?? []).filter(
    (candidate) => candidate.id !== session.id && sameWorkItem(candidate.workItem, workItem)
  );
  const total = siblings.length + 1;

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
      {session.workItemAction && (
        <span className="work-item-strip-pill work-item-strip-action">{session.workItemAction}</span>
      )}
      {siblings.length > 0 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="work-item-strip-pill work-item-strip-siblings"
              aria-label={`${total} sessions on this ${noun}`}
            >
              {total} sessions on this {noun} <ChevronDown size={11} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
              {siblings.map((sibling) => {
                const status = sessionStatusFor(terminals[sibling.instanceId]);
                return (
                  <DropdownMenu.Item
                    key={sibling.id}
                    className="dropdown-item"
                    onSelect={() => activateSession(workspaceId, sibling.id)}
                  >
                    <span className={`status-dot status-dot--${status}`} aria-hidden="true" />
                    <span>{sessionLabel(sibling)}</span>
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
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
        Open on {providerName} <ExternalLink size={12} />
      </a>
    </div>
  );
}
