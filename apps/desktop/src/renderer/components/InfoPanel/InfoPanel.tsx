import { branchSectionShown } from '../../infoPanel/branchLines';
import type { TabFacts } from '../../sidePanel/tabKinds';
import { BranchSection } from './BranchSection';
import { EnvironmentSection } from './EnvironmentSection';
import './styles.css';

/**
 * The info panel: a glance at the session beside its conversation, in
 * sections that fold, drawn in `INFO_SECTION_IDS` order. It never navigates
 * (a row with more behind it opens a tab of the side panel) and never takes
 * the keyboard by itself, on mount or otherwise.
 */
export function InfoPanel({ facts }: { facts: TabFacts }) {
  return (
    <aside aria-label="Session info" className="info-panel">
      <EnvironmentSection facts={facts} />
      {branchSectionShown(facts) && <BranchSection facts={facts} />}
    </aside>
  );
}
