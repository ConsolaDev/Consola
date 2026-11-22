import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MEMBER_VIEW_NOTE,
  messageForTeamChange,
  messageForTeamsState,
  NO_TEAMS_FOR_MEMBER,
  TEAMS_INTRO,
} from '../domain/teamMessages';
import type { TeamsState } from '../domain/teams';
import { teamsService } from '../services/teams';
import type { SectionProps } from './sections';
import { TeamCard } from './TeamCard';
import { TeamNameForm } from './TeamNameForm';
import './TeamsPage.css';

/**
 * The workspace's teams, from its regional cell. Owners and admins see every team and change
 * them; a member sees the teams they are in, with no controls, since the cell says which
 * (`canManage`). After every change the page loads the teams again, so it shows what the cell
 * holds, whoever else changed it meanwhile.
 */
export function TeamsPage({ workspace }: SectionProps) {
  const [state, setState] = useState<TeamsState | null>(null);
  const [creating, setCreating] = useState(false);
  // Each load is numbered, so only the latest one's answer is shown.
  const latest = useRef(0);
  const workspaceId = workspace.id;

  const load = useCallback(async () => {
    const asked = ++latest.current;
    const next = await teamsService.loadTeams({ id: workspaceId });
    if (asked === latest.current) setState(next);
  }, [workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      latest.current++;
    };
  }, [load]);

  const listed = state?.kind === 'listed' ? state : null;

  return (
    <>
      <header className="section-header">
        <h1 className="section-title">Teams</h1>
        {listed?.canManage && !creating && (
          <button type="button" className="button primary" onClick={() => setCreating(true)}>
            New team
          </button>
        )}
      </header>
      <p className="muted">
        {TEAMS_INTRO}
        {listed && !listed.canManage && ` ${MEMBER_VIEW_NOTE}`}
      </p>

      {state === null && <p className="muted">Loading teams…</p>}

      {state && state.kind !== 'listed' && (
        <section className="card">
          <p role="alert">{messageForTeamsState(state, workspace)}</p>
          {(state.kind === 'pending' || state.kind === 'unavailable') && (
            <div className="actions">
              <button type="button" className="button" onClick={() => void load()}>
                Try again
              </button>
            </div>
          )}
        </section>
      )}

      {listed && creating && (
        <section className="card">
          <h2 className="heading">New team</h2>
          <TeamNameForm
            label="Name"
            submitLabel="Create team"
            onCancel={() => setCreating(false)}
            onSubmit={async (name) => {
              const answer = await teamsService.createTeam({ id: workspaceId }, name);
              const failure = messageForTeamChange(answer, workspace);
              if (failure === null) {
                setCreating(false);
                await load();
              }
              return answer.kind === 'invalid' ? answer : failure;
            }}
          />
        </section>
      )}

      {listed && listed.teams.length === 0 && (
        <section className="card">
          <p className="muted">{NO_TEAMS_FOR_MEMBER}</p>
        </section>
      )}

      {listed?.teams.map((team) => (
        <TeamCard
          key={team.id}
          team={team}
          members={listed.members}
          canManage={listed.canManage}
          workspace={workspace}
          onChanged={load}
        />
      ))}
    </>
  );
}
