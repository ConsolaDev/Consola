import type { ReactNode } from 'react';
import type { Me } from '../domain/me';
import type { MyWorkspace } from '../domain/workspace';
import { ConnectionsPage } from './ConnectionsPage';
import { OverviewPage } from './OverviewPage';

/** What every section is shown with: the person, and the workspace open, never null. */
export type SectionProps = { me: Me; workspace: MyWorkspace };

/**
 * One page of the dashboard. `id` names it in the address (`#/<id>`), so it never changes once
 * a link may hold it; `label` is what the nav calls it.
 */
export type Section = {
  id: string;
  label: string;
  View: (props: SectionProps) => ReactNode;
};

/**
 * The dashboard's sections, in the nav's order, and the one list of them: a new page is one
 * entry here. The first is the one an address naming no section opens.
 *
 * Every member of the workspace sees every section. What a person may do on a page (manage
 * teams, connect GitHub) is the page's to show or hide, by what the server answers.
 */
export const SECTIONS: readonly [Section, ...Section[]] = [
  { id: 'overview', label: 'Overview', View: OverviewPage },
  // cloud-global's GitHub callback sends people back to `#/connections`: never rename it.
  { id: 'connections', label: 'Connections', View: ConnectionsPage },
];
