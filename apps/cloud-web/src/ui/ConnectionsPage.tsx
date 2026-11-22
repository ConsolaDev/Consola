import { useCallback, useEffect, useId, useRef, useState } from 'react';
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

/**
 * The Connections section: the services the active workspace is connected to. GitHub connects
 * by installing Consola's GitHub App, and the others are listed as coming later. Every member
 * sees what is connected; only owners and admins see Connect and Disconnect, as the server says
 * (`canManage`), and the server refuses anyone else whatever the page shows. How the last
 * Connect ended (`?github=`) is read once, as the page mounts.
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

  // The server answers for the session's active workspace. The dashboard mounts the section
  // afresh for each workspace, so one load per mount follows a switch.
  useEffect(() => {
    void load();
    return () => {
      latest.current++;
    };
  }, [load]);

  return (
    <>
      <header className="section-header">
        <h1 className="section-title">Connections</h1>
      </header>
      <p className="muted connections-lede">
        The services {workspace.name} works with. Automations and factories reach them through these
        connections.
      </p>

      {result !== null && (
        <p
          className={isSuccess(result) ? 'connections-notice done' : 'connections-notice problem'}
          role="status"
        >
          {messageForGitHubResult(result)}
        </p>
      )}

      {state === null ? (
        <section className="card connection" aria-busy="true">
          <p className="muted">Loading…</p>
        </section>
      ) : state.kind === 'loaded' ? (
        <GitHubCard connections={state.connections} onChanged={load} />
      ) : (
        <section className="card connection">
          <p className="error">{CONNECTIONS_UNAVAILABLE}</p>
          <div className="actions">
            <button type="button" className="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </section>
      )}

      <section className="connections-later" aria-labelledby="connections-later-heading">
        <h2 id="connections-later-heading" className="connections-subheading">
          Coming later
        </h2>
        <ul className="connections-later-list">
          {LATER_SERVICES.map((service) => (
            <li key={service.id} className="connection-row">
              <ServiceTile name={service.name} />
              <div className="connection-text">
                <span className="connection-name">{service.name}</span>
                <span className="muted">{service.purpose}</span>
              </div>
              <span className="connection-status">Not connected</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** A square holding a service's initial, the same for every service. */
function ServiceTile({ name }: { name: string }) {
  return (
    <span className="service-tile" aria-hidden="true">
      {name.slice(0, 1)}
    </span>
  );
}

/** GitHub: its installations, with Connect for those who may. */
function GitHubCard({
  connections,
  onChanged,
}: {
  connections: Connections;
  onChanged: () => Promise<void>;
}) {
  const headingId = useId();
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

  return (
    <section className="card connection" aria-labelledby={headingId}>
      <div className="connection-row">
        <ServiceTile name="GitHub" />
        <div className="connection-text">
          <h2 id={headingId} className="connection-name">
            GitHub
          </h2>
          <span className="muted">
            Pull requests, pushes and repository files, for automations and factories kept in a
            repository.
          </span>
        </div>
        <span className={connected ? 'connection-status on' : 'connection-status'}>
          {connected ? 'Connected' : github.configured ? 'Not connected' : 'Not set up'}
        </span>
      </div>

      {github.installations.map((installation) => (
        <Installation
          key={installation.id}
          installation={installation}
          canManage={canManage}
          onChanged={onChanged}
        />
      ))}

      {!github.configured ? (
        <p className="muted">{GITHUB_NOT_CONFIGURED}</p>
      ) : canManage ? (
        <>
          {!connected && <p className="muted">{GITHUB_CONNECT_HINT}</p>}
          <div className="actions">
            <button
              type="button"
              className={connected ? 'button' : 'button primary'}
              disabled={pending}
              onClick={() => void connect()}
            >
              {connected ? 'Connect another account' : 'Connect GitHub'}
            </button>
          </div>
        </>
      ) : (
        !connected && <p className="muted">{GITHUB_ASK_HINT}</p>
      )}
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
    </section>
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
    <article className="installation" aria-label={`${account.login} on GitHub`}>
      <div className="installation-head">
        <span className="installation-account">{account.login}</span>
        <span className="muted">
          {accountKind(account)} · connected{' '}
          {connectedOn.format(new Date(installation.connectedAt))}
        </span>
      </div>

      {repositories.kind === 'listed' ? (
        <Repositories repositories={repositories.repositories} account={account} />
      ) : repositories.kind === 'gone' ? (
        <p className="error">{INSTALLATION_GONE}</p>
      ) : (
        <p className="muted">{REPOSITORIES_UNAVAILABLE}</p>
      )}

      {asking ? (
        <div className="installation-confirm">
          <p>{DISCONNECT_QUESTION}</p>
          <div className="actions">
            <button
              ref={keep}
              type="button"
              className="button"
              disabled={pending}
              onClick={() => setAsking(false)}
            >
              Keep
            </button>
            <button
              type="button"
              className="button danger"
              disabled={pending}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="installation-actions">
          <a
            className="link-button"
            href={installation.settingsUrl}
            target="_blank"
            rel="noreferrer"
          >
            Choose repositories on GitHub
          </a>
          {canManage && (
            <button
              type="button"
              className="link-button"
              aria-label={`Disconnect ${account.login}`}
              onClick={() => setAsking(true)}
            >
              Disconnect
            </button>
          )}
        </div>
      )}
      {failure && (
        <p className="error" role="alert">
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
    return <p className="muted">No repositories yet. Choose them on GitHub.</p>;
  }
  const { shown, more } = shownRepositories(repositories);
  return (
    <ul className="repositories" aria-label="Repositories">
      {shown.map((repository) => (
        <li key={repository.id}>
          <a href={repository.url} target="_blank" rel="noreferrer" title={repository.fullName}>
            {repositoryLabel(repository, account)}
          </a>
          {!repository.private && <span className="repository-public">Public</span>}
        </li>
      ))}
      {more > 0 && <li className="muted">and {more} more</li>}
    </ul>
  );
}
