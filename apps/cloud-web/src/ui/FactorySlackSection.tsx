import { ArrowUpRight, Check, CircleAlert, Copy, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Factory } from '../domain/factories';
import { messageForRefusal } from '../domain/refusal';
import {
  checkSlackCredentials,
  inviteCommand,
  isInstalled,
  isSlackAddress,
  manifestText,
  SLACK_STEPS,
  slackAppPageUrl,
  slackSteps,
} from '../domain/slack';
import type {
  SlackApp,
  SlackAppAnswer,
  SlackCredentials,
  SlackCredentialsField,
  SlackResult,
  SlackStep,
} from '../domain/slack';
import {
  APP_IN_SLACK,
  CREDENTIAL_LABELS,
  CREDENTIALS_HINT,
  createStepHint,
  DISCONNECT_QUESTION,
  INSTALL_HINT,
  INSTALL_WAITS,
  installedWhere,
  INVITE_HINT,
  isSlackSuccess,
  LINKING_HINT,
  messageForDisconnectFailure,
  messageForInstallFailure,
  messageForSlackResult,
  messagesForCredentialsAnswer,
  messagesForCredentialsProblems,
  NEEDS_REINSTALL,
  SLACK_APP_UNAVAILABLE,
  SLACK_ASK_HINT,
  SLACK_NOT_CONFIGURED,
  SLACK_PURPOSE,
  SLACK_STATE_WORDS,
  SLACK_STEP_TITLES,
} from '../domain/slackMessages';
import type { CredentialsMessages } from '../domain/slackMessages';
import type { MyWorkspace } from '../domain/workspace';
import { copyText } from '../services/clipboard';
import { slackService } from '../services/slack';
import { goToSlack, takeSlackResult } from '../services/slackAddress';
import './FactorySlack.css';
import { ServiceMark } from './serviceMarks';

/** How long a copy's check stays before the button offers to copy again. */
const COPIED_MS = 1600;

/**
 * A factory's Slack app, in its Settings (CON-144): the factory's own bot in a Slack workspace,
 * which people mention, or message, to send the factory's orchestrator a request. Until it is in
 * Slack, the setup's three steps: create the app in Slack from the factory's manifest, paste its
 * credentials, Add to Slack. Once it is, where it is (`@handle in <Slack workspace>`), how to let
 * it into a channel, and Disconnect, which asks first, in place.
 *
 * Every member who sees the factory sees its state; only owners and admins (`canManage`, the
 * API's) see the steps' controls and Disconnect, and the API refuses anyone else whatever the
 * page shows. How the last "Add to Slack" ended (`?slack=`) is read once, as the section mounts.
 */
export function FactorySlackSection({
  factory,
  workspace,
}: {
  factory: Factory;
  workspace: MyWorkspace;
}) {
  const headingId = useId();
  const [arrival] = useState(() => takeSlackResult());
  const [noticeOpen, setNoticeOpen] = useState(true);
  const [answer, setAnswer] = useState<SlackAppAnswer | null>(null);
  const latest = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  const workspaceId = workspace.id;
  const factoryId = factory.id;
  const load = useCallback(async () => {
    const asked = ++latest.current;
    const read = await slackService.loadApp({ id: workspaceId }, factoryId);
    if (asked === latest.current) setAnswer(read);
  }, [workspaceId, factoryId]);

  useEffect(() => {
    void load();
    return () => {
      latest.current++;
    };
  }, [load]);

  /** An app the API answered after a change: shown as it is, with no read in between. */
  const show = useCallback((app: SlackApp) => {
    latest.current++;
    setAnswer({ kind: 'found', app });
  }, []);

  // A change of state takes the button that was pressed with it (Save, Disconnect): the keyboard
  // comes to the group's heading rather than falling out of the page.
  const state = answer?.kind === 'found' ? answer.app.state : null;
  const lastState = useRef(state);
  useEffect(() => {
    const changed = lastState.current !== null && state !== null && state !== lastState.current;
    lastState.current = state;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (changed && lost) heading.current?.focus();
  }, [state]);

  return (
    <section className="group" aria-labelledby={headingId}>
      <h2 ref={heading} id={headingId} tabIndex={-1} className="group-label factory-slack-heading">
        Slack
      </h2>
      {arrival !== null && noticeOpen && (
        <Notice
          result={arrival}
          onDismiss={() => {
            setNoticeOpen(false);
            // The button goes with the notice, so the keyboard lands on the group's heading.
            heading.current?.focus();
          }}
        />
      )}
      <div className="group-box factory-slack">
        {answer === null ? (
          <p className="factory-slack-body factory-slack-quiet" role="status">
            Loading the Slack app…
          </p>
        ) : answer.kind === 'found' ? (
          <SlackAppView
            app={answer.app}
            workspaceId={workspaceId}
            factoryId={factoryId}
            onApp={show}
            onChanged={load}
          />
        ) : (
          <Unread answer={answer} onRetry={load} />
        )}
      </div>
    </section>
  );
}

/** What stands in for the app when it could not be read: Slack off, the factory gone, a refusal. */
function Unread({
  answer,
  onRetry,
}: {
  answer: Exclude<SlackAppAnswer, { kind: 'found' }>;
  onRetry: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  if (answer.kind === 'not-configured') {
    return (
      <div className="factory-slack-head">
        <SlackTile />
        <div className="factory-slack-text">
          <span className="factory-slack-name">Slack app</span>
          <p className="factory-slack-description">{SLACK_NOT_CONFIGURED}</p>
        </div>
        <span className="factory-slack-chip">Off</span>
      </div>
    );
  }
  const message =
    answer.kind === 'not-found'
      ? 'This factory is gone, or now belongs to a team you’re not in.'
      : answer.kind === 'unavailable'
        ? SLACK_APP_UNAVAILABLE
        : messageForRefusal(answer);
  return (
    <div className="factory-slack-body">
      <p role="alert">{message}</p>
      {answer.kind === 'unavailable' && (
        <div className="factory-slack-row">
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void onRetry().then(() => setPending(false));
            }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/** How the last "Add to Slack" ended, said once. */
function Notice({ result, onDismiss }: { result: SlackResult | 'unknown'; onDismiss: () => void }) {
  const good = isSlackSuccess(result);
  return (
    <div className="factory-slack-notice" data-tone={good ? 'done' : 'problem'} role="status">
      {good ? <Check size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
      <p>{messageForSlackResult(result)}</p>
      <button
        type="button"
        className="factory-slack-ghost"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function SlackTile() {
  return (
    <span className="factory-slack-tile">
      <ServiceMark service="slack" size={18} />
    </span>
  );
}

/** The app as the API answered it: its head, then its steps or where it is in Slack. */
function SlackAppView({
  app,
  workspaceId,
  factoryId,
  onApp,
  onChanged,
}: {
  app: SlackApp;
  workspaceId: string;
  factoryId: string;
  onApp: (app: SlackApp) => void;
  onChanged: () => Promise<void>;
}) {
  const steps = slackSteps(app);
  const installed = isInstalled(app);
  return (
    <>
      <div className="factory-slack-head">
        <SlackTile />
        <div className="factory-slack-text">
          <span className="factory-slack-name">
            {installed ? installedWhere(app) : 'Slack app'}
          </span>
          <p className="factory-slack-description">{SLACK_PURPOSE}</p>
        </div>
        <span className="factory-slack-chip" data-state={app.state}>
          {SLACK_STATE_WORDS[app.state]}
        </span>
      </div>
      {steps !== null &&
        (app.canManage ? (
          <Steps
            app={app}
            steps={steps}
            workspaceId={workspaceId}
            factoryId={factoryId}
            onApp={onApp}
          />
        ) : (
          <div className="factory-slack-body">
            <p className="factory-slack-quiet">{SLACK_ASK_HINT}</p>
          </div>
        ))}
      {installed && (
        <Installed
          app={app}
          workspaceId={workspaceId}
          factoryId={factoryId}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

/** The setup's three steps, for an owner or admin. */
function Steps({
  app,
  steps,
  workspaceId,
  factoryId,
  onApp,
}: {
  app: SlackApp;
  steps: SlackStep[];
  workspaceId: string;
  factoryId: string;
  onApp: (app: SlackApp) => void;
}) {
  const statusOf = (id: SlackStep['id']) => steps.find((step) => step.id === id)?.status;
  return (
    <ol className="factory-slack-steps" aria-label="Set up the Slack app">
      {SLACK_STEPS.map((id, index) => {
        const status = statusOf(id) ?? 'waiting';
        return (
          <li key={id} className="factory-slack-step" data-status={status}>
            <span className="factory-slack-marker" aria-hidden="true">
              {status === 'done' ? <Check size={12} /> : index + 1}
            </span>
            <div className="factory-slack-step-main">
              <h3 className="factory-slack-step-title">
                {SLACK_STEP_TITLES[id]}
                {status === 'done' && <span className="sr-only"> (done)</span>}
              </h3>
              {id === 'create' && <CreateStep app={app} done={status === 'done'} />}
              {id === 'credentials' && (
                <CredentialsStep
                  app={app}
                  done={status === 'done'}
                  workspaceId={workspaceId}
                  factoryId={factoryId}
                  onApp={onApp}
                />
              )}
              {id === 'install' && (
                <InstallStep
                  waiting={status === 'waiting'}
                  workspaceId={workspaceId}
                  factoryId={factoryId}
                  label="Add to Slack"
                  hint={INSTALL_HINT}
                />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Step 1: Slack's create-app page with the manifest filled in, or the manifest to paste. */
function CreateStep({ app, done }: { app: SlackApp; done: boolean }) {
  const { createAppUrl } = app.setup;
  if (done) return null;
  return (
    <>
      <p className="hint">{createStepHint(app.handle)}</p>
      <div className="factory-slack-row">
        {isSlackAddress(createAppUrl) && (
          <a className="button" href={createAppUrl} target="_blank" rel="noreferrer noopener">
            Create in Slack
            <ArrowUpRight size={14} aria-hidden="true" />
            <span className="sr-only"> (opens Slack in a new tab)</span>
          </a>
        )}
        <CopyButton text={manifestText(app)} label="Copy the manifest" />
      </div>
    </>
  );
}

/** Step 2: the three credentials, or, once saved, the client ID with Change. */
function CredentialsStep({
  app,
  done,
  workspaceId,
  factoryId,
  onApp,
}: {
  app: SlackApp;
  done: boolean;
  workspaceId: string;
  factoryId: string;
  onApp: (app: SlackApp) => void;
}) {
  const [changing, setChanging] = useState(false);
  if (done && !changing) {
    return (
      <div className="factory-slack-row">
        {app.clientId && (
          <span className="hint">
            Client ID <code className="factory-slack-code">{app.clientId}</code>
          </span>
        )}
        <button type="button" className="factory-slack-ghost" onClick={() => setChanging(true)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <CredentialsForm
      workspaceId={workspaceId}
      factoryId={factoryId}
      onSaved={(saved) => {
        setChanging(false);
        onApp(saved);
      }}
      onCancel={changing ? () => setChanging(false) : undefined}
    />
  );
}

const FIELDS: readonly SlackCredentialsField[] = ['clientId', 'clientSecret', 'signingSecret'];
const EMPTY: SlackCredentials = { clientId: '', clientSecret: '', signingSecret: '' };

function CredentialsForm({
  workspaceId,
  factoryId,
  onSaved,
  onCancel,
}: {
  workspaceId: string;
  factoryId: string;
  onSaved: (app: SlackApp) => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<SlackCredentials>(EMPTY);
  const [messages, setMessages] = useState<CredentialsMessages>({});
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checked = checkSlackCredentials(draft);
    if (!checked.ok) {
      setMessages(messagesForCredentialsProblems(checked.problems));
      return;
    }
    setPending(true);
    setMessages({});
    const answer = await slackService.saveCredentials(
      { id: workspaceId },
      factoryId,
      checked.credentials,
    );
    setPending(false);
    if (answer.kind === 'saved') {
      // The secrets go with the form: nothing on the page holds them once they are sent.
      setDraft(EMPTY);
      onSaved(answer.app);
      return;
    }
    setMessages(messagesForCredentialsAnswer(answer));
  }

  return (
    <form className="form" noValidate onSubmit={(event) => void submit(event)}>
      <p className="hint">{CREDENTIALS_HINT}</p>
      <div className="factory-slack-fields">
        {FIELDS.map((field) => {
          const message = messages[field];
          return (
            <div key={field} className="field">
              <label className="label" htmlFor={`${id}-${field}`}>
                {CREDENTIAL_LABELS[field]}
              </label>
              <input
                id={`${id}-${field}`}
                className="input"
                type={field === 'clientId' ? 'text' : 'password'}
                value={draft[field]}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={message ? true : undefined}
                aria-describedby={message ? `${id}-${field}-error` : undefined}
                disabled={pending}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((last) => ({ ...last, [field]: value }));
                  setMessages((last) => ({ ...last, [field]: undefined, form: undefined }));
                }}
              />
              {message && (
                <p id={`${id}-${field}-error`} className="error">
                  {message}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div className="factory-slack-row">
        <button type="submit" className="button" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {onCancel && (
          <button
            type="button"
            className="factory-slack-ghost"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
      {messages.form && (
        <p className="error" role="alert">
          {messages.form}
        </p>
      )}
    </form>
  );
}

/** Step 3, and adding an app Slack stopped accepting again: Slack's authorise page. */
function InstallStep({
  waiting,
  workspaceId,
  factoryId,
  label,
  hint,
}: {
  waiting: boolean;
  workspaceId: string;
  factoryId: string;
  label: string;
  /** What the step says above its button, while it can be pressed. */
  hint?: string;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function install() {
    setPending(true);
    setFailure(null);
    const answer = await slackService.startInstall({ id: workspaceId }, factoryId);
    if (answer.kind === 'started') {
      // The page is left for Slack, which sends the person back here.
      goToSlack(answer.url);
      return;
    }
    setFailure(messageForInstallFailure(answer));
    setPending(false);
  }

  return (
    <>
      {waiting ? <p className="hint">{INSTALL_WAITS}</p> : hint && <p className="hint">{hint}</p>}
      <div className="factory-slack-row">
        <button
          type="button"
          className="button primary"
          disabled={waiting || pending}
          onClick={() => void install()}
        >
          {pending ? 'Opening Slack…' : label}
        </button>
      </div>
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
    </>
  );
}

/** An app in Slack: how to let it into a channel, and, for owners and admins, Disconnect. */
function Installed({
  app,
  workspaceId,
  factoryId,
  onChanged,
}: {
  app: SlackApp;
  workspaceId: string;
  factoryId: string;
  onChanged: () => Promise<void>;
}) {
  const needsReinstall = app.state === 'needs_reinstall';
  return (
    <div className="factory-slack-body">
      {needsReinstall ? (
        <p className="factory-slack-warning">
          <TriangleAlert size={14} aria-hidden="true" />
          {NEEDS_REINSTALL}
        </p>
      ) : (
        <>
          <div className="factory-slack-row">
            <span>{INVITE_HINT}</span>
            <code className="factory-slack-code">{inviteCommand(app.handle)}</code>
            <CopyButton text={inviteCommand(app.handle)} label="Copy" />
          </div>
          <p className="factory-slack-quiet">{LINKING_HINT}</p>
        </>
      )}
      {app.canManage && (
        <>
          {needsReinstall && (
            <InstallStep
              waiting={false}
              workspaceId={workspaceId}
              factoryId={factoryId}
              label="Add to Slack again"
            />
          )}
          <Disconnect
            app={app}
            workspaceId={workspaceId}
            factoryId={factoryId}
            onChanged={onChanged}
          />
        </>
      )}
    </div>
  );
}

/** Disconnect, asked first, in place: the token revoked, the app left in Slack. */
function Disconnect({
  app,
  workspaceId,
  factoryId,
  onChanged,
}: {
  app: SlackApp;
  workspaceId: string;
  factoryId: string;
  onChanged: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
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
    const answer = await slackService.disconnect({ id: workspaceId }, factoryId);
    if (answer.kind === 'disconnected' || answer.kind === 'not-found') {
      // Gone on the server, by this press or another: the section reads the app again.
      await onChanged();
      return;
    }
    setFailure(messageForDisconnectFailure(answer));
    setPending(false);
  }

  return (
    <>
      {!asking && (
        <div className="factory-slack-row">
          <button
            ref={ask}
            type="button"
            className="factory-slack-ghost danger"
            onClick={() => setAsking(true)}
          >
            Disconnect
          </button>
        </div>
      )}
      {asking && (
        // Escape here answers Keep.
        <fieldset
          className="factory-confirm"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (!pending) setAsking(false);
          }}
        >
          <legend className="sr-only">Disconnect the Slack app?</legend>
          <p>{DISCONNECT_QUESTION}</p>
          <p>
            <a
              className="factory-slack-ghost"
              href={slackAppPageUrl(app)}
              target="_blank"
              rel="noreferrer noopener"
            >
              {APP_IN_SLACK}
              <ArrowUpRight size={14} aria-hidden="true" />
              <span className="sr-only"> (opens Slack in a new tab)</span>
            </a>
          </p>
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
              className="button factory-slack-danger"
              disabled={pending}
              onClick={() => void disconnect()}
            >
              {pending ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </fieldset>
      )}
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
    </>
  );
}

/** Copies `text`; its icon turns to a check for a moment, and a refusal is said. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [outcome, setOutcome] = useState<'copied' | 'refused' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const copied = await copyText(text);
    setOutcome(copied ? 'copied' : 'refused');
    clearTimeout(timer.current);
    if (copied) timer.current = setTimeout(() => setOutcome(null), COPIED_MS);
  }

  return (
    <>
      <button type="button" className="factory-slack-ghost" onClick={() => void copy()}>
        {outcome === 'copied' ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
        {label}
      </button>
      <span className={outcome === 'refused' ? 'factory-slack-quiet' : 'sr-only'} role="status">
        {outcome === 'copied'
          ? 'Copied'
          : outcome === 'refused'
            ? 'The browser didn’t allow copying.'
            : ''}
      </span>
    </>
  );
}
