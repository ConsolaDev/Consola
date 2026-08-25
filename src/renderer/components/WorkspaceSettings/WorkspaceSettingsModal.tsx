import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Boxes, Folder, Info, Plug, Sparkles, Trash2, X, type LucideIcon } from 'lucide-react';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { ProviderBindingPanel } from '../Provider';
import { ManifestHeader } from './ManifestHeader';
import { HarnessPanel } from './HarnessPanel';
import { ScopesPanel } from './ScopesPanel';
import { GroupsPanel } from './GroupsPanel';
import { DangerZonePanel } from './DangerZonePanel';
import { ActionsPlaceholderPanel } from './ActionsPlaceholderPanel';
import { providerNavLabel } from './navLabels';
import '../Dialogs/styles.css';
import './styles.css';

export type WorkspaceSettingsSectionId =
  | 'general'
  | 'scopes'
  | 'provider'
  | 'actions'
  | 'groups'
  | 'danger';

interface WorkspaceSettingsNavMeta {
  /** A function of the workspace: the Provider entry is named by what is bound. */
  label: (workspace: Workspace) => string;
  icon: LucideIcon;
  danger?: boolean;
}

const NAV_ORDER: WorkspaceSettingsSectionId[] = [
  'general',
  'scopes',
  'provider',
  'actions',
  'groups',
  'danger',
];

// A Record, not a second array: TypeScript itself rejects a missing or
// duplicate section id here, which is what would otherwise need a vitest
// test — npm run typecheck already proves completeness.
const NAV_META: Record<WorkspaceSettingsSectionId, WorkspaceSettingsNavMeta> = {
  general: { label: () => 'General', icon: Info },
  scopes: { label: () => 'Scopes', icon: Folder },
  provider: { label: providerNavLabel, icon: Plug },
  actions: { label: () => 'Actions', icon: Sparkles },
  groups: { label: () => 'Groups', icon: Boxes },
  danger: { label: () => 'Danger zone', icon: Trash2, danger: true },
};

interface WorkspaceSettingsModalProps {
  /** The workspace to edit; null means closed. */
  workspaceId: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * One workspace's settings as a dialog of its own, titled by the workspace
 * so it is visibly not the global Settings modal. The panels are the six the
 * old Workspace tab stacked; here a left nav shows one at a time.
 */
export function WorkspaceSettingsModal({ workspaceId, onOpenChange }: WorkspaceSettingsModalProps) {
  const workspace = useWorkspaceStore((state) =>
    workspaceId
      ? (state.workspaces.find((candidate) => candidate.id === workspaceId) ?? null)
      : null
  );

  // The workspace can vanish out from under an open dialog — deleted from its
  // own danger zone, or from another window entirely. `open` follows the
  // record rather than the id, so the dialog is gone the same render; this
  // effect only tells the owner to drop the id. Closing, not a "not found"
  // state, matches DeleteWorkspaceDialog's callers, which have nothing left
  // to clear once main drops the record.
  useEffect(() => {
    if (workspaceId && !workspace) onOpenChange(false);
  }, [workspaceId, workspace, onOpenChange]);

  return (
    <Dialog.Root open={workspace !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="settings-modal-content">
          {/* Keyed so retargeting the modal to another workspace remounts
              every panel: no draft, open rename or pending confirmation
              survives into another workspace's record — the contract the
              old Workspace tab kept, carried over. */}
          {workspace && <WorkspaceSettingsBody key={workspace.id} workspace={workspace} />}
          <Dialog.Close asChild>
            <button className="dialog-close" aria-label="Close">
              <X size={16} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WorkspaceSettingsBody({ workspace }: { workspace: Workspace }) {
  const [activeSection, setActiveSection] = useState<WorkspaceSettingsSectionId>('general');

  return (
    <>
      <nav className="settings-modal-nav">
        <div className="settings-modal-nav-header">
          {/* The visible text is the accessible title: unlike the global
              modal's decorative "Settings" header, this one names the thing
              being edited, so it doubles as Dialog.Title instead of hiding
              a duplicate. */}
          <Dialog.Title className="settings-modal-workspace-title">{workspace.name}</Dialog.Title>
          <Dialog.Description className="settings-modal-workspace-subtitle">
            Workspace settings
          </Dialog.Description>
        </div>
        {NAV_ORDER.map((id) => {
          const { label, icon: Icon, danger } = NAV_META[id];
          return (
            <button
              key={id}
              type="button"
              className={`settings-modal-nav-item ${activeSection === id ? 'active' : ''} ${
                danger ? 'danger' : ''
              }`}
              onClick={() => setActiveSection(id)}
            >
              <Icon size={16} />
              <span>{label(workspace)}</span>
            </button>
          );
        })}
      </nav>

      <div className="settings-modal-body">
        <div className="settings-modal-section">
          {activeSection === 'general' && (
            <>
              <ManifestHeader workspace={workspace} />
              <HarnessPanel workspace={workspace} />
            </>
          )}
          {activeSection === 'scopes' && <ScopesPanel workspace={workspace} />}
          {activeSection === 'provider' && (
            <section className="ws-panel">
              <ProviderBindingPanel workspace={workspace} />
            </section>
          )}
          {/* Phase C swaps this one branch for <ActionsPanel workspace={workspace} />
              and deletes ActionsPlaceholderPanel.tsx; nothing else here changes. */}
          {activeSection === 'actions' && <ActionsPlaceholderPanel />}
          {activeSection === 'groups' && <GroupsPanel workspace={workspace} />}
          {activeSection === 'danger' && <DangerZonePanel workspace={workspace} />}
        </div>
      </div>
    </>
  );
}
