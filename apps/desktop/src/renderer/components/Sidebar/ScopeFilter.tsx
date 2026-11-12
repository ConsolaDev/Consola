import { useState, type KeyboardEvent } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Folder, GitBranch, Plus, Settings, X } from 'lucide-react';
import { listedSessions } from '../../../shared/workspace';
import type { Workspace } from '../../stores/workspaceStore';
import { filteredScope, useHomeStore } from '../../stores/homeStore';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import { addScopeViaDialog } from '../../utils/scopeActions';
import { chooseScope } from '../../utils/sessionActions';
import { scopeTrail } from '../../utils/scopeTrail';
import { tildePath } from '../../utils/displayPath';

/** Past this many scopes, the menu leads with a search field. */
const SEARCH_THRESHOLD = 8;

/**
 * The scope row: says which scope the session list below it shows, and
 * narrows it. It sits under the Assistant, inside the part of the sidebar it
 * filters, because a control reads as governing whatever sits under it, and
 * search, Home, Inbox and the Assistant are workspace-wide.
 *
 * All scopes is the default and has no fill. A picked scope tints the row and
 * shows a × back to All: the tint is the "this list is narrowed" signal.
 */
export function ScopeFilter({ workspace }: { workspace: Workspace }) {
  const filterId = useHomeStore(state => state.scopeFilters[workspace.id]);
  const scope = filteredScope(workspace, filterId);
  const trail = scope ? scopeTrail(workspace.scopes, scope) : undefined;
  const { openWorkspaceSettings } = useWorkspaceSettings();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  // The same sessions the list shows for each scope, so a count never
  // promises a row that isn't there.
  const counts = new Map<string, number>();
  for (const session of listedSessions(workspace)) {
    if (session.name.length > 0) counts.set(session.scopeId, (counts.get(session.scopeId) ?? 0) + 1);
  }
  const searchable = workspace.scopes.length > SEARCH_THRESHOLD;
  const needle = query.trim().toLowerCase();
  const shown = searchable && needle
    ? workspace.scopes.filter(candidate => candidate.name.toLowerCase().includes(needle) || candidate.path.toLowerCase().includes(needle))
    : workspace.scopes;

  const addScope = async () => {
    setError('');
    try {
      const added = await addScopeViaDialog(workspace.id);
      if (added) chooseScope(workspace.id, added.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  // The field owns its keys: Radix's typeahead would otherwise take each
  // letter as a jump to the item starting with it. ↓ steps into the list.
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
    event.stopPropagation();
  };

  return <>
    <div className={`sidebar-scope-filter ${scope ? 'is-filtered' : ''}`}>
      <DropdownMenu.Root onOpenChange={open => { if (!open) setQuery(''); }}>
        <DropdownMenu.Trigger asChild>
          <button className="sidebar-scope-filter-trigger" aria-label="Filter sessions by scope" title={scope ? tildePath(scope.path) : undefined}>
            <Folder size={14} aria-hidden="true" />
            <span className="sidebar-scope-filter-label">
              {trail?.parent && <>
                <span className="sidebar-scope-filter-parent">{trail.parent}</span>
                <span className="sidebar-scope-filter-slash" aria-hidden="true">/</span>
              </>}
              <span className="sidebar-scope-filter-name">{trail?.label ?? 'All scopes'}</span>
            </span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="dropdown-content sidebar-scope-menu" align="start" sideOffset={4}>
            {searchable && <input
              className="sidebar-scope-menu-search" type="search" placeholder="Find a scope" aria-label="Find a scope"
              value={query} autoFocus onChange={event => setQuery(event.target.value)} onKeyDown={onSearchKeyDown}
            />}
            <DropdownMenu.Item className="dropdown-item" onSelect={() => chooseScope(workspace.id, null)}>
              <span className="sidebar-scope-menu-name">All scopes</span>
              <span className="sidebar-scope-menu-check">{!scope && <Check size={14} aria-hidden="true" />}</span>
            </DropdownMenu.Item>
            {workspace.scopes.length > 0 && <DropdownMenu.Separator className="dropdown-separator" />}
            {shown.map(candidate => {
              const candidateTrail = scopeTrail(workspace.scopes, candidate);
              return <DropdownMenu.Item key={candidate.id} className="dropdown-item" title={tildePath(candidate.path)}
                onSelect={() => chooseScope(workspace.id, candidate.id)}>
                {candidate.isGitRepo ? <GitBranch size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />}
                <span className="sidebar-scope-menu-name">
                  {candidateTrail.parent && <span className="sidebar-scope-menu-parent">{candidateTrail.parent} / </span>}
                  {candidateTrail.label}
                </span>
                <span className="sidebar-scope-menu-count">{counts.get(candidate.id) ?? 0}</span>
                <span className="sidebar-scope-menu-check">{candidate.id === scope?.id && <Check size={14} aria-hidden="true" />}</span>
              </DropdownMenu.Item>;
            })}
            {needle && !shown.length && <p className="sidebar-scope-menu-empty">No scope matches “{query.trim()}”.</p>}
            <DropdownMenu.Separator className="dropdown-separator" />
            <DropdownMenu.Item className="dropdown-item" onSelect={() => void addScope()}><Plus size={14} aria-hidden="true" />Add scope</DropdownMenu.Item>
            <DropdownMenu.Item className="dropdown-item" onSelect={() => openWorkspaceSettings(workspace.id, 'scopes')}><Settings size={14} aria-hidden="true" />Manage scopes…</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {scope && <button className="sidebar-scope-filter-clear" aria-label="Show all scopes" title="Show all scopes"
        onClick={() => chooseScope(workspace.id, null)}><X size={12} aria-hidden="true" /></button>}
    </div>
    {error && <p className="sidebar-error" role="alert" title={error}>{error}</p>}
  </>;
}
