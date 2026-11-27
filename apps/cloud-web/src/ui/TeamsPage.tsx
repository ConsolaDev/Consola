import { Plus } from 'lucide-react';
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
 * Settings → Teams: the workspace's teams, from the API. Owners and admins see every
 * team and change them; a member sees the teams they are in, with no controls, since the API
 * says which (`canManage`). After every change the page loads the teams again, so it shows what
 * the API holds, whoever else changed it meanwhile.
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
    <div className="settings-section teams">
      <div className="teams-header">
        <div className="settings-option-info">
          <h2 className="settings-section-title">Teams</h2>
          <p className="settings-option-description">
            {TEAMS_INTRO}
            {listed && !listed.canManage && ` ${MEMBER_VIEW_NOTE}`}
          </p>
        </div>
        {listed?.canManage && !creating && (
          <button
            type="button"
            className="settings-button accent"
            onClick={() => setCreating(true)}
          >
            <Plus size={16} aria-hidden="true" />
            New team
          </button>
        )}
      </div>

      {state === null && <p className="settings-option-description">Loading teams…</p>}

      {state && state.kind !== 'listed' && (
        <div className="teams-card teams-notice">
          <p role="alert">{messageForTeamsState(state)}</p>
          {state.kind === 'unavailable' && (
            <button type="button" className="settings-button" onClick={() => void load()}>
              Try again
            </button>
          )}
        </div>
      )}

      {listed && creating && (
        <div className="teams-card">
          <TeamNameForm
            label="New team"
            submitLabel="Create team"
            onCancel={() => setCreating(false)}
            onSubmit={async (name) => {
              const answer = await teamsService.createTeam({ id: workspaceId }, name);
              const failure = messageForTeamChange(answer);
              if (failure === null) {
                setCreating(false);
                await load();
              }
              return answer.kind === 'invalid' ? answer : failure;
            }}
          />
        </div>
      )}

      {listed && listed.teams.length === 0 && (
        <p className="settings-option-description">{NO_TEAMS_FOR_MEMBER}</p>
      )}

      {listed && listed.teams.length > 0 && (
        <div className="teams-list">
          {listed.teams.map((team) => (
            <TeamCard
              key={team.id}
              team={team}
              members={listed.members}
              canManage={listed.canManage}
              workspace={workspace}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}
