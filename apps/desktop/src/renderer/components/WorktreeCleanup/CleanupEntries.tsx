import { FolderGit2, FolderMinus } from 'lucide-react';
import type { CleanupEntry, CleanupHistoryEntry } from '../../../shared/worktreeCleanup';
import { relativeSince } from '../../utils/relativeSince';
import { tildePath } from '../../utils/displayPath';

function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

function folderName(tree: string): string {
  return tree.split(/[\\/]/).filter(Boolean).pop() ?? tree;
}

/**
 * Worktrees a preview or a run looked at: those that go (or went), then the
 * rest, each with main's own sentence for why.
 */
export function CleanupEntries({
  entries,
  empty,
  goingLabel,
}: {
  entries: CleanupEntry[];
  empty: string;
  /** "Goes" in a preview, "Removed" in a report. */
  goingLabel: string;
}) {
  if (entries.length === 0) return <p className="worktree-cleanup-empty">{empty}</p>;
  return (
    <ul className="worktree-cleanup-list">
      {entries.map((entry) => {
        const going = entry.decision === 'remove';
        return (
          <li
            key={entry.tree}
            className={`worktree-cleanup-item ${going ? 'worktree-cleanup-item--going' : ''}`}
          >
            {going ? (
              <FolderMinus size={14} aria-hidden="true" />
            ) : (
              <FolderGit2 size={14} aria-hidden="true" />
            )}
            <span className="worktree-cleanup-item-text">
              <span className="worktree-cleanup-item-title" title={tildePath(entry.tree)}>
                {entry.sessions.map((session) => session.name).join(', ') || folderName(entry.tree)}
              </span>
              <span className="worktree-cleanup-item-reason">
                {going
                  ? `${goingLabel}: ${lowerFirst(entry.reason)}`
                  : `Stays: ${lowerFirst(entry.reason)}`}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** What cleanup removed and rebuilt, newest first. */
export function CleanupHistoryList({ entries }: { entries: CleanupHistoryEntry[] }) {
  if (entries.length === 0) {
    return <p className="worktree-cleanup-empty">Nothing has been removed or rebuilt yet.</p>;
  }
  return (
    <ul className="worktree-cleanup-list">
      {entries.map((entry) => (
        <li key={entry.id} className="worktree-cleanup-item">
          {entry.action === 'removed' ? (
            <FolderMinus size={14} aria-hidden="true" />
          ) : (
            <FolderGit2 size={14} aria-hidden="true" />
          )}
          <span className="worktree-cleanup-item-text">
            <span className="worktree-cleanup-item-title" title={tildePath(entry.tree)}>
              {entry.action === 'removed' ? 'Removed' : 'Rebuilt'}{' '}
              {entry.sessionNames.join(', ') || folderName(entry.tree)}
            </span>
            <span className="worktree-cleanup-item-reason">{entry.detail}</span>
          </span>
          <time className="worktree-cleanup-item-age" dateTime={new Date(entry.at).toISOString()}>
            {relativeSince(entry.at)}
          </time>
        </li>
      ))}
    </ul>
  );
}
