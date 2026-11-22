import { DropdownMenu } from '@radix-ui/themes';
import { useState } from 'react';
import { firstTeamNote, messageForTeamChange } from '../domain/teamMessages';
import {
  addableTo,
  memberOf,
  type Team,
  type TeamChange,
  type WorkspaceMember,
} from '../domain/teams';
import { type MyWorkspace, roleName } from '../domain/workspace';
import { teamsService } from '../services/teams';
import { TeamNameForm } from './TeamNameForm';

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}

function Avatar({ member }: { member: WorkspaceMember | null }) {
  if (member?.image) {
    return <img className="avatar small" src={member.image} alt="" referrerPolicy="no-referrer" />;
  }
  return (
    <span className="avatar small" aria-hidden="true">
      {member ? initials(member.name) : '?'}
    </span>
  );
}

const memberCount = (count: number) => (count === 1 ? '1 member' : `${count} members`);

/**
 * One team: its name, its members, and, for someone who manages teams, its controls. A change
 * that goes through, or that finds the team or the person's rights changed, has the page load
 * the teams again (`onChanged`).
 */
export function TeamCard({
  team,
  members,
  canManage,
  workspace,
  onChanged,
}: {
  team: Team;
  members: WorkspaceMember[];
  canManage: boolean;
  workspace: MyWorkspace;
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ws = { id: workspace.id };

  /** Sends a change, says why if it did not go through, and loads the teams again if needed. */
  async function run(send: () => Promise<TeamChange>): Promise<TeamChange> {
    setPending(true);
    setFailure(null);
    const answer = await send();
    setPending(false);
    setFailure(messageForTeamChange(answer, workspace));
    if (['changed', 'not-found', 'not-allowed', 'not-a-member'].includes(answer.kind)) {
      await onChanged();
    }
    return answer;
  }

  const addable = addableTo(team, members);

  return (
    <section className="card team" aria-label={team.name}>
      <header className="team-header">
        {mode === 'rename' ? (
          <div className="team-rename">
            <TeamNameForm
              label={`Rename ${team.name}`}
              initial={team.name}
              submitLabel="Save"
              onCancel={() => setMode('view')}
              onSubmit={async (name) => {
                const answer = await teamsService.renameTeam(ws, team.id, name);
                const sentence = messageForTeamChange(answer, workspace);
                if (sentence === null) {
                  setMode('view');
                  await onChanged();
                }
                return answer.kind === 'invalid' ? answer : sentence;
              }}
            />
          </div>
        ) : (
          <>
            <h2 className="heading team-name">{team.name}</h2>
            {team.first && <span className="badge">First team</span>}
            <span className="muted team-count">{memberCount(team.memberIds.length)}</span>
            {canManage && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger disabled={pending}>
                  <button type="button" className="icon-button" aria-label={`${team.name}: more`}>
                    <span aria-hidden="true">⋯</span>
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Item onSelect={() => setMode('rename')}>Rename…</DropdownMenu.Item>
                  {!team.first && (
                    <DropdownMenu.Item color="red" onSelect={() => setMode('delete')}>
                      Delete…
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            )}
          </>
        )}
      </header>

      {team.first && <p className="muted team-note">{firstTeamNote(workspace.name)}</p>}

      {mode === 'delete' && (
        <div className="confirm" role="alertdialog" aria-label={`Delete ${team.name}`}>
          <p>
            Delete <strong>{team.name}</strong>? Its members stay in {workspace.name}.
          </p>
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => setMode('view')}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={pending}
              onClick={() =>
                void run(() => teamsService.deleteTeam(ws, team.id)).then((answer) => {
                  if (answer.kind !== 'changed') setMode('view');
                })
              }
            >
              Delete team
            </button>
          </div>
        </div>
      )}

      {team.memberIds.length === 0 ? (
        <p className="muted">Nobody is in this team yet.</p>
      ) : (
        <ul className="team-members">
          {team.memberIds.map((personId) => {
            const shown = memberOf(personId, members);
            const member = shown.kind === 'member' ? shown.member : null;
            const name = member?.name ?? 'Someone who left';
            return (
              <li key={personId} className="team-member">
                <Avatar member={member} />
                <span className="member-text">
                  <span className="member-name">{name}</span>
                  {member && <span className="member-email">{member.email}</span>}
                </span>
                {member && <span className="member-role">{roleName(member.role)}</span>}
                {canManage && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${name} from ${team.name}`}
                    title={`Remove from ${team.name}`}
                    disabled={pending}
                    onClick={() =>
                      void run(() => teamsService.removeTeamMember(ws, team.id, personId))
                    }
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <div className="team-actions">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger disabled={pending || addable.length === 0}>
              <button type="button" className="button">
                {addable.length === 0 ? 'Everyone is in this team' : 'Add member'}
                {addable.length > 0 && <DropdownMenu.TriggerIcon />}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start" className="add-member-menu">
              {addable.map((member) => (
                <DropdownMenu.Item
                  key={member.id}
                  onSelect={() =>
                    void run(() => teamsService.addTeamMember(ws, team.id, member.id))
                  }
                >
                  <span className="add-member-name">{member.name}</span>
                  <span className="add-member-email">{member.email}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      )}

      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
