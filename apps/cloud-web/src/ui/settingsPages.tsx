import { ConnectionsPage } from './ConnectionsPage';
import type { Section } from './sections';

/**
 * The Settings section's pages, in the order its tabs show them, and the one list of them: a new
 * settings page (the workspace's general details, its members, billing) is one entry here. Each
 * is shaped like a dashboard section and is shown with the same props. The first is the one
 * `#/settings` opens.
 *
 * An id never changes once a link may hold it: cloud-global sends a person back to
 * `#/settings/connections` after a GitHub Connect.
 */
export const SETTINGS_PAGES: readonly [Section, ...Section[]] = [
  { id: 'connections', label: 'Connections', View: ConnectionsPage },
];
