// src/renderer/components/Inbox/InboxRow.tsx
import { Check, CircleDot, GitPullRequest, GitPullRequestDraft, MessageSquare, X } from 'lucide-react';
import type { InboxItem } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import {
  checksLabel,
  hasAccentBar,
  relativeTime,
  reviewStateLabel,
  worstStatusForItem,
} from './inboxPresentation';

interface InboxRowProps {
  item: InboxItem;
  /** This workspace's sessions linked to this item. */
  sessions: Session[];
  terminals: Record<string, TerminalState>;
  cloned: boolean;
  selected: boolean;
  onSelect: (item: InboxItem) => void;
}

/**
 * One item, as lean as GitHub's own row (mockup inbox-layout option B):
 * type icon, title, `repo#n · author · age`, a one-dot hint of its sessions,
 * then review state, checks and comment count. No verbs -- selecting the
 * row opens the pane, and the pane is where sessions and actions live.
 */
export function InboxRow({ item, sessions, terminals, cloned, selected, onSelect }: InboxRowProps) {
  const key = workItemKey(item.workItem);
  const review = reviewStateLabel(item);
  const checks = checksLabel(item.checks);
  const repoName = item.workItem.repo.split('/').pop() ?? item.workItem.repo;
  const sessionStatus = sessions.length > 0 ? worstStatusForItem(sessions, terminals) : null;
  const meta = [`${repoName}#${item.workItem.number}`, item.author, relativeTime(item.updatedAt)]
    .filter(Boolean)
    .join(' · ');
  const checksBreakdown = item.checks
    ? `${item.checks.passed} passed, ${item.checks.failed} failed, ${item.checks.pending} pending`
    : '';

  const icon =
    item.workItem.type === 'issue' ? (
      <CircleDot size={14} className="inbox-row-icon inbox-row-icon--issue" aria-hidden="true" />
    ) : item.isDraft ? (
      <GitPullRequestDraft size={14} className="inbox-row-icon inbox-row-icon--draft" aria-hidden="true" />
    ) : (
      <GitPullRequest size={14} className="inbox-row-icon" aria-hidden="true" />
    );

  // A div with role="button" rather than a <button>: the row will host
  // interactive children later (the pane's affordances migrating into rows
  // is the obvious next step), and a button may not contain a button. This
  // row has none yet, so the key handler is a plain Enter/Space activation
  // with no need to guard against a nested control's own keydown bubbling.
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(item);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={[
        'inbox-row',
        selected ? 'selected' : '',
        hasAccentBar(item) ? 'inbox-row--accent' : '',
        cloned ? '' : 'inbox-row--uncloned',
      ]
        .filter(Boolean)
        .join(' ')}
      data-work-item-key={key}
      title={cloned ? undefined : 'No local clone of this repository in the workspace'}
      onClick={() => onSelect(item)}
      onKeyDown={handleKeyDown}
    >
      {icon}
      <div className="inbox-row-text">
        <span className="inbox-row-title">{item.title}</span>
        <span className="inbox-row-meta">
          <span className="inbox-row-meta-facts">{meta}</span>
          {sessionStatus && (
            <span className="inbox-row-sessions">
              <span className="inbox-row-meta-sep">·</span>
              <span className={`status-dot status-dot--${sessionStatus}`} aria-hidden="true" />
              {/* The dot's colour is the only visual cue for session status;
                  give it a text alternative since role="button" computes its
                  accessible name from visible content. */}
              <span className="sr-only">{sessionStatus}</span>
              {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
            </span>
          )}
        </span>
      </div>
      <div className="inbox-row-status">
        {review && (
          <span className={`inbox-row-review inbox-row-review--${item.reviewDecision}`}>{review}</span>
        )}
        {checks && (
          <span className={`inbox-row-checks inbox-row-checks--${checks.tone}`} title={checksBreakdown}>
            {checks.tone === 'bad' ? <X size={11} aria-hidden="true" /> : <Check size={11} aria-hidden="true" />}
            {checks.text}
            {/* checks.text is just "passed/total" -- the pass/fail/pending
                split otherwise lives only in the hover title, which most
                screen readers never expose. */}
            <span className="sr-only">{checksBreakdown}</span>
          </span>
        )}
        {item.commentCount > 0 && (
          <span className="inbox-row-comments" title={`${item.commentCount} comments`}>
            <MessageSquare size={11} aria-hidden="true" />
            {item.commentCount}
          </span>
        )}
      </div>
    </div>
  );
}
