import { ArrowUpRight, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { hashOfFactoryPage } from '../domain/factoryNav';
import { messageForRefusal } from '../domain/refusal';
import { slackTeamLabel } from '../domain/slack';
import type { FactorySlackApp, SlackConnectionsAnswer, SlackLink } from '../domain/slack';
import {
  factoryCount,
  installedWhere,
  linkedSentence,
  messageForUnlinkFailure,
  NO_LINKED_ACCOUNTS,
  SLACK_ASK_HINT,
  SLACK_CONNECTIONS_UNAVAILABLE,
  SLACK_NO_FACTORY_HINT,
  SLACK_NOT_CONFIGURED,
  SLACK_PURPOSE,
  SLACK_SET_UP_HINT,
  SLACK_STATE_WORDS,
  YOUR_ACCOUNTS,
} from '../domain/slackMessages';
import { slackService } from '../services/slack';
import { FactoryTile } from './FactoryTile';
import { ServiceMark } from './serviceMarks';

/**
 * Slack on Settings › Connections (CON-144): the service, then the factories with a Slack app
 * (each its name, `@handle in <Slack workspace>`, its state, and a link to its settings, where it
 * is set up), then the person's own Slack accounts linked in the workspace, each with Unlink.
 * Each factory's app is its own, so nothing is connected from here: an owner or admin sets an
 * app up in its factory's Settings.
 *
 * `connected` says which group the page put it in: the Connected group once a factory has an app
 * or the person has linked an account, else Available.
 */
export function SlackConnection({
  workspaceId,
  answer,
  connected,
  onChanged,
}: {
  workspaceId: string;
  answer: SlackConnectionsAnswer;
  connected: boolean;
  onChanged: () => Promise<void>;
}) {
  if (answer.kind !== 'listed') return <SlackUnlisted answer={answer} onRetry={onChanged} />;
  const { apps, links, canManage } = answer;
  const hint = connected
    ? null
    : !canManage
      ? SLACK_ASK_HINT
      : answer.factoryCount === 0
        ? SLACK_NO_FACTORY_HINT
        : SLACK_SET_UP_HINT;
  return (
    <>
      <ul className="connections-list">
        <li className="connections-service connections-rise">
          <span className="connections-tile">
            <ServiceMark service="slack" />
            {apps.length > 0 && <span className="connections-presence" aria-hidden="true" />}
          </span>
          <div className="connections-text">
            <span className="connections-name">Slack</span>
            <span className="connections-description">{SLACK_PURPOSE}</span>
            {hint && <span className="connections-hint">{hint}</span>}
          </div>
          <div className="connections-aside">
            {apps.length > 0 ? (
              <span className="connections-status">
                <span className="connections-status-dot" aria-hidden="true" />
                Connected
                <span className="connections-status-count">
                  {' · '}
                  {factoryCount(apps.length)}
                </span>
              </span>
            ) : (
              <span className="settings-chip">Not set up</span>
            )}
          </div>
        </li>
        {apps.map((entry) => (
          <FactoryApp key={entry.factory.id} entry={entry} />
        ))}
      </ul>
      {connected && <Accounts workspaceId={workspaceId} links={links} onChanged={onChanged} />}
    </>
  );
}

/** Slack when it could not be listed: off on the server, or not read. */
function SlackUnlisted({
  answer,
  onRetry,
}: {
  answer: Exclude<SlackConnectionsAnswer, { kind: 'listed' }>;
  onRetry: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const off = answer.kind === 'not-configured';
  const message = off
    ? SLACK_NOT_CONFIGURED
    : answer.kind === 'unavailable'
      ? SLACK_CONNECTIONS_UNAVAILABLE
      : messageForRefusal(answer);
  return (
    <ul className="connections-list">
      <li className="connections-service connections-rise">
        <span className="connections-tile">
          <ServiceMark service="slack" />
        </span>
        <div className="connections-text">
          <span className="connections-name">Slack</span>
          <span className="connections-description">{SLACK_PURPOSE}</span>
          <span className="connections-hint">{message}</span>
        </div>
        <div className="connections-aside">
          {off ? (
            <span className="settings-chip">Not set up</span>
          ) : (
            answer.kind === 'unavailable' && (
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
            )
          )}
        </div>
      </li>
    </ul>
  );
}

/** A factory with a Slack app: its name, where its bot is, its state, and its settings. */
function FactoryApp({ entry }: { entry: FactorySlackApp }) {
  const { factory, app } = entry;
  const where = app.team ? installedWhere(app) : `@${app.handle}`;
  return (
    <li className="connections-account connections-rise">
      <span className="connections-avatar organization">
        <FactoryTile factory={factory} size={32} />
      </span>
      <div className="connections-text">
        <span className="connections-account-name">
          <span className="connections-name">{factory.name}</span>
          <span className="settings-chip" data-tone={app.state === 'installed' ? 'on' : 'waiting'}>
            {SLACK_STATE_WORDS[app.state]}
          </span>
        </span>
        <span className="connections-meta">{where}</span>
      </div>
      <div className="connections-actions">
        <a
          className="connections-ghost"
          href={hashOfFactoryPage(factory.id, 'settings')}
          aria-label={`${factory.name}’s Slack settings`}
        >
          Settings
          <ArrowUpRight className="connections-arrow" size={14} aria-hidden="true" />
        </a>
      </div>
    </li>
  );
}

/** The person's own Slack accounts in the workspace, each with Unlink. */
function Accounts({
  workspaceId,
  links,
  onChanged,
}: {
  workspaceId: string;
  links: SlackLink[];
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="connections-subgroup">
      <h4 className="connections-subhead">{YOUR_ACCOUNTS}</h4>
      <ul className="connections-list">
        {links.length === 0 ? (
          <li className="connections-service">
            <span className="connections-description">{NO_LINKED_ACCOUNTS}</span>
          </li>
        ) : (
          links.map((link) => (
            <Account key={link.id} workspaceId={workspaceId} link={link} onChanged={onChanged} />
          ))
        )}
      </ul>
    </div>
  );
}

/** One linked Slack account: its Slack workspace, its id there, when, and Unlink. */
function Account({
  workspaceId,
  link,
  onChanged,
}: {
  workspaceId: string;
  link: SlackLink;
  onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const team = slackTeamLabel({ id: link.slackTeamId, name: link.slackTeamName });
  const meta = [link.slackUserId, linkedSentence(link.linkedAt, new Date())]
    .filter((part) => part !== null)
    .join(' · ');

  async function unlink() {
    setPending(true);
    setFailure(null);
    const answer = await slackService.unlink({ id: workspaceId }, link.id);
    if (answer.kind === 'unlinked' || answer.kind === 'not-found') {
      // Gone on the server, by this press or another: the list loads without it.
      await onChanged();
      return;
    }
    setFailure(messageForUnlinkFailure(answer));
    setPending(false);
  }

  return (
    <li className="connections-account connections-account-row">
      <span className="connections-avatar organization">
        <ServiceMark service="slack" size={16} />
      </span>
      <div className="connections-text">
        <span className="connections-name">{team}</span>
        <span className="connections-meta">{meta}</span>
      </div>
      <div className="connections-actions">
        <button
          type="button"
          className="connections-ghost danger"
          disabled={pending}
          aria-label={`Unlink your Slack account in ${team}`}
          onClick={() => void unlink()}
        >
          {pending ? 'Unlinking…' : 'Unlink'}
        </button>
      </div>
      {failure && (
        <div className="connections-account-body">
          <p className="connections-error" role="alert">
            {failure}
          </p>
        </div>
      )}
    </li>
  );
}
