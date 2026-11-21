import { Diff, GitBranch, GitCompare } from 'lucide-react';
import { baseLine, branchLabel, pushValue, uncommittedValue } from '../../infoPanel/branchLines';
import type { TabFacts } from '../../sidePanel/tabKinds';
import { useBranchFacts } from '../../stores/branchFactsStore';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { DiffCounts } from '../Inbox/WorkItemDetailParts';
import { InfoRow } from './InfoRow';
import { InfoSection } from './InfoSection';

const ICON_SIZE = 14;

/**
 * The checkout's branch: what waits to be pushed, what is uncommitted, and
 * how far it has come from its base. Every count is what the clone already
 * holds; nothing is fetched. Drawn only for a checkout git knows, or a
 * removed worktree (`branchSectionShown`).
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
  return <CheckoutRows dir={facts.checkoutPath} label={label} />;
}

function CheckoutRows({ dir, label }: { dir: string; label: string }) {
  // Against origin's default branch (`origin/HEAD`).
  const facts = useBranchFacts(dir, undefined);
  const base = facts && baseLine(facts.base);
  return (
    <>
      <BranchRow label={label} push={facts && pushValue(facts.upstream)} />
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
function BranchRow({ label, push }: { label: string; push?: { text: string; title: string } }) {
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
 */
function UncommittedRow({ dir }: { dir: string }) {
  // While the status is another folder's (a session switch in flight), there is nothing to say yet.
  const stats = useGitStatusStore((state) => (state.rootPath === dir ? state.stats : undefined));
  const openKind = useSidePanelStore((state) => state.openKind);
  const value = stats && uncommittedValue(stats);
  const spoken =
    stats === undefined
      ? undefined
      : value
        ? `${value.files} +${value.additions} −${value.deletions}`
        : 'None';

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
      ariaLabel={spoken ? `Uncommitted, ${spoken}. Open Changes` : 'Uncommitted. Open Changes'}
      onActivate={() => openKind('changes')}
    />
  );
}
