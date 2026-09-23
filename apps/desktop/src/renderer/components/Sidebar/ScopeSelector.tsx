import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Folder, GitBranch, Plus, Settings } from 'lucide-react';
import type { Workspace } from '../../stores/workspaceStore';
import { homeScope, useHomeStore } from '../../stores/homeStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import { addScopeViaDialog } from '../../utils/scopeActions';

export function ScopeSelector({ workspace, disabled = false, className = '' }: {
  workspace: Workspace; disabled?: boolean; className?: string;
}) {
  const selectedId = useHomeStore(state => state.scopeIds[workspace.id]);
  const activeSessionId = useNavigationStore(state => state.activeSessionId);
  const selectScope = useHomeStore(state => state.selectScope);
  const scope = homeScope(workspace, selectedId, activeSessionId);
  const { openWorkspaceSettings } = useWorkspaceSettings();
  const [error, setError] = useState('');
  const addScope = async () => {
    setError('');
    try {
      const added = await addScopeViaDialog(workspace.id);
      if (added) selectScope(workspace.id, added.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={`scope-selector ${className}`} aria-label="Choose scope" title={scope?.path} disabled={disabled}>
          {scope?.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
          <span>{scope?.name ?? 'Choose a scope'}</span><ChevronDown size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content scope-selector-menu" align="start" sideOffset={6}>
          <DropdownMenu.Label className="navigation-settings-label">Scopes</DropdownMenu.Label>
          {workspace.scopes.map(candidate => <DropdownMenu.Item key={candidate.id} className="dropdown-item" onSelect={() => selectScope(workspace.id, candidate.id)} title={candidate.path}>
            {candidate.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
            <span className="scope-selector-option"><span>{candidate.name}</span><small>{candidate.path}</small></span>
            {candidate.id === scope?.id && <Check size={14} />}
          </DropdownMenu.Item>)}
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item className="dropdown-item" onSelect={() => void addScope()}><Plus size={14} />Add scope</DropdownMenu.Item>
          <DropdownMenu.Item className="dropdown-item" onSelect={() => openWorkspaceSettings(workspace.id, 'scopes')}><Settings size={14} />Manage scopes…</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {error && <p className="sidebar-error" role="alert">{error}</p>}
  </>;
}
