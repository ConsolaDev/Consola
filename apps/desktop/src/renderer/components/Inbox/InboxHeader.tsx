// src/renderer/components/Inbox/InboxHeader.tsx
import { RefreshCw, Settings } from 'lucide-react';
import { PROVIDER_META } from '../../../shared/providers';
import type { InboxSnapshot } from '../../../shared/workItems';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import type { Workspace } from '../../stores/workspaceStore';
import { RepoFilterMenu, UpdatedFilterMenu } from './FilterMenus';
import type { InboxFilterState, InboxUpdatedFilter } from './inboxFilters';
import { formatAge } from './inboxPresentation';

interface InboxHeaderProps {
  workspace: Workspace;
  /** The binding, already known to exist -- the view renders nothing without one. */
  provider: NonNullable<Workspace['provider']>;
  snapshot: InboxSnapshot | undefined;
  /** Repos present in the snapshot, for the repo menu. */
  repos: string[];
  filter: InboxFilterState;
  onReposChange: (repos: string[]) => void;
  onUpdatedChange: (updated: InboxUpdatedFilter) => void;
  onRefresh: () => void;
}

/**
 * GitHub's inbox header, plus what Consola owns: whose account this is,
 * how old the data is (labelled, never a dialog, when the provider could
 * not be reached), a manual refresh, and the door to Workspace Settings
 * where the actions this inbox launches are edited.
 */
export function InboxHeader({
  workspace,
  provider,
  snapshot,
  repos,
  filter,
  onReposChange,
  onUpdatedChange,
  onRefresh,
}: InboxHeaderProps) {
  const { openWorkspaceSettings } = useWorkspaceSettings();
  const providerName = PROVIDER_META[provider.id].displayName;

  return (
    <header className="inbox-header">
      <h1 className="inbox-title">Inbox</h1>
      <div className="inbox-filters">
        <RepoFilterMenu repos={repos} selected={filter.repos} onChange={onReposChange} />
        <UpdatedFilterMenu value={filter.updated} onChange={onUpdatedChange} />
      </div>
      <div className="inbox-meta">
        <span className="inbox-meta-account">
          {provider.accountLogin}
          {provider.org ? ` · ${provider.org}` : ''}
        </span>
        {snapshot?.error ? (
          // Degrade, never dialog: name the failure, show the data's age.
          <span className="inbox-meta-error" title={snapshot.error}>
            {providerName} unreachable · showing data from {formatAge(snapshot.fetchedAt)}
          </span>
        ) : (
          <span className="inbox-meta-age">updated {formatAge(snapshot?.fetchedAt ?? 0)}</span>
        )}
        <button className="inbox-refresh" aria-label="Refresh inbox" onClick={onRefresh}>
          <RefreshCw size={13} />
        </button>
        <button
          className="inbox-refresh inbox-settings-button"
          aria-label="Workspace settings"
          title="Workspace settings"
          onClick={() => openWorkspaceSettings(workspace.id)}
        >
          <Settings size={13} />
        </button>
      </div>
    </header>
  );
}
