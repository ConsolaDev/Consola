import { useState } from 'react';
import { Archive, ArchiveRestore, Boxes, Pencil } from 'lucide-react';
import { useWorkspaceStore, type Group, type Workspace } from '../../stores/workspaceStore';
import { InlineRename } from './InlineRename';

interface GroupsPanelProps {
  workspace: Workspace;
}

/**
 * The workspace's groups: live ones renamable and archivable, archived ones
 * restorable. Restoring is metadata-only — member sessions kept their groupId
 * the whole time, so the sidebar picks the group straight back up.
 */
export function GroupsPanel({ workspace }: GroupsPanelProps) {
  const updateGroup = useWorkspaceStore((state) => state.updateGroup);
  const archiveGroup = useWorkspaceStore((state) => state.archiveGroup);
  const restoreGroup = useWorkspaceStore((state) => state.restoreGroup);

  const [renamingId, setRenamingId] = useState<string | null>(null);

  const live = workspace.groups.filter((group) => !group.archivedAt);
  const archived = workspace.groups.filter((group) => group.archivedAt);

  const memberCountFor = (groupId: string) =>
    workspace.sessions.filter((session) => session.groupId === groupId).length;

  const renderName = (group: Group) =>
    renamingId === group.id ? (
      <InlineRename
        value={group.name}
        ariaLabel={`Rename group ${group.name}`}
        onSubmit={(name) => updateGroup(workspace.id, group.id, { name })}
        onClose={() => setRenamingId(null)}
      />
    ) : (
      <span className="ws-row-name">{group.name}</span>
    );

  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Groups</h3>
      </div>
      {workspace.groups.length === 0 ? (
        <p className="ws-panel-hint">No groups yet. Create one from the ＋ New menu.</p>
      ) : (
        <>
          {live.length > 0 && (
            <div className="ws-row-list">
              {live.map((group) => {
                const members = memberCountFor(group.id);
                return (
                  <div key={group.id} className="ws-row">
                    <span className="ws-row-icon">
                      <Boxes size={13} />
                    </span>
                    {renderName(group)}
                    {renamingId !== group.id && (
                      <>
                        {members > 0 && (
                          <span className="ws-row-chip">
                            {members} session{members === 1 ? '' : 's'}
                          </span>
                        )}
                        <button
                          type="button"
                          className="ws-row-action"
                          onClick={() => setRenamingId(group.id)}
                          aria-label={`Rename group ${group.name}`}
                          title="Rename"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="ws-row-action"
                          onClick={() => void archiveGroup(workspace.id, group.id)}
                          aria-label={`Archive group ${group.name}`}
                          title="Archive — members return to their scopes"
                        >
                          <Archive size={13} />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {archived.length > 0 && (
            <>
              <div className="ws-archived-heading">Archived</div>
              <div className="ws-row-list">
                {archived.map((group) => (
                  <div key={group.id} className="ws-row ws-row--archived">
                    <span className="ws-row-icon">
                      <Boxes size={13} />
                    </span>
                    <span className="ws-row-name">{group.name}</span>
                    {group.archivedAt && (
                      <span className="ws-row-meta">
                        archived {new Date(group.archivedAt).toLocaleDateString()}
                      </span>
                    )}
                    <button
                      type="button"
                      className="ws-row-action"
                      onClick={() => void restoreGroup(workspace.id, group.id)}
                      aria-label={`Restore group ${group.name}`}
                      title="Restore to the sidebar"
                    >
                      <ArchiveRestore size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
