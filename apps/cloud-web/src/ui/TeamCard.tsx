import { DropdownMenu } from '@radix-ui/themes';
import { Ellipsis, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { firstTeamNote, messageForTeamChange } from '../domain/teamMessages';
import { addableTo, memberOf } from '../domain/teams';
import type { Team, TeamChange, WorkspaceMember } from '../domain/teams';
import { roleName } from '../domain/workspace';
import type { MyWorkspace } from '../domain/workspace';
import { teamsService } from '../services/teams';
import { useSettingsMenuHost } from './SettingsDialog';
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
    return <img className="teams-avatar" src={member.image} alt="" referrerPolicy="no-referrer" />;
  }
  return (
    <span className="teams-avatar" aria-hidden="true">
      {member ? initials(member.name) : '?'}
    </span>
  );
}

const memberCount = (count: number) => (count === 1 ? '1 member' : `${count} members`);

/**
 * One team, as a card in Settings → Teams: its name, its members, and, for someone who manages
 * teams, its controls. A change that goes through, or that finds the team or the person's rights
 * changed, has the page load the teams again (`onChanged`).
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
  // The card's menus open inside Settings' dialog, or they take no click.
  const { ref: card, container: menuHost } = useSettingsMenuHost();
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
    <section ref={card} className="teams-card" aria-label={team.name}>
      <header className="teams-card-header">
        {mode === 'rename' ? (
          <div className="teams-rename">
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
            <div className="teams-card-title">
              <h3 className="settings-option-label teams-name">
                {team.name}
                {team.first && <span className="settings-chip">First team</span>}
              </h3>
              <p className="settings-option-description">
                {memberCount(team.memberIds.length)}
                {team.first && ` · ${firstTeamNote(workspace.name)}`}
              </p>
            </div>
            {canManage && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger disabled={pending}>
                  <button
                    type="button"
                    className="teams-icon-button"
                    aria-label={`${team.name}: more`}
                  >
                    <Ellipsis size={16} aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" size="2" container={menuHost}>
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

      {mode === 'delete' && (
        <div className="teams-confirm" role="alertdialog" aria-label={`Delete ${team.name}`}>
          <p>
            Delete <strong>{team.name}</strong>? Its members stay in {workspace.name}.
          </p>
          <div className="teams-buttons">
            <button
              type="button"
              className="settings-button"
              disabled={pending}
              onClick={() => setMode('view')}
            >
              Cancel
            </button>
            <button
              type="button"
              className="settings-button danger"
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
        <p className="teams-empty">Nobody is in this team yet.</p>
      ) : (
        <ul className="teams-members">
          {team.memberIds.map((personId) => {
            const shown = memberOf(personId, members);
            const member = shown.kind === 'member' ? shown.member : null;
            const name = member?.name ?? 'Someone who left';
            return (
              <li key={personId} className="teams-member">
                <Avatar member={member} />
                <span className="teams-member-text">
                  <span className="teams-member-name">{name}</span>
                  {member && <span className="teams-member-email">{member.email}</span>}
                </span>
                {member && <span className="teams-member-role">{roleName(member.role)}</span>}
                {canManage && (
                  <button
                    type="button"
                    className="teams-icon-button"
                    aria-label={`Remove ${name} from ${team.name}`}
                    title={`Remove from ${team.name}`}
                    disabled={pending}
                    onClick={() =>
                      void run(() => teamsService.removeTeamMember(ws, team.id, personId))
                    }
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <div className="teams-card-footer">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger disabled={pending || addable.length === 0}>
              <button type="button" className="settings-button">
                <UserPlus size={16} aria-hidden="true" />
                {addable.length === 0 ? 'Everyone is in this team' : 'Add member'}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content
              align="start"
              size="2"
              className="teams-add-menu"
              container={menuHost}
            >
              {addable.map((member) => (
                <DropdownMenu.Item
                  key={member.id}
                  onSelect={() =>
                    void run(() => teamsService.addTeamMember(ws, team.id, member.id))
                  }
                >
                  <span className="teams-add-name">{member.name}</span>
                  <span className="teams-add-email">{member.email}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      )}

      {failure && (
        <p className="teams-error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
