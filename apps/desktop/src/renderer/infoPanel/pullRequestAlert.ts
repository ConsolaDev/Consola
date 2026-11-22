/**
 * Whether the session's pull request has something wrong the person should
 * hear about without looking: a failing check, or a request for changes.
 * Pure: the Pull request kind's mark (`TAB_MARKS`) says what this decides.
 *
 * It reads only what is already known, the item's cached details or the
 * Inbox's copy of the item, whichever was read last, so the mark never asks
 * for a read.
 */
import type { WorkItemDetails } from '../../shared/workItemDetails';
import type { InboxItem } from '../../shared/workItems';
import { isFailingCheck } from '../components/Inbox/workItemDetailPresentation';

export interface PullRequestAlert {
  failingChecks: boolean;
  changesRequested: boolean;
}

interface AlertSources {
  details?: Pick<WorkItemDetails, 'state' | 'checks' | 'reviewDecision'>;
  /** When the details were read: their entry's `fetchedAt`. */
  detailsAt: number;
  item?: Pick<InboxItem, 'state' | 'ciStatus' | 'reviewDecision'>;
  /** When the Inbox was read: its snapshot's `fetchedAt`. */
  itemAt: number;
}

/** The newer of the two sources decides; only an open pull request alerts; null when nothing is wrong or nothing is known. */
export function pullRequestAlert(input: AlertSources): PullRequestAlert | null {
  const read = newestRead(input);
  if (!read?.open || (!read.failingChecks && !read.changesRequested)) return null;
  return { failingChecks: read.failingChecks, changesRequested: read.changesRequested };
}

/** What the newer source says, each in its own words. The details are the closer read, so a tie goes to them. */
function newestRead({
  details,
  detailsAt,
  item,
  itemAt,
}: AlertSources): (PullRequestAlert & { open: boolean }) | null {
  if (details && (!item || detailsAt >= itemAt)) {
    return {
      open: details.state === 'open',
      failingChecks: details.checks.some((check) => isFailingCheck(check.state)),
      changesRequested: details.reviewDecision === 'CHANGES_REQUESTED',
    };
  }
  if (item) {
    return {
      open: item.state === 'open',
      failingChecks: item.ciStatus === 'failing',
      changesRequested: item.reviewDecision === 'changes-requested',
    };
  }
  return null;
}

/** Said after the kind's title, on its shortcut or its tab: "Pull request #51, a check is failing". */
export function alertWords(alert: PullRequestAlert): string {
  return said(alert, 'a check is failing', 'changes are requested');
}

/** Said after the side panel toggle's label: "Show side panel, where the pull request has a failing check". */
export function alertPanelWords(alert: PullRequestAlert): string {
  return `where the pull request has ${said(alert, 'a failing check', 'changes requested')}`;
}

function said(alert: PullRequestAlert, failing: string, changes: string): string {
  return [alert.failingChecks && failing, alert.changesRequested && changes]
    .filter(Boolean)
    .join(' and ');
}
