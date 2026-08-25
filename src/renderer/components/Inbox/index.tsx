import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { PROVIDER_META } from '../../../shared/providers';
import type { InboxItem } from '../../../shared/workItems';
import { sameWorkItem } from '../../../shared/workItems';
import { launchKey, useInboxStore } from '../../stores/inboxStore';
import type { Workspace } from '../../stores/workspaceStore';
import { CloneDialog } from './CloneDialog';
import {
  actionFor,
  dotClassFor,
  formatAge,
  metaLineFor,
  type InboxAction,
} from './inboxPresentation';
import './styles.css';

interface InboxViewProps {
  workspace: Workspace;
}

/**
 * Morning triage (mockup scene 1). Remote-driven: items appear whether or not
 * the repo is cloned. Read-only against GitHub — the only verbs here create or
 * open local sessions; every GitHub write happens through the agent.
 */
export function InboxView({ workspace }: InboxViewProps) {
  const [tab, setTab] = useState<'pr' | 'issue'>('pr');

  const snapshot = useInboxStore((state) => state.snapshots[workspace.id]);
  const resolved = useInboxStore((state) => state.resolvedRepos[workspace.id]);
  const launchErrors = useInboxStore((state) => state.launchErrors);
  const launching = useInboxStore((state) => state.launching);
  const launch = useInboxStore((state) => state.launch);
  const openClonePrompt = useInboxStore((state) => state.openClonePrompt);
  const refresh = useInboxStore((state) => state.refresh);

  useEffect(() => {
    void useInboxStore.getState().load(workspace.id);
  }, [workspace.id]);

  const items = snapshot?.items ?? [];
  const prs = items.filter((item) => item.workItem.type === 'pr');
  const issues = items.filter((item) => item.workItem.type === 'issue');
  const shown = tab === 'pr' ? prs : issues;

  const provider = workspace.provider;
  if (!provider) return null;
  const providerName = PROVIDER_META[provider.id].displayName;

  const handleAction = (item: InboxItem, action: InboxAction) => {
    if (action.kind === 'clone') {
      openClonePrompt(workspace.id, item);
    } else {
      void launch(workspace.id, item);
    }
  };

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
        </div>
      </div>

      <div className="inbox-list">
        {shown.length === 0 && (
          <p className="inbox-empty">
            {snapshot ? 'Nothing here right now.' : `Fetching from ${providerName}...`}
          </p>
        )}
        {shown.map((item) => {
          const hasSession = workspace.sessions.some((session) =>
            sameWorkItem(session.workItem, item.workItem)
          );
          const cloned = resolved?.[item.workItem.repo] !== null;
          const action = actionFor(item, hasSession, cloned);
          const key = launchKey(workspace.id, item);
          const error = launchErrors[key];
          return (
            <div className="inbox-item" key={key}>
              <span className={`inbox-dot ${dotClassFor(item)}`} />
              <div className="inbox-item-text">
                <span className="inbox-item-title">
                  #{item.workItem.number} {item.title}
                </span>
                <span className="inbox-item-meta">{metaLineFor(item)}</span>
                {error && <span className="inbox-item-error">{error}</span>}
              </div>
              <a
                className="inbox-item-link"
                href={item.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open on ${providerName}`}
              >
                <ExternalLink size={13} />
              </a>
              <button
                className={`inbox-item-action ${action.kind === 'clone' ? 'ghost' : ''}`}
                disabled={launching[key]}
                onClick={() => handleAction(item, action)}
              >
                {launching[key] ? 'Preparing...' : action.label}
              </button>
            </div>
          );
        })}
      </div>
      <CloneDialog />
    </div>
  );
}
