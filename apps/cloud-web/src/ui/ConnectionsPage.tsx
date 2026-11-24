import {
  ArrowUpRight,
  Building2,
  CircleAlert,
  CloudOff,
  LoaderCircle,
  Plus,
  RotateCw,
  TriangleAlert,
  User,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  accountCount,
  CONNECTIONS_UNAVAILABLE,
  connectedAtLong,
  connectedSentence,
  DISCONNECT_QUESTION,
  GITHUB_ASK_HINT,
  GITHUB_CONNECT_HINT,
  GITHUB_NOT_CONFIGURED,
  GITHUB_PURPOSE,
  INSTALLATION_GONE,
  LATER_SERVICES_HINT,
  messageForConnectFailure,
  messageForDisconnectFailure,
  messageForGitHubResult,
  NO_REPOSITORIES,
  REPOSITORIES_UNAVAILABLE,
  repositoryCount,
} from '../domain/connectionMessages';
import {
  accountKind,
  avatarUrl,
  isSuccess,
  justConnectedId,
  LATER_SERVICES,
} from '../domain/connections';
import type {
  Connections,
  ConnectionsState,
  GitHubAccount,
  GitHubConnection,
  GitHubResult,
} from '../domain/connections';
import { disconnectGitHub, loadConnections, startGitHubConnect } from '../services/api';
import { goToGitHub, takeGitHubResult } from '../services/gitHubRedirect';
import './ConnectionsPage.css';
import type { SectionProps } from './sections';
import { ServiceMark } from './serviceMarks';

/** How long a disconnected account takes to fade from its list before the list loads again. */
const LEAVE_MS = 180;

/** A row's place in its list, which staggers how the rows come in (`.connections-rise`). */
function rise(index: number): CSSProperties {
  return { '--rise': Math.min(index, 12) } as CSSProperties;
}

/**
 * Settings' Connections page (`#/settings/connections`), laid out as Notion's and the like: what
 * the workspace has connected, in one group with each account under its service, then what it
 * can connect, then what comes later, each service known by its mark. Every member sees what is
 * connected; only owners and admins see Connect and Disconnect, as the server says
 * (`canManage`), and the server refuses anyone else whatever the page shows. How the last
 * Connect ended (`?github=`) is read once, as the page mounts, and the account it added is
 * marked.
 */
export function ConnectionsPage({ workspace }: SectionProps) {
  const [arrival] = useState(() => ({ result: takeGitHubResult(), at: Date.now() }));
  const [noticeOpen, setNoticeOpen] = useState(true);
  const [state, setState] = useState<ConnectionsState | null>(null);
  const latest = useRef(0);
  const title = useRef<HTMLHeadingElement>(null);

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

  const { result } = arrival;

  return (
    <div className="settings-section connections">
      <div className="settings-option-info">
        <h2 ref={title} tabIndex={-1} className="settings-section-title">
          Connections
        </h2>
        <p className="settings-option-description">
          The services {workspace.name} works with. Automations and factories reach them through
          these connections.
        </p>
      </div>

      {result !== null && noticeOpen && (
        <Notice
          result={result}
          onDismiss={() => {
            setNoticeOpen(false);
            // The button goes with the notice, so the keyboard lands on the page's title.
            title.current?.focus();
          }}
        />
      )}

      {state === null ? (
        <Loading />
      ) : state.kind === 'loaded' ? (
        <GitHubGroup
          connections={state.connections}
          justConnected={
            result === 'connected'
              ? justConnectedId(state.connections.github.installations, arrival.at)
              : null
          }
          onChanged={load}
        />
      ) : (
        <LoadFailed onRetry={load} />
      )}

      <LaterGroup />
    </div>
  );
}

/** How the last Connect ended, said once, with a check that draws itself when it went well. */
function Notice({
  result,
  onDismiss,
}: {
  result: GitHubResult | 'unknown';
  onDismiss: () => void;
}) {
  const good = isSuccess(result);
  return (
    <div className={good ? 'connections-notice done' : 'connections-notice problem'} role="status">
      {good ? (
        <svg
          className="connections-notice-icon connections-check"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.75" pathLength={1} />
          <path d="M5.2 8.3 7.1 10.2 10.9 6" pathLength={1} />
        </svg>
      ) : (
        <CircleAlert className="connections-notice-icon" size={16} aria-hidden="true" />
      )}
      <p>{messageForGitHubResult(result)}</p>
      <button
        type="button"
        className="connections-notice-close"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/** A service's mark on its tile; a live one carries a green dot, as a person who is online. */
function ServiceTile({ service, live = false }: { service: string; live?: boolean }) {
  return (
    <span className="connections-tile">
      <ServiceMark service={service} />
      {live && <span className="connections-presence" aria-hidden="true" />}
    </span>
  );
}

/**
 * GitHub: in the Connected group with its accounts under it once one is connected, else in
 * Available with Connect for those who may.
 */
function GitHubGroup({
  connections,
  justConnected,
  onChanged,
}: {
  connections: Connections;
  justConnected: number | null;
  onChanged: () => Promise<void>;
}) {
  const { canManage, github } = connections;
  const { installations } = github;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const connected = installations.length > 0;
  const mayConnect = github.configured && canManage;

  // A disconnected account leaves with the button that had the keyboard, so the keyboard comes
  // to the group's heading rather than falling out of the dialog.
  const count = installations.length;
  const lastCount = useRef(count);
  useEffect(() => {
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (count < lastCount.current && lost) heading.current?.focus();
    lastCount.current = count;
  }, [count]);

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

  const failed = failure && (
    <p className="connections-error" role="alert">
      {failure}
    </p>
  );

  if (!connected) {
    const hint = !github.configured
      ? GITHUB_NOT_CONFIGURED
      : canManage
        ? GITHUB_CONNECT_HINT
        : GITHUB_ASK_HINT;
    return (
      <div className="connections-group">
        <h3 ref={heading} tabIndex={-1} className="connections-group-label">
          Available
        </h3>
        <ul className="connections-list">
          <li className="connections-service connections-rise">
            <ServiceTile service="github" />
            <div className="connections-text">
              <span className="connections-name">GitHub</span>
              <span className="connections-description">{GITHUB_PURPOSE}</span>
              <span className="connections-hint">{hint}</span>
            </div>
            <div className="connections-aside">
              {mayConnect ? (
                <button
                  type="button"
                  className="settings-button accent connections-connect"
                  disabled={pending}
                  onClick={() => void connect()}
                >
                  {pending ? (
                    <>
                      <LoaderCircle className="connections-spin" size={16} aria-hidden="true" />
                      Opening GitHub…
                    </>
                  ) : (
                    'Connect'
                  )}
                </button>
              ) : (
                <span className="settings-chip">
                  {github.configured ? 'Not connected' : 'Not set up'}
                </span>
              )}
            </div>
          </li>
        </ul>
        {failed}
      </div>
    );
  }

  return (
    <div className="connections-group">
      <h3 ref={heading} tabIndex={-1} className="connections-group-label">
        Connected
      </h3>
      <ul className="connections-list">
        <li className="connections-service connections-rise">
          <ServiceTile service="github" live />
          <div className="connections-text">
            <span className="connections-name">GitHub</span>
            <span className="connections-description">{GITHUB_PURPOSE}</span>
          </div>
          <div className="connections-aside">
            <span className="connections-status">
              <span className="connections-status-dot" aria-hidden="true" />
              Connected
              <span className="connections-status-count">
                {' · '}
                {accountCount(installations.length)}
              </span>
            </span>
          </div>
        </li>
        {installations.map((installation, index) => (
          <Installation
            key={installation.id}
            installation={installation}
            index={index + 1}
            isNew={installation.id === justConnected}
            canManage={canManage}
            onChanged={onChanged}
          />
        ))}
        {mayConnect && (
          <li className="connections-rise" style={rise(installations.length + 1)}>
            <button
              type="button"
              className="connections-add"
              disabled={pending}
              onClick={() => void connect()}
            >
              <span className="connections-add-icon" aria-hidden="true">
                {pending ? (
                  <LoaderCircle className="connections-spin" size={16} />
                ) : (
                  <Plus size={16} />
                )}
              </span>
              {pending ? 'Opening GitHub…' : 'Connect another account'}
            </button>
          </li>
        )}
      </ul>
      {failed}
    </div>
  );
}

/** One installation the workspace holds: its account, how many repositories, and Disconnect. */
function Installation({
  installation,
  index,
  isNew,
  canManage,
  onChanged,
}: {
  installation: GitHubConnection;
  index: number;
  isNew: boolean;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const { account, repositories } = installation;
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const ask = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  // Asking puts the keyboard on Keep; answering Keep puts it back on Disconnect.
  useEffect(() => {
    if (asking) keep.current?.focus();
    else if (wasAsking.current) ask.current?.focus();
    wasAsking.current = asking;
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
    if (answer.kind !== 'signed-out') {
      // Gone on the server already: the row fades out before the list loads without it.
      setLeaving(true);
      await new Promise((resolve) => setTimeout(resolve, LEAVE_MS));
    }
    // Disconnected, already gone, or signed out: what the page shows has changed either way.
    await onChanged();
  }

  const listed = repositories.kind === 'listed' ? repositories.repositories : null;
  const meta = [
    accountKind(account),
    listed ? repositoryCount(listed.length) : null,
    connectedSentence(installation.connectedAt, new Date()),
  ]
    .filter((part) => part !== null)
    .join(' · ');

  // The repositories themselves are GitHub's to list ("Choose repositories"): the card counts
  // them, and says something only when there is no list to count.
  const note =
    repositories.kind === 'gone' ? (
      <p className="connections-warning">
        <TriangleAlert size={14} aria-hidden="true" />
        {INSTALLATION_GONE}
      </p>
    ) : repositories.kind === 'unavailable' ? (
      <p className="connections-meta">{REPOSITORIES_UNAVAILABLE}</p>
    ) : listed?.length === 0 ? (
      <p className="connections-meta">{NO_REPOSITORIES}</p>
    ) : null;

  return (
    <li
      className="connections-account connections-rise"
      style={rise(index)}
      data-new={isNew || undefined}
      data-asking={asking || undefined}
      data-leaving={leaving || undefined}
    >
      <AccountAvatar account={account} gone={repositories.kind === 'gone'} />
      <div className="connections-text">
        <span className="connections-account-name">
          <span className="connections-name">{account.login}</span>
          {isNew && <span className="settings-chip new">Just connected</span>}
        </span>
        <span className="connections-meta" title={connectedAtLong(installation.connectedAt) ?? ''}>
          {meta}
        </span>
      </div>
      <div className="connections-actions">
        <a
          className="connections-ghost"
          href={installation.settingsUrl}
          target="_blank"
          rel="noreferrer"
        >
          Choose repositories
          <ArrowUpRight className="connections-arrow" size={14} aria-hidden="true" />
        </a>
        {canManage && !asking && (
          <button
            ref={ask}
            type="button"
            className="connections-ghost danger"
            aria-label={`Disconnect ${account.login}`}
            onClick={() => setAsking(true)}
          >
            Disconnect
          </button>
        )}
      </div>

      {(note || asking || failure) && (
        <div className="connections-account-body">
          {note}

          {asking && (
            // Escape here answers Keep, rather than closing Settings.
            <fieldset
              className="connections-confirm"
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                if (!pending) setAsking(false);
              }}
            >
              <legend className="connections-sr">Disconnect {account.login}?</legend>
              <p>{DISCONNECT_QUESTION}</p>
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
                  {pending && (
                    <LoaderCircle className="connections-spin" size={16} aria-hidden="true" />
                  )}
                  {pending ? 'Disconnecting…' : `Disconnect ${account.login}`}
                </button>
              </div>
            </fieldset>
          )}
          {failure && (
            <p className="connections-error" role="alert">
              {failure}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The account's picture from GitHub, square-cornered for an organization and round for a person,
 * as GitHub draws them. Its icon sits under it while it loads, and stays if it never does.
 */
function AccountAvatar({ account, gone }: { account: GitHubAccount; gone: boolean }) {
  const [shown, setShown] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const organization = account.type === 'Organization';
  const Icon = organization ? Building2 : User;
  return (
    <span
      className={organization ? 'connections-avatar organization' : 'connections-avatar'}
      data-gone={gone || undefined}
    >
      <Icon size={16} aria-hidden="true" />
      {shown !== 'failed' && (
        <img
          src={avatarUrl(account, 64)}
          alt=""
          width={28}
          height={28}
          loading="lazy"
          data-loaded={shown === 'loaded' || undefined}
          onLoad={() => setShown('loaded')}
          onError={() => setShown('failed')}
        />
      )}
    </span>
  );
}

/** The services that come later, as tiles: each known by its mark, none connectable yet. */
function LaterGroup() {
  return (
    <div className="connections-group">
      <div className="connections-group-head">
        <h3 className="connections-group-label">Coming later</h3>
        <p className="connections-group-hint">{LATER_SERVICES_HINT}</p>
      </div>
      <ul className="connections-grid">
        {LATER_SERVICES.map((service, index) => (
          <li
            key={service.id}
            className="connections-card connections-rise"
            style={rise(index + 2)}
          >
            <ServiceTile service={service.id} />
            <div className="connections-text">
              <span className="connections-name">{service.name}</span>
              <span className="connections-description">{service.purpose}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The shape of the Connected group while it loads, so nothing jumps when it arrives. */
function Loading() {
  return (
    <div className="connections-group" aria-busy="true">
      <span className="connections-bone" style={{ width: 72, height: 10 }} />
      <ul className="connections-list" aria-hidden="true">
        {[0, 1].map((row) => (
          <li key={row} className="connections-service">
            <span className="connections-bone connections-tile" />
            <div className="connections-text bones">
              <span className="connections-bone" style={{ width: '28%', height: 11 }} />
              <span className="connections-bone" style={{ width: '64%', height: 10 }} />
            </div>
          </li>
        ))}
      </ul>
      <span className="connections-sr" role="status">
        Loading connections…
      </span>
    </div>
  );
}

/** The connections could not be loaded: says so, with Try again. */
function LoadFailed({ onRetry }: { onRetry: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <ul className="connections-list">
      <li className="connections-service">
        <span className="connections-tile quiet">
          <CloudOff size={18} aria-hidden="true" />
        </span>
        <div className="connections-text">
          <span className="connections-description strong">{CONNECTIONS_UNAVAILABLE}</span>
        </div>
        <div className="connections-aside">
          <button
            type="button"
            className="settings-button"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              await onRetry();
              setPending(false);
            }}
          >
            <RotateCw
              className={pending ? 'connections-spin' : undefined}
              size={16}
              aria-hidden="true"
            />
            Try again
          </button>
        </div>
      </li>
    </ul>
  );
}
