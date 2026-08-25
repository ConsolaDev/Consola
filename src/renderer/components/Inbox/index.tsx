import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, Settings } from 'lucide-react';
import { PROVIDER_META } from '../../../shared/providers';
import { sameWorkItem, workItemKey } from '../../../shared/workItems';
import { useInboxStore } from '../../stores/inboxStore';
import type { Workspace } from '../../stores/workspaceStore';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import { CloneDialog } from './CloneDialog';
import { InboxItemPane } from './InboxItemPane';
import { dotClassFor, formatAge, metaLineFor } from './inboxPresentation';
import './styles.css';

interface InboxViewProps {
  workspace: Workspace;
}

/**
 * Morning triage. Remote-driven: items appear whether or not the repo is
 * cloned. Read-only against the provider — the only verbs here create, open
 * or link local sessions, and they live in the detail pane: a row is a
 * thing you select, not a button you press.
 */
export function InboxView({ workspace }: InboxViewProps) {
  const [tab, setTabState] = useState<'pr' | 'issue'>('pr');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const snapshot = useInboxStore((state) => state.snapshots[workspace.id]);
  const resolved = useInboxStore((state) => state.resolvedRepos[workspace.id]);
  const refresh = useInboxStore((state) => state.refresh);
  const { openWorkspaceSettings } = useWorkspaceSettings();

  useEffect(() => {
    void useInboxStore.getState().load(workspace.id);
    // A different workspace's snapshot has its own keys; carrying a
    // selection across would risk landing on an unrelated item that
    // happens to share a repo/number with one in the workspace just left.
    setSelectedKey(null);
  }, [workspace.id]);

  // Esc closes the pane. Each dialog that can sit above the Inbox opts
  // into owning its own Esc — CloneDialog and LinkSessionDialog both wire
  // onEscapeKeyDown to stopPropagation() — so this window listener relies
  // on that contract and only ever sees the key when no dialog is open.
  useEffect(() => {
    if (!selectedKey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedKey(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedKey]);

  const items = snapshot?.items ?? [];
  const prs = items.filter((item) => item.workItem.type === 'pr');
  const issues = items.filter((item) => item.workItem.type === 'issue');
  const shown = tab === 'pr' ? prs : issues;
  const selectedItem = selectedKey
    ? shown.find((item) => workItemKey(item.workItem) === selectedKey)
    : undefined;

  // A refresh can drop the selected item from the snapshot entirely (PR
  // merged, issue closed) without ever clearing selectedKey. Once that
  // key no longer resolves to anything shown, drop it — otherwise a later
  // refresh that resurrects a same-numbered item would reopen the pane on
  // a selection the user never made.
  useEffect(() => {
    if (selectedKey && !selectedItem) setSelectedKey(null);
  }, [selectedItem, selectedKey]);

  const provider = workspace.provider;
  if (!provider) return null;
  const providerName = PROVIDER_META[provider.id].displayName;

  const setTab = (next: 'pr' | 'issue') => {
    setTabState(next);
    setSelectedKey(null);
  };

  const toggle = (key: string) => setSelectedKey((current) => (current === key ? null : key));

  return (
    <div className="inbox-view">
      <div className="inbox-header">
        <h1 className="inbox-title">Inbox</h1>
        <div className="inbox-tabs">
          <button
            className={`inbox-tab ${tab === 'pr' ? 'active' : ''}`}
            onClick={() => setTab('pr')}
          >
            PRs · {prs.length}
          </button>
          <button
            className={`inbox-tab ${tab === 'issue' ? 'active' : ''}`}
            onClick={() => setTab('issue')}
          >
            Issues · {issues.length}
          </button>
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
          <button
            className="inbox-refresh"
            aria-label="Refresh inbox"
            onClick={() => void refresh(workspace.id)}
          >
            <RefreshCw size={13} />
          </button>
          {/* Same quiet chrome as refresh; Phase C's Actions editor is what
              this door is for, so it sits where the Inbox is triaged. */}
          <button
            className="inbox-refresh inbox-settings-button"
            aria-label="Workspace settings"
            title="Workspace settings"
            onClick={() => openWorkspaceSettings(workspace.id)}
          >
            <Settings size={13} />
          </button>
        </div>
      </div>

      <div className="inbox-body">
        <div className="inbox-main">
          <div className="inbox-list">
            {shown.length === 0 && (
              <p className="inbox-empty">
                {snapshot ? 'Nothing here right now.' : `Fetching from ${providerName}...`}
              </p>
            )}
            {shown.map((item) => {
              const key = workItemKey(item.workItem);
              const sessionCount = workspace.sessions.filter((session) =>
                sameWorkItem(session.workItem, item.workItem)
              ).length;
              const isSelected = key === selectedKey;
              // null means main asked every scope and none has this repo
              // cloned; undefined (not yet resolved) optimistically reads as
              // cloned, same as the pane. The row stays selectable either
              // way — greyed is a hint, not a block on the clone affordance.
              const isUncloned = resolved?.[item.workItem.repo] === null;
              const title = `#${item.workItem.number} ${item.title}`;
              const meta = metaLineFor(item);
              return (
                // A div with role="button": the row selects, and it may one
                // day host controls of its own — a <button> could not.
                <div
                  className={`inbox-item ${isSelected ? 'selected' : ''} ${
                    isUncloned ? 'uncloned' : ''
                  }`}
                  key={key}
                  data-work-item-key={key}
                  role="button"
                  tabIndex={0}
                  // Without an explicit name, role="button" falls back to
                  // name-from-content and would absorb the nested link's own
                  // "Open on {provider}" label into the row's accessible name.
                  aria-label={`${title} — ${meta}`}
                  aria-pressed={isSelected}
                  onClick={() => toggle(key)}
                  onKeyDown={(event) => {
                    // The nested link is its own tab stop; its Enter bubbles
                    // here too. Only react when the row itself is the target,
                    // so the link's native Enter-to-navigate still fires.
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggle(key);
                    }
                  }}
                >
                  <span className={`inbox-dot ${dotClassFor(item)}`} />
                  <div className="inbox-item-text">
                    <span className="inbox-item-title">{title}</span>
                    <span className="inbox-item-meta">
                      {meta}
                      {sessionCount > 0 && (
                        <span className="inbox-item-sessions">
                          {' · '}
                          {sessionCount} session{sessionCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                  </div>
                  <a
                    className="inbox-item-link"
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={'Open on ' + providerName}
                    // The link is its own affordance, nested in a selectable
                    // row: without this, opening it would also flip the pane.
                    onClick={(event) => event.stopPropagation()}
                  >
                    <ExternalLink size={13} />
                  </a>
                </div>
              );
            })}
          </div>
        </div>
        {selectedItem && (
          // Keyed by item so the pane's confirm and custom-prompt state never
          // carries over when selection moves to a different item.
          <InboxItemPane
            key={workItemKey(selectedItem.workItem)}
            workspace={workspace}
            item={selectedItem}
            onClose={() => setSelectedKey(null)}
          />
        )}
      </div>
      <CloneDialog />
    </div>
  );
}
