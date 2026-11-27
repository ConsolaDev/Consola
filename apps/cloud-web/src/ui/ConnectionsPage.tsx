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
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  accountCount,
  CONNECTIONS_UNAVAILABLE,
  connectAccountLabel,
  connectedAtLong,
  connectedSentence,
  DISCONNECT_QUESTION,
  GITHUB_ASK_HINT,
  GITHUB_CHOICE_HINT,
  GITHUB_CHOICE_LABEL,
  GITHUB_CONNECT_HINT,
  GITHUB_HELD_ELSEWHERE_HINT,
  GITHUB_HELD_ELSEWHERE_LABEL,
  GITHUB_NOT_CONFIGURED,
  GITHUB_PURPOSE,
  HELD_ELSEWHERE,
  INSTALL_ELSEWHERE,
  INSTALLATION_GONE,
  LATER_SERVICES_HINT,
  messageForChoiceFailure,
  messageForConnectFailure,
  messageForDisconnectFailure,
  messageForGitHubResult,
  NO_REPOSITORIES,
  REPOSITORIES_UNAVAILABLE,
  repositoryCount,
} from '../domain/connectionMessages';
import {
  accountKind,
  afterQuietRead,
  avatarUrl,
  isSuccess,
  justConnectedId,
  LATER_SERVICES,
  refreshesOnShow,
  resultOfChoice,
  splitCandidates,
} from '../domain/connections';
import type {
  ChoiceState,
  Connections,
  ConnectionsState,
  GitHubAccount,
  GitHubCandidate,
  GitHubConnection,
  GitHubResult,
} from '../domain/connections';
import { slackConnected } from '../domain/slack';
import type { SlackConnectionsAnswer, SlackResult } from '../domain/slack';
import { isSlackSuccess, messageForSlackResult } from '../domain/slackMessages';
import {
  connectChosenGitHub,
  disconnectGitHub,
  loadConnections,
  loadGitHubChoice,
  startGitHubConnect,
} from '../services/api';
import { goToGitHub, takeGitHubReturn } from '../services/gitHubRedirect';
import { onPageVisibilityChange } from '../services/pageVisibility';
import { slackService } from '../services/slack';
import { takeSlackResult } from '../services/slackAddress';
import './ConnectionsPage.css';
import type { SectionProps } from './sections';
import { ServiceMark } from './serviceMarks';
import { SlackConnection } from './SlackConnection';

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
 * marked; a Connect that waits on the person's choice of account (`?github=choose&choice=`, or
 * `taken_elsewhere` when another workspace holds every one) shows the accounts instead; and how
 * an "Add to Slack" that named no factory ended (`?slack=`) is said too.
 *
 * Slack (CON-144) is one app per factory, set up in each factory's Settings: here it lists the
 * factories with an app and the person's own linked Slack accounts (`SlackConnection`).
 */
export function ConnectionsPage({ workspace }: SectionProps) {
  const [arrival] = useState(() => ({
    returned: takeGitHubReturn(),
    slack: takeSlackResult(),
    at: Date.now(),
  }));
  const [notice, setNotice] = useState<{ result: GitHubResult | 'unknown'; at: number } | null>(
    () =>
      arrival.returned?.kind === 'ended'
        ? { result: arrival.returned.result, at: arrival.at }
        : null,
  );
  const [choice, setChoice] = useState<string | null>(() =>
    arrival.returned?.kind === 'choose' ? arrival.returned.choice : null,
  );
  const [slackNoticeOpen, setSlackNoticeOpen] = useState(true);
  const [state, setState] = useState<ConnectionsState | null>(null);
  const [slack, setSlack] = useState<SlackConnectionsAnswer | null>(null);
  const latest = useRef(0);
  const lastReadAt = useRef<number | null>(null);
  const latestSlack = useRef(0);
  const title = useRef<HTMLHeadingElement>(null);
  const connectedHeading = useRef<HTMLHeadingElement>(null);
  const availableHeading = useRef<HTMLHeadingElement>(null);

  const workspaceId = workspace.id;
  // A quiet read is the page's own: it never shows the loading state, and one that does not
  // answer keeps the connections shown (`afterQuietRead`).
  const load = useCallback(
    async (quiet = false) => {
      const asked = ++latest.current;
      lastReadAt.current = Date.now();
      const answer = await loadConnections({ id: workspaceId });
      if (asked !== latest.current) return;
      setState((shown) => (quiet ? afterQuietRead(shown, answer) : answer));
    },
    [workspaceId],
  );

  const loadSlack = useCallback(async () => {
    const asked = ++latestSlack.current;
    const answer = await slackService.loadConnections({ id: workspaceId });
    if (asked === latestSlack.current) setSlack(answer);
  }, [workspaceId]);

  // The server answers for the session's active workspace, and refuses a call that names
  // another (`switched`). Settings mounts its page afresh for each workspace, so one load per
  // mount follows a switch.
  useEffect(() => {
    void load();
    void loadSlack();
    return () => {
      latest.current++;
      latestSlack.current++;
    };
  }, [load, loadSlack]);

  // Coming back to the page, from GitHub's tab above all, where the person may have changed
  // which repositories an installation covers, reads GitHub's connections again, quietly,
  // unless they were read a moment ago (`refreshesOnShow`).
  useEffect(
    () =>
      onPageVisibilityChange((visible) => {
        if (visible && refreshesOnShow(lastReadAt.current, Date.now())) void load(true);
      }),
    [load],
  );

  // A notice or a choice that goes takes the button that had the keyboard with it, so the
  // keyboard lands on the page's title.
  const toTitle = () => title.current?.focus();

  const github = state?.kind === 'loaded' ? state.connections : null;
  const githubConnected = github !== null && github.github.installations.length > 0;
  const slackIsConnected = slack !== null && slackConnected(slack);

  const gitHubEntry = github && (
    <GitHubService
      workspaceId={workspaceId}
      connections={github}
      justConnected={
        notice?.result === 'connected'
          ? justConnectedId(github.github.installations, notice.at)
          : null
      }
      onChanged={load}
    />
  );
  const slackEntry = slack && (
    <SlackConnection
      workspaceId={workspaceId}
      answer={slack}
      connected={slackIsConnected}
      onChanged={loadSlack}
    />
  );
  const anyConnected = githubConnected || slackIsConnected;

  // A disconnected account or an unlinked one leaves with the button that had the keyboard, and
  // its service may move to another group as it does: the keyboard goes to the heading of the
  // group it sits in now, rather than falling out of the dialog.
  const githubCount = github?.github.installations.length ?? null;
  const slackCount = slack?.kind === 'listed' ? slack.links.length : null;
  const lastCounts = useRef({ github: githubCount, slack: slackCount });
  const headingFor = (isConnected: boolean) => (isConnected ? connectedHeading : availableHeading);
  const giveFocus = useEffectEvent((service: 'github' | 'slack') => {
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!lost) return;
    headingFor(service === 'github' ? githubConnected : slackIsConnected).current?.focus();
  });
  useEffect(() => {
    const last = lastCounts.current;
    lastCounts.current = { github: githubCount, slack: slackCount };
    const fewer = (now: number | null, before: number | null) =>
      now !== null && before !== null && now < before;
    if (fewer(githubCount, last.github)) giveFocus('github');
    else if (fewer(slackCount, last.slack)) giveFocus('slack');
  }, [githubCount, slackCount]);
  const githubAvailable = github !== null && !githubConnected;
  const slackAvailable = slack !== null && !slackIsConnected;

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

      {notice !== null && (
        <Notice
          good={isSuccess(notice.result)}
          message={messageForGitHubResult(notice.result)}
          onDismiss={() => {
            setNotice(null);
            toTitle();
          }}
        />
      )}
      {arrival.slack !== null && slackNoticeOpen && (
        <SlackNotice
          result={arrival.slack}
          onDismiss={() => {
            setSlackNoticeOpen(false);
            toTitle();
          }}
        />
      )}

      {choice !== null && (
        <GitHubChoice
          workspaceId={workspaceId}
          choice={choice}
          onConnected={(result) => {
            setChoice(null);
            setNotice({ result, at: Date.now() });
            toTitle();
            void load();
          }}
          onDismiss={() => {
            setChoice(null);
            toTitle();
          }}
        />
      )}

      {state === null || slack === null ? (
        <Loading />
      ) : (
        <>
          {anyConnected && (
            <div className="connections-group">
              <h3 ref={connectedHeading} tabIndex={-1} className="connections-group-label">
                Connected
              </h3>
              {githubConnected && gitHubEntry}
              {slackIsConnected && slackEntry}
            </div>
          )}
          {(githubAvailable || slackAvailable || state.kind !== 'loaded') && (
            <div className="connections-group">
              <h3 ref={availableHeading} tabIndex={-1} className="connections-group-label">
                Available
              </h3>
              {state.kind !== 'loaded' && <LoadFailed onRetry={load} />}
              {githubAvailable && gitHubEntry}
              {slackAvailable && slackEntry}
            </div>
          )}
        </>
      )}

      <LaterGroup />
    </div>
  );
}

/** How "Add to Slack" ended, when the callback sent the person here (no factory named). */
function SlackNotice({
  result,
  onDismiss,
}: {
  result: SlackResult | 'unknown';
  onDismiss: () => void;
}) {
  return (
    <Notice
      good={isSlackSuccess(result)}
      message={messageForSlackResult(result)}
      onDismiss={onDismiss}
    />
  );
}

/** How the last Connect ended, said once, with a check that draws itself when it went well. */
function Notice({
  good,
  message,
  onDismiss,
}: {
  good: boolean;
  message: string;
  onDismiss: () => void;
}) {
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
      <p>{message}</p>
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
 * The accounts a person who signed in to GitHub may connect: those they own with the app
 * installed already, which no workspace holds, with those another workspace holds marked and
 * not offered. Drawn as the Connected group is (GitHub, then each account under it, with Connect
 * <account>), with Install on another account last. The API reads them from the signed choice,
 * and checks everything again when one is chosen; how that ends is the page's notice, and the
 * choice goes.
 */
function GitHubChoice({
  workspaceId,
  choice,
  onConnected,
  onDismiss,
}: {
  workspaceId: string;
  choice: string;
  onConnected: (result: GitHubResult) => void;
  onDismiss: () => void;
}) {
  const [state, setState] = useState<ChoiceState | null>(null);
  // The account being connected, or the install page being opened.
  const [pending, setPending] = useState<number | 'install' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void loadGitHubChoice({ id: workspaceId }, choice).then((answer) => {
      if (current) setState(answer);
    });
    return () => {
      current = false;
    };
  }, [workspaceId, choice]);

  async function connect(candidate: GitHubCandidate) {
    setPending(candidate.id);
    setFailure(null);
    const answer = await connectChosenGitHub(
      { id: workspaceId },
      { choice, installationId: candidate.id },
    );
    if (answer.kind === 'connected' || answer.kind === 'already-connected') {
      onConnected(resultOfChoice(answer));
      return;
    }
    setFailure(messageForChoiceFailure(answer));
    setPending(null);
  }

  async function installElsewhere() {
    setPending('install');
    setFailure(null);
    const answer = await startGitHubConnect({ id: workspaceId });
    if (answer.kind === 'started') {
      // The page is left for GitHub's install page, which sends the person back here.
      goToGitHub(answer.installUrl);
      return;
    }
    setFailure(
      answer.kind === 'signed-out'
        ? messageForChoiceFailure(answer)
        : messageForConnectFailure(answer),
    );
    setPending(null);
  }

  if (state === null) return <Loading />;
  if (state.kind !== 'loaded') {
    return <Notice good={false} message={messageForChoiceFailure(state)} onDismiss={onDismiss} />;
  }

  const { candidates } = state;
  const { available, heldElsewhere } = splitCandidates(candidates);
  // With none to connect, every account is another workspace's: the group says so instead.
  const allHeld = available.length === 0;
  return (
    <div className="connections-group">
      <div className="connections-group-head">
        <h3 className="connections-group-label">
          {allHeld ? GITHUB_HELD_ELSEWHERE_LABEL : GITHUB_CHOICE_LABEL}
        </h3>
        <button
          type="button"
          className="connections-ghost"
          disabled={pending !== null}
          onClick={onDismiss}
        >
          Not now
        </button>
      </div>
      <ul className="connections-list">
        <li className="connections-service connections-rise">
          <ServiceTile service="github" />
          <div className="connections-text">
            <span className="connections-name">GitHub</span>
            <span className="connections-description">
              {allHeld ? GITHUB_HELD_ELSEWHERE_HINT : GITHUB_CHOICE_HINT}
            </span>
          </div>
        </li>
        {[...available, ...heldElsewhere].map((candidate, index) => (
          <li
            key={candidate.id}
            className="connections-account connections-rise"
            style={rise(index + 1)}
          >
            <AccountAvatar account={candidate.account} gone={false} />
            <div className="connections-text">
              <span className="connections-account-name">
                <span className="connections-name">{candidate.account.login}</span>
              </span>
              <span className="connections-meta">{accountKind(candidate.account)}</span>
            </div>
            <div className="connections-actions">
              {candidate.heldElsewhere ? (
                // Which workspace holds it is never said: only that one does.
                <span className="settings-chip">{HELD_ELSEWHERE}</span>
              ) : (
                <button
                  type="button"
                  className="settings-button accent"
                  disabled={pending !== null}
                  onClick={() => void connect(candidate)}
                >
                  {pending === candidate.id && (
                    <LoaderCircle className="connections-spin" size={16} aria-hidden="true" />
                  )}
                  {pending === candidate.id
                    ? 'Connecting…'
                    : connectAccountLabel(candidate.account.login)}
                </button>
              )}
            </div>
          </li>
        ))}
        <li className="connections-rise" style={rise(candidates.length + 1)}>
          <button
            type="button"
            className="connections-add"
            disabled={pending !== null}
            onClick={() => void installElsewhere()}
          >
            <span className="connections-add-icon" aria-hidden="true">
              {pending === 'install' ? (
                <LoaderCircle className="connections-spin" size={16} />
              ) : (
                <Plus size={16} />
              )}
            </span>
            {pending === 'install' ? 'Opening GitHub…' : INSTALL_ELSEWHERE}
          </button>
        </li>
      </ul>
      {failure && (
        <p className="connections-error" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

/**
 * GitHub: with its accounts under it once one is connected, in the Connected group, else with
 * Connect for those who may, in Available. The page puts it in its group.
 */
function GitHubService({
  workspaceId,
  connections,
  justConnected,
  onChanged,
}: {
  workspaceId: string;
  connections: Connections;
  justConnected: number | null;
  onChanged: () => Promise<void>;
}) {
  const { canManage, github } = connections;
  const { installations } = github;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const connected = installations.length > 0;
  const mayConnect = github.configured && canManage;

  async function connect() {
    setPending(true);
    setFailure(null);
    const answer = await startGitHubConnect({ id: workspaceId });
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
      <>
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
      </>
    );
  }

  return (
    <>
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
            workspaceId={workspaceId}
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
    </>
  );
}

/** One installation the workspace holds: its account, how many repositories, and Disconnect. */
function Installation({
  workspaceId,
  installation,
  index,
  isNew,
  canManage,
  onChanged,
}: {
  workspaceId: string;
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
    const answer = await disconnectGitHub({ id: workspaceId }, installation.id);
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
            onClick={() => {
              setPending(true);
              void onRetry().then(() => setPending(false));
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
