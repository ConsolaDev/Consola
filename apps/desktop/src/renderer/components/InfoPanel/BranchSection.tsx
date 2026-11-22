import { Diff, GitBranch, GitCompare } from 'lucide-react';
import { baseLine, branchLabel, pushValue, uncommittedValue } from '../../infoPanel/branchLines';
import { detailsTargetOf, sessionPullRequest } from '../../infoPanel/sessionPullRequest';
import type { TabFacts } from '../../sidePanel/tabKinds';
import { useBranchFacts } from '../../stores/branchFactsStore';
import { statsFor, useGitStatusStore } from '../../stores/gitStatusStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { type DetailsTarget, useDetailsEntry } from '../../stores/workItemDetailsStore';
import { DiffCounts } from '../Inbox/WorkItemDetailParts';
import { InfoRow } from './InfoRow';
import { InfoSection } from './InfoSection';

const ICON_SIZE = 14;

/**
 * The checkout's branch: what waits to be pushed, what is uncommitted, and
 * how far it has come from its base, the session's pull request's (linked,
 * else found from the branch) when its details are known. Every count is
 * what the clone already holds; nothing is
 * fetched. Drawn only for a checkout git knows, or a removed worktree
 * (`branchSectionShown`).
 */
export function BranchSection({ facts }: { facts: TabFacts }) {
  return (
    <InfoSection id="branch" title="Branch">
      <BranchRows facts={facts} />
    </InfoSection>
  );
}

function BranchRows({ facts }: { facts: TabFacts }) {
  const label = branchLabel(facts);
  if (label === null) return null;
  // A removed worktree has no folder until the session next starts: its
  // record names the branch, and nothing is asked of git.
  if (facts.session.removedWorktree) {
    return (
      <>
        <BranchRow label={label} />
        <InfoRow label="No checkout until the session next starts." tone="muted" />
      </>
    );
  }
  if (facts.checkoutPath === undefined) return null;
  return (
    <CheckoutRows
      dir={facts.checkoutPath}
      label={label}
      onBranch={facts.checkout?.kind !== 'none' && !!facts.checkout?.branch}
      pullRequest={detailsTargetOf(
        facts.workspace,
        sessionPullRequest(facts.session, facts.foundPullRequest)?.ref,
      )}
    />
  );
}

function CheckoutRows({
  dir,
  label,
  onBranch,
  pullRequest,
}: {
  dir: string;
  label: string;
  /** On a branch, not a detached HEAD, which has nothing to push. */
  onBranch: boolean;
  pullRequest: DetailsTarget | null;
}) {
  // Against the pull request's base once its details have been read, else
  // origin's default branch (`origin/HEAD`). The details are only looked up
  // here, never read for this: the Pull request section and the tab read them.
  const baseBranch = useDetailsEntry(pullRequest)?.details?.baseBranch;
  const facts = useBranchFacts(dir, baseBranch);
  const base = facts && baseLine(facts.base);
  return (
    <>
      <BranchRow label={label} push={facts && pushValue(facts.upstream, onBranch)} />
      <UncommittedRow dir={dir} />
      {base && (
        <InfoRow
          icon={<GitCompare size={ICON_SIZE} />}
          label={base.label}
          value={
            base.files === null ? (
              'No changes'
            ) : (
              <>
                {base.files}
                <DiffCounts additions={base.additions} deletions={base.deletions} />
              </>
            )
          }
          title={base.title}
        />
      )}
    </>
  );
}

/** The branch, or where a detached HEAD is, with the commits waiting to be pushed once read. */
function BranchRow({
  label,
  push,
}: {
  label: string;
  push?: { text: string; title: string } | null;
}) {
  return (
    <InfoRow
      icon={<GitBranch size={ICON_SIZE} />}
      label={<span className="info-branch">{label}</span>}
      value={push?.text}
      title={push?.title}
    />
  );
}

/**
 * What the working tree holds that is not committed, from the git status the
 * header keeps on this checkout. Opens Changes, where it can be reviewed.
 * Drawn only once git gave this checkout's counts, so it never says `None`
 * on git's behalf.
 */
function UncommittedRow({ dir }: { dir: string }) {
  // Undefined until a read of this checkout lands (during a session switch
  // the store already tracks `dir` but still holds the other checkout's
  // counts), and for a folder below its repository's top, whose status is
  // never read: no row, neither theirs nor a `None` nobody said.
  const stats = useGitStatusStore((state) => statsFor(state, dir));
  const openKind = useSidePanelStore((state) => state.openKind);
  if (stats === undefined) return null;
  const value = uncommittedValue(stats);
  const spoken = value ? `${value.files} +${value.additions} −${value.deletions}` : 'None';

  return (
    <InfoRow
      icon={<Diff size={ICON_SIZE} />}
      label="Uncommitted"
      value={
        value ? (
          <>
            {value.files}
            <DiffCounts additions={value.additions} deletions={value.deletions} />
          </>
        ) : (
          spoken
        )
      }
      ariaLabel={`Uncommitted, ${spoken}. Open Changes`}
      onActivate={() => openKind('changes')}
    />
  );
}
