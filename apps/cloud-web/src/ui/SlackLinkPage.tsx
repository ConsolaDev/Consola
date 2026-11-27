import { Check, Link2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MeState } from '../domain/me';
import { messageForSwitchFailure } from '../domain/messages';
import { messageForRefusal } from '../domain/refusal';
import { hashOfSlackLink, linkPageView } from '../domain/slack';
import type { LinkPageView, LinkRequestAnswer } from '../domain/slack';
import {
  LINK_EXPLAINED,
  LINK_SIGN_IN_HINT,
  LINKED_WORDS,
  linkGoneWords,
  linkQuestion,
  messageForConfirmFailure,
  NO_WORKSPACE_WORDS,
  NOT_A_MEMBER_WORDS,
  otherWorkspaceWords,
  SLACK_NOT_CONFIGURED,
} from '../domain/slackMessages';
import type { MyWorkspace } from '../domain/workspace';
import { switchWorkspace } from '../services/api';
import { slackService } from '../services/slack';
import { leaveSlackLink } from '../services/slackAddress';
import { BrandMark } from './BrandMark';
import { ServiceMark } from './serviceMarks';
import { SignInCard } from './SignInCard';
import { SignOutButton } from './SignOutButton';
import './SlackLinkPage.css';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * The one-time link a factory's Slack bot sends someone it does not know yet
 * (`#/slack/link/<token>`, CON-144): it links their Slack account to them in the workspace, so
 * the factories they see there take their requests from Slack.
 *
 * Signed out, it is the sign-in card, which comes back here. Signed in, it reads the link for the
 * session's active workspace and asks to confirm: "Link Slack account U… in <Slack workspace> to
 * you in <workspace>?". A link for another of the person's workspaces offers to switch to it
 * (`switchWorkspace`, as the workspace menu does), then reads it again; one for a workspace they
 * are not in says so; one used or expired says to mention the bot again for a new one. Once
 * linked, it says to send the request again in Slack. What it shows is `linkPageView`'s.
 */
export function SlackLinkPage({
  token,
  me,
  workspaces,
  signInError,
  onSwitched,
  onCreate,
}: {
  token: string;
  me: MeState | null;
  workspaces: MyWorkspace[] | null;
  signInError: string | null;
  /** Loads who is signed in and their workspaces again, after a switch. */
  onSwitched: () => Promise<void>;
  onCreate: () => void;
}) {
  const [read, setRead] = useState<LinkRequestAnswer | null>(null);
  const [linked, setLinked] = useState(false);
  // Each read is numbered, so only the latest one's answer is shown; `attempt` asks for another.
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);

  const activeId = me?.kind === 'signed-in' ? (me.me.workspace?.id ?? null) : null;

  // The link is read for the session's active workspace, and again whenever it changes: the API
  // says whether the link is for it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `attempt` is what reads it again.
  useEffect(() => {
    if (activeId === null) return;
    const asked = ++latest.current;
    void slackService.readLink({ id: activeId }, token).then((answer) => {
      if (asked === latest.current) setRead(answer);
    });
    return () => {
      latest.current++;
    };
  }, [activeId, token, attempt]);

  const readAgain = async () => {
    setAttempt((last) => last + 1);
  };
  /** Loads who is signed in again, then the link, for whichever workspace is open now. */
  const reload = async () => {
    await onSwitched();
    setAttempt((last) => last + 1);
  };

  const view = linkPageView({ me, workspaces, read, linked });

  if (view.kind === 'signed-out') {
    return (
      <SignInCard
        error={signInError}
        title="Link your Slack account"
        hint={LINK_SIGN_IN_HINT}
        returnTo={`/${hashOfSlackLink(token)}`}
      />
    );
  }

  return (
    <>
      {me?.kind === 'signed-in' && (
        <header className="topbar">
          <span className="brand-name">Consola Cloud</span>
          <span className="crumb" aria-hidden="true">
            /
          </span>
          <WorkspaceSwitcher
            active={me.me.workspace}
            workspaces={workspaces}
            onSwitched={onSwitched}
            onCreate={onCreate}
          />
          <SignOutButton className="link-button" />
        </header>
      )}
      <section className="card slack-link" aria-labelledby="slack-link-title">
        <span className="slack-link-marks" aria-hidden="true">
          <span className="slack-link-tile">
            <ServiceMark service="slack" size={20} />
          </span>
          <Link2 className="slack-link-join" size={16} />
          <span className="slack-link-tile">
            <BrandMark />
          </span>
        </span>
        <h1 id="slack-link-title" className="heading">
          {view.kind === 'linked' ? 'Your Slack account is linked' : 'Link your Slack account'}
        </h1>
        <LinkBody
          view={view}
          token={token}
          onLinked={() => setLinked(true)}
          onReadAgain={readAgain}
          onReload={reload}
          onSwitched={onSwitched}
        />
      </section>
    </>
  );
}

/** What the card says and offers, by the page's view. */
function LinkBody({
  view,
  token,
  onLinked,
  onReadAgain,
  onReload,
  onSwitched,
}: {
  view: Exclude<LinkPageView, { kind: 'signed-out' }>;
  token: string;
  onLinked: () => void;
  onReadAgain: () => Promise<void>;
  onReload: () => Promise<void>;
  onSwitched: () => Promise<void>;
}) {
  switch (view.kind) {
    case 'loading':
      return (
        <p className="muted" role="status">
          Reading the link…
        </p>
      );
    case 'unavailable':
      return (
        <>
          <p role="alert">{messageForRefusal({ kind: 'unavailable' })}</p>
          <Again label="Try again" onPress={onReadAgain} />
        </>
      );
    case 'switched':
      return (
        <>
          <p role="alert">{messageForRefusal({ kind: 'switched' })}</p>
          <Again label="Reload" onPress={onReload} />
        </>
      );
    case 'not-configured':
      return <p role="alert">{SLACK_NOT_CONFIGURED}</p>;
    case 'no-workspace':
      return <p>{NO_WORKSPACE_WORDS}</p>;
    case 'gone':
      return (
        <>
          <p role="alert">{linkGoneWords(view.why, view.request?.factory?.name ?? null)}</p>
          <Leave label="Open Consola Cloud" />
        </>
      );
    case 'not-a-member':
      return (
        <>
          <p role="alert">{NOT_A_MEMBER_WORDS}</p>
          <Leave label="Open Consola Cloud" />
        </>
      );
    case 'other-workspace':
      return <SwitchOffer view={view} onSwitched={onSwitched} />;
    case 'confirm':
      return <Confirm view={view} token={token} onLinked={onLinked} onReadAgain={onReadAgain} />;
    case 'linked':
      return (
        <>
          <p className="slack-link-done" role="status">
            <Check size={16} aria-hidden="true" />
            {LINKED_WORDS}
          </p>
          <Leave label="Open Consola Cloud" />
        </>
      );
  }
}

/** The link is for another of the person's workspaces: Switch, then it is read again. */
function SwitchOffer({
  view,
  onSwitched,
}: {
  view: Extract<LinkPageView, { kind: 'other-workspace' }>;
  onSwitched: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { target, active } = view;

  async function open() {
    setPending(true);
    setFailure(null);
    const answer = await switchWorkspace(target.id);
    if (answer.kind === 'not-found' || answer.kind === 'unavailable') {
      setFailure(messageForSwitchFailure(answer));
    }
    // A workspace not found may have left the list, and signed out shows the sign-in card.
    if (answer.kind !== 'unavailable') await onSwitched();
    setPending(false);
  }

  return (
    <>
      <p>{otherWorkspaceWords(target.name, active.name)}</p>
      <div className="actions slack-link-actions">
        <Leave label="Not now" quiet />
        <button
          type="button"
          className="button primary"
          disabled={pending}
          onClick={() => void open()}
        >
          {pending ? 'Switching…' : target.name ? `Switch to ${target.name}` : 'Switch'}
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

/** The question, with Link, for a link of the workspace open. */
function Confirm({
  view,
  token,
  onLinked,
  onReadAgain,
}: {
  view: Extract<LinkPageView, { kind: 'confirm' }>;
  token: string;
  onLinked: () => void;
  onReadAgain: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { request, workspace } = view;

  async function link() {
    setPending(true);
    setFailure(null);
    const answer = await slackService.confirmLink(workspace, token);
    if (answer.kind === 'linked') {
      onLinked();
      return;
    }
    setPending(false);
    setFailure(messageForConfirmFailure(answer, request.factory?.name ?? null));
    // A link used or expired meanwhile, or a session switched, reads as it is now.
    if (answer.kind === 'gone' || answer.kind === 'other-workspace') await onReadAgain();
  }

  return (
    <>
      <p className="slack-link-question">{linkQuestion(request, workspace.name)}</p>
      <p className="muted">{LINK_EXPLAINED}</p>
      <div className="actions slack-link-actions">
        <Leave label="Cancel" quiet />
        <button
          type="button"
          className="button primary"
          disabled={pending}
          onClick={() => void link()}
        >
          {pending ? 'Linking…' : 'Link'}
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

/** Leaves the link for the dashboard. */
function Leave({ label, quiet = false }: { label: string; quiet?: boolean }) {
  return (
    <button
      type="button"
      className={quiet ? 'button' : 'button primary'}
      onClick={() => leaveSlackLink()}
    >
      {label}
    </button>
  );
}

/** Reads again, or loads the page again: one press, off while it works. */
function Again({ label, onPress }: { label: string; onPress: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <div className="actions slack-link-actions">
      <button
        type="button"
        className="button"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onPress().then(() => setPending(false));
        }}
      >
        {label}
      </button>
    </div>
  );
}
