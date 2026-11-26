import { LayoutGrid, MessagesSquare, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Me } from '../domain/me';
import { SESSIONS_SECTION_ID } from '../domain/sessionsRoute';
import type { MyWorkspace } from '../domain/workspace';
import { OverviewPage } from './OverviewPage';
import { RunsSection } from './RunsSection';
import { SessionsSection } from './SessionsSection';

/**
 * What every section is shown with: the person, the workspace open (never null), and what to
 * call once a page has changed the workspace, which loads the page's state again so everything
 * showing it (the sidebar, the menu) catches up.
 */
export type SectionProps = {
  me: Me;
  workspace: MyWorkspace;
  onWorkspaceChanged: () => Promise<void>;
};

/**
 * One page of the dashboard. `id` names it in the address (`#/<id>`), so it never changes once
 * a link may hold it; `label` and `icon` are how the sidebar shows it, the icon from the
 * desktop's set (`lucide-react`). A `wide` page has the whole of the space beside the sidebar,
 * edge to edge, and lays itself out; any other sits in the dashboard's reading column.
 */
export type Section = {
  id: string;
  label: string;
  icon: LucideIcon;
  View: (props: SectionProps) => ReactNode;
  layout?: 'wide';
};

/**
 * The dashboard's sections, in the nav's order, and the one list of them: a new page of the
 * workspace's own is one entry here. The first is the one an address naming no section opens.
 * The factories are no section: the sidebar lists them in a group of their own, each with its
 * pages (`FactoriesNav`, `#/factories/<id>/<page>`).
 *
 * Every member of the workspace sees every section. What a person may do on a page is the
 * page's to show or hide, by what the server answers. Settings is no section: it is a dialog
 * over the open one, with pages of its own (`settingsPages.tsx`), Teams and Connections among them.
 */
export const SECTIONS: readonly [Section, ...Section[]] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid, View: OverviewPage },
  { id: 'runs', label: 'Runs', icon: Zap, View: RunsSection, layout: 'wide' },
  {
    id: SESSIONS_SECTION_ID,
    label: 'Sessions',
    icon: MessagesSquare,
    View: SessionsSection,
    layout: 'wide',
  },
];
