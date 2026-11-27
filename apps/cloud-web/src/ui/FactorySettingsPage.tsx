import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { checkFactoryName, FACTORY_NAME_MAX, isMove, owningTeam } from '../domain/factories';
import type { Factory } from '../domain/factories';
import {
  MOVE_HINT,
  messageForFactoryProblem,
  messagesForFactoryChange,
  moveQuestion,
  NO_OTHER_TEAM,
  teamLabel,
} from '../domain/factoryMessages';
import type { FactoryFormMessages } from '../domain/factoryMessages';
import type { Team } from '../domain/teams';
import type { MyWorkspace } from '../domain/workspace';
import { factoriesService } from '../services/factories';
import { FactorySlackSection } from './FactorySlackSection';
import { SourceChoice } from './SourceChoice';

/**
 * A factory's Settings (`#/factories/<id>/settings`): Name, renamed in place; Team, given to
 * another of the teams the API lists for the person by Move, which asks first, since it changes
 * who sees the factory; and Files, where they come from, shown and not changeable yet. Whoever
 * sees a factory may rename and move it, so there is no `canManage` to read.
 *
 * Every change reads the list again (`onChanged`), so the sidebar and this page show what the
 * API holds. Under it, the factory's Slack app (`FactorySlackSection`), which only owners and
 * admins set up.
 */
export function FactorySettingsPage({
  factory,
  teams,
  workspace,
  onChanged,
}: {
  factory: Factory;
  teams: Team[];
  workspace: MyWorkspace;
  onChanged: () => Promise<void>;
}) {
  return (
    <>
      <section className="group" aria-labelledby="factory-settings-label">
        <h2 id="factory-settings-label" className="group-label">
          Settings
        </h2>
        <div className="group-box factory-settings">
          <NameSetting
            key={factory.name}
            factory={factory}
            workspace={workspace}
            onChanged={onChanged}
          />
          <TeamSetting
            key={factory.teamId}
            factory={factory}
            teams={teams}
            workspace={workspace}
            onChanged={onChanged}
          />
          <div className="factory-setting">
            <SourceChoice chosen={factory.source.kind} readOnly />
          </div>
        </div>
      </section>
      <FactorySlackSection key={factory.id} factory={factory} workspace={workspace} />
    </>
  );
}

/** The factory's name, renamed in place. */
function NameSetting({
  factory,
  workspace,
  onChanged,
}: {
  factory: Factory;
  workspace: MyWorkspace;
  onChanged: () => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(factory.name);
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<FactoryFormMessages>({});
  const unchanged = name.trim() === factory.name;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checked = checkFactoryName(name);
    if (!checked.ok) {
      setMessages({ name: checked.problems.map(messageForFactoryProblem).join(' ') });
      return;
    }
    if (checked.name === factory.name) return;
    setPending(true);
    setMessages({});
    const answer = await factoriesService.renameFactory(workspace, factory.id, checked.name);
    if (answer.kind === 'changed') {
      // The list read again names the factory anew, which starts this field again.
      await onChanged();
      setPending(false);
      return;
    }
    setPending(false);
    setMessages(messagesForFactoryChange(answer));
    if (answer.kind === 'factory-not-found') await onChanged();
  }

  const message = messages.name ?? messages.team ?? messages.form;

  return (
    <form className="factory-setting" noValidate onSubmit={(event) => void submit(event)}>
      <label className="label" htmlFor={`${id}-name`}>
        Name
      </label>
      <div className="factory-setting-row">
        <input
          id={`${id}-name`}
          className="input factory-setting-input"
          value={name}
          maxLength={FACTORY_NAME_MAX * 2}
          autoComplete="off"
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${id}-name-error` : undefined}
          disabled={pending}
          onChange={(event) => {
            setName(event.target.value);
            setMessages({});
          }}
        />
        <button type="submit" className="button" disabled={pending || unchanged}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {message && (
        <p id={`${id}-name-error`} className="error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}

/**
 * The team that owns the factory, given to another of the person's teams by Move, which asks
 * first, in place: the move changes who sees the factory.
 */
function TeamSetting({
  factory,
  teams,
  workspace,
  onChanged,
}: {
  factory: Factory;
  teams: Team[];
  workspace: MyWorkspace;
  onChanged: () => Promise<void>;
}) {
  const id = useId();
  const [wanted, setWanted] = useState(factory.teamId);
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<FactoryFormMessages>({});
  const owner = owningTeam(factory, teams);
  const others = teams.filter((team) => team.id !== factory.teamId);
  // A team the API no longer lists for the person (the list was read again) is no move.
  const teamId = isMove(factory, wanted, teams) ? wanted : factory.teamId;
  const target = others.find((team) => team.id === teamId);
  const keepButton = useRef<HTMLButtonElement>(null);
  const moveButton = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  // Asking puts the keyboard on Keep; answering Keep puts it back on Move.
  useEffect(() => {
    if (asking) keepButton.current?.focus();
    else if (wasAsking.current) moveButton.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  async function move() {
    if (!target) return;
    setPending(true);
    setMessages({});
    const answer = await factoriesService.moveFactory(workspace, factory.id, target.id);
    if (answer.kind === 'changed') {
      // The list read again names the factory's new team, which starts this field again.
      await onChanged();
      setPending(false);
      setAsking(false);
      return;
    }
    setPending(false);
    setAsking(false);
    setMessages(messagesForFactoryChange(answer));
    if (answer.kind === 'team-not-found' || answer.kind === 'factory-not-found') {
      await onChanged();
    }
  }

  const message = messages.team ?? messages.name ?? messages.form;

  return (
    <form
      className="factory-setting"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (target) setAsking(true);
      }}
    >
      <label className="label" htmlFor={`${id}-team`}>
        Team
      </label>
      <div className="factory-setting-row">
        <select
          id={`${id}-team`}
          className="input select factory-setting-input"
          value={teamId}
          aria-invalid={message ? true : undefined}
          aria-describedby={[`${id}-team-hint`, message && `${id}-team-error`]
            .filter(Boolean)
            .join(' ')}
          disabled={pending || asking || others.length === 0}
          onChange={(event) => {
            setWanted(event.target.value);
            setMessages({});
          }}
        >
          {/* The team that owns it, even one the person's list does not hold yet. */}
          <option value={factory.teamId}>{teamLabel(owner)}</option>
          {others.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
        <button
          ref={moveButton}
          type="submit"
          className="button"
          disabled={pending || asking || !target}
        >
          Move
        </button>
      </div>
      <p id={`${id}-team-hint`} className="hint">
        {others.length === 0 ? NO_OTHER_TEAM : MOVE_HINT}
      </p>
      {asking && target && (
        <fieldset
          className="factory-confirm"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (!pending) setAsking(false);
          }}
        >
          <legend className="sr-only">Move {factory.name}?</legend>
          <p>{moveQuestion(factory.name, teamLabel(owner), target.name)}</p>
          <div className="actions">
            <button
              ref={keepButton}
              type="button"
              className="button"
              disabled={pending}
              onClick={() => setAsking(false)}
            >
              Keep
            </button>
            <button
              type="button"
              className="button primary"
              disabled={pending}
              onClick={() => void move()}
            >
              {pending ? 'Moving…' : `Move to ${target.name}`}
            </button>
          </div>
        </fieldset>
      )}
      {message && (
        <p id={`${id}-team-error`} className="error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
