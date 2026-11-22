import { type LucideIcon, Plug, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { ConnectionsPage } from './ConnectionsPage';
import type { SectionProps } from './sections';
import { TeamsPage } from './TeamsPage';

/** One page of Settings: its id in the address, its entry in the list, and what it shows. */
export type SettingsPage = {
  id: string;
  label: string;
  icon: LucideIcon;
  View: (props: SectionProps) => ReactNode;
};

/**
 * Settings' pages, in the order its list shows them, and the one list of them: a new settings
 * page (the workspace's details, its members, billing) is one entry here. Each is shown with
 * the dashboard's `SectionProps`. The first is the one `#/settings` opens.
 *
 * An id never changes once a link may hold it: cloud-global sends a person back to
 * `#/settings/connections` after a GitHub Connect. The icons are the desktop app's, from the
 * same set (`lucide-react`).
 */
export const SETTINGS_PAGES: readonly [SettingsPage, ...SettingsPage[]] = [
  { id: 'connections', label: 'Connections', icon: Plug, View: ConnectionsPage },
  { id: 'teams', label: 'Teams', icon: Users, View: TeamsPage },
];
