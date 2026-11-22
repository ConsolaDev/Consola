import { branchSectionShown } from '../../infoPanel/branchLines';
import { pullRequestSectionView } from '../../infoPanel/sessionPullRequest';
import type { TabFacts } from '../../sidePanel/tabKinds';
import { BranchSection } from './BranchSection';
import { EnvironmentSection } from './EnvironmentSection';
import { PullRequestSection } from './PullRequestSection';
import './styles.css';

/**
 * The info panel: a glance at the session beside its conversation, in
 * sections that fold, drawn in `INFO_SECTION_IDS` order. It never navigates
 * (a row with more behind it opens a tab of the side panel) and never takes
 * the keyboard by itself, on mount or otherwise.
 */
export function InfoPanel({ facts }: { facts: TabFacts }) {
  const { checkout, session, workspace } = facts;
  const pullRequest = pullRequestSectionView({
    session,
    hasAccount: Boolean(workspace.provider),
    // A branch a pull request could be found from: checked out, and not removed.
    hasBranch:
      !!checkout && checkout.kind !== 'none' && !!checkout.branch && !session.removedWorktree,
  });
  return (
    <aside aria-label="Session info" className="info-panel">
      <EnvironmentSection facts={facts} />
      {branchSectionShown(facts) && <BranchSection facts={facts} />}
      {pullRequest.kind !== 'hidden' && <PullRequestSection facts={facts} view={pullRequest} />}
    </aside>
  );
}
