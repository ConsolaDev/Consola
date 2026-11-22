import {
  Building2,
  ExternalLink,
  ListTodo,
  type LucideIcon,
  MessagesSquare,
  Plug,
  Ticket,
  User,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONNECTIONS_UNAVAILABLE,
  DISCONNECT_QUESTION,
  GITHUB_ASK_HINT,
  GITHUB_CONNECT_HINT,
  GITHUB_NOT_CONFIGURED,
  INSTALLATION_GONE,
  messageForConnectFailure,
  messageForDisconnectFailure,
  messageForGitHubResult,
  REPOSITORIES_UNAVAILABLE,
} from '../domain/connectionMessages';
import {
  accountKind,
  type Connections,
  type ConnectionsState,
  type GitHubAccount,
  type GitHubConnection,
  type GitHubRepository,
  isSuccess,
  LATER_SERVICES,
  repositoryLabel,
  shownRepositories,
} from '../domain/connections';
import { disconnectGitHub, loadConnections, startGitHubConnect } from '../services/api';
import { goToGitHub, takeGitHubResult } from '../services/gitHubRedirect';
import './ConnectionsPage.css';
import type { SectionProps } from './sections';

const connectedOn = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** A plain icon for each service that comes later: no vendor's mark. */
const LATER_ICONS: Record<string, LucideIcon> = {
  slack: MessagesSquare,
  linear: ListTodo,
  jira: Ticket,
};

/**
 * Settings' Connections page (`#/settings/connections`), laid out as the desktop app's settings
 * pages: a title, then one option per service, each a label and a description over what it
 * holds. Every member sees what is connected; only owners and admins see Connect and Disconnect,
 * as the server says (`canManage`), and the server refuses anyone else whatever the page shows.
 * How the last Connect ended (`?github=`) is read once, as the page mounts.
 */
export function ConnectionsPage({ workspace }: SectionProps) {
  const [result] = useState(() => takeGitHubResult());
  const [state, setState] = useState<ConnectionsState | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const asked = ++latest.current;
    const answer = await loadConnections();
    if (asked === latest.current) setState(answer);
  }, []);

  // The server answers for the session's active workspace. Settings mounts its page afresh for
  // each workspace, so one load per mount follows a switch.
  useEffect(() => {
    void load();
    return () => {
      latest.current++;
    };
  }, [load]);

  return (
    <div className="settings-section">
      <div className="settings-option-info">
        <h2 className="settings-section-title">Connections</h2>
        <p className="settings-option-description">
          The services {workspace.name} works with. Automations and factories reach them through
          these connections.
        </p>
      </div>

      {result !== null && (
        <p
          className={isSuccess(result) ? 'connections-notice done' : 'connections-notice problem'}
          role="status"
        >
          {messageForGitHubResult(result)}
        </p>
      )}

      {state === null ? (
        <p className="settings-option-description" aria-busy="true">
          Loading…
        </p>
      ) : state.kind === 'loaded' ? (
        <GitHubOption connections={state.connections} onChanged={load} />
      ) : (
        <div className="settings-option">
          <p className="connections-error">{CONNECTIONS_UNAVAILABLE}</p>
          <button type="button" className="settings-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      <div className="settings-option">
        <div className="settings-option-info">
          <span className="settings-option-label">Coming later</span>
          <span className="settings-option-description">
            These can’t be connected yet. Each will connect here, the way GitHub does.
          </span>
        </div>
        <ul className="connections-rows">
          {LATER_SERVICES.map((service) => {
            const Icon = LATER_ICONS[service.id] ?? Plug;
            return (
              <li key={service.id} className="connections-row">
                <Icon className="connections-row-icon" size={16} aria-hidden="true" />
                <span className="connections-row-name">{service.name}</span>
                <span className="connections-row-meta">{service.purpose}</span>
                <span className="settings-chip">Not connected</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** GitHub: its installations, with Connect for those who may. */
function GitHubOption({
  connections,
  onChanged,
}: {
  connections: Connections;
  onChanged: () => Promise<void>;
}) {
  const { canManage, github } = connections;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const connected = github.installations.length > 0;

  async function connect() {
    setPending(true);
    setFailure(null);
    const answer = await startGitHubConnect();
    if (answer.kind === 'started') {
      // The page is left for GitHub, which sends the person back here.
      goToGitHub(answer.url);
      return;
    }
    if (answer.kind === 'signed-out') await onChanged();
    else setFailure(messageForConnectFailure(answer));
    setPending(false);
  }

  const description = !github.configured
    ? GITHUB_NOT_CONFIGURED
    : connected
      ? 'Pull requests, pushes and repository files, for automations and factories kept in a repository.'
      : canManage
        ? GITHUB_CONNECT_HINT
        : GITHUB_ASK_HINT;

  return (
    <div className="settings-option">
      <div className="settings-option-info">
        <span className="settings-option-label">
          GitHub
          <span className={connected ? 'settings-chip on' : 'settings-chip'}>
            {connected ? 'Connected' : github.configured ? 'Not connected' : 'Not set up'}
          </span>
        </span>
        <span className="settings-option-description">{description}</span>
      </div>

      {connected && (
        <div className="connections-installations">
          {github.installations.map((installation) => (
            <Installation
              key={installation.id}
              installation={installation}
              canManage={canManage}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {github.configured && canManage && (
        <button
          type="button"
          className={connected ? 'settings-button' : 'settings-button accent'}
          disabled={pending}
          onClick={() => void connect()}
        >
          <Plug size={14} aria-hidden="true" />
          {connected ? 'Connect another account' : 'Connect GitHub'}
        </button>
      )}
      {failure && (
        <p className="connections-error" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

/** One installation the workspace holds: its account, its repositories, and Disconnect. */
function Installation({
  installation,
  canManage,
  onChanged,
}: {
  installation: GitHubConnection;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const { account, repositories } = installation;
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const AccountIcon = account.type === 'Organization' ? Building2 : User;

  useEffect(() => {
    if (asking) keep.current?.focus();
  }, [asking]);

  async function disconnect() {
    setPending(true);
    setFailure(null);
    const answer = await disconnectGitHub(installation.id);
    if (answer.kind === 'not-allowed' || answer.kind === 'unavailable') {
      setFailure(messageForDisconnectFailure(answer));
      setPending(false);
      return;
    }
    // Disconnected, already gone, or signed out: what the page shows has changed either way.
    await onChanged();
  }

  return (
    <article className="connections-installation" aria-label={`${account.login} on GitHub`}>
      <div className="connections-installation-head">
        <AccountIcon className="connections-row-icon" size={16} aria-hidden="true" />
        <span className="connections-row-name">{account.login}</span>
        <span className="connections-row-meta">
          {accountKind(account)} · connected{' '}
          {connectedOn.format(new Date(installation.connectedAt))}
        </span>
        <a
          className="connections-link"
          href={installation.settingsUrl}
          target="_blank"
          rel="noreferrer"
        >
          Choose repositories
          <ExternalLink size={12} aria-hidden="true" />
        </a>
        {canManage && !asking && (
          <button
            type="button"
            className="connections-link danger"
            aria-label={`Disconnect ${account.login}`}
            onClick={() => setAsking(true)}
          >
            Disconnect
          </button>
        )}
      </div>

      {repositories.kind === 'listed' ? (
        <Repositories repositories={repositories.repositories} account={account} />
      ) : repositories.kind === 'gone' ? (
        <p className="connections-error">{INSTALLATION_GONE}</p>
      ) : (
        <p className="settings-option-description">{REPOSITORIES_UNAVAILABLE}</p>
      )}

      {asking && (
        <div className="connections-confirm">
          <p className="settings-option-description">{DISCONNECT_QUESTION}</p>
          <div className="connections-confirm-actions">
            <button
              ref={keep}
              type="button"
              className="settings-button"
              disabled={pending}
              onClick={() => setAsking(false)}
            >
              Keep
            </button>
            <button
              type="button"
              className="settings-button danger"
              disabled={pending}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
      {failure && (
        <p className="connections-error" role="alert">
          {failure}
        </p>
      )}
    </article>
  );
}

/**
 * The repositories an installation covers, the first few by name, then how many more. A
 * company's repositories are mostly private, so the public ones are the ones marked.
 */
function Repositories({
  repositories,
  account,
}: {
  repositories: GitHubRepository[];
  account: GitHubAccount;
}) {
  if (repositories.length === 0) {
    return (
      <p className="settings-option-description">No repositories yet. Choose them on GitHub.</p>
    );
  }
  const { shown, more } = shownRepositories(repositories);
  return (
    <ul className="connections-repositories" aria-label="Repositories">
      {shown.map((repository) => (
        <li key={repository.id}>
          <a href={repository.url} target="_blank" rel="noreferrer" title={repository.fullName}>
            {repositoryLabel(repository, account)}
          </a>
          {!repository.private && <span className="settings-chip">Public</span>}
        </li>
      ))}
      {more > 0 && <li className="connections-more">and {more} more</li>}
    </ul>
  );
}
