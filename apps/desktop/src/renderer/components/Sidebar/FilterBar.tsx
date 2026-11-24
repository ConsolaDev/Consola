import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Check,
  ChevronDown,
  Folder,
  GitBranch,
  ListFilter,
  Pencil,
  Plus,
  Settings,
  X,
} from 'lucide-react';
import { EditLabelDialog } from '../Dialogs/EditLabelDialog';
import type { Label } from '../../../shared/workspace';
import type { Workspace } from '../../stores/workspaceStore';
import { useSessionFilterStore } from '../../stores/sessionFilterStore';
import { deriveFacets, effectiveFilters, hasActiveFilters } from '../../utils/sessionFilters';
import type { FacetKey, FacetValue } from '../../utils/sessionFilters';
import { filteredScope, useHomeStore } from '../../stores/homeStore';
import { useSettings } from '../../contexts/SettingsContext';
import { addScopeViaDialog } from '../../utils/scopeActions';
import { chooseScope, clearAllFilters } from '../../utils/sessionActions';
import { isSessionDrag, leftDropTarget } from './sessionDrag';
import {
  createAndSelectLabel,
  deleteLabelWithUndo,
  dropSessionOnLabel,
} from '../../utils/labelActions';
import { scopeTrail } from '../../utils/scopeTrail';
import { tildePath } from '../../utils/displayPath';

/** Past this many scopes, the menu leads with a search field. */
const SEARCH_THRESHOLD = 8;

const FACET_TITLES: Record<Exclude<FacetKey, 'label' | 'readOnly'>, string> = {
  harness: 'Harness',
  model: 'Model',
  automation: 'Started by',
  repo: 'Repository',
};

/**
 * The one filter control for the session list, from two sources: facets
 * derived from fields a session already has (scope, harness, model, the
 * automation that started it, its work item's repo, read-only) and the
 * labels a person made. Scope is one facet among the rest; ScopesPanel is
 * where scopes are managed.
 *
 * It sits under Automations, inside the part of the sidebar it filters,
 * because a control reads as governing whatever sits under it, and search,
 * Home, Inbox and Automations are workspace-wide. Filtering only hides
 * rows: which section a row is in is never this bar's call.
 *
 * With nothing chosen the bar has no fill. A narrowed list tints it and lists
 * the choices as chips, each one a × away from gone.
 *
 * `accessory` sits at the row's end, beside the filter rather than inside it:
 * the navigation settings, which shape the same list this row narrows.
 */
export function FilterBar({
  workspace,
  accessory,
}: {
  workspace: Workspace;
  accessory?: ReactNode;
}) {
  const filterId = useHomeStore((state) => state.scopeFilters[workspace.id]);
  const scope = filteredScope(workspace, filterId);
  const trail = scope ? scopeTrail(workspace.scopes, scope) : undefined;
  const { openSettings } = useSettings();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<Label | null>(null);
  const chosen = useSessionFilterStore((state) => state.filters[workspace.id]);
  const { toggle } = useSessionFilterStore.getState();
  const [dropChip, setDropChip] = useState<string | null>(null);

  // The same sessions the list shows for each scope, so a count never
  // promises a row that isn't there.
  const counts = new Map<string, number>();
  for (const session of workspace.sessions) {
    if (session.name.length > 0)
      counts.set(session.scopeId, (counts.get(session.scopeId) ?? 0) + 1);
  }
  const listed = workspace.sessions.filter((session) => session.name.length > 0);
  const facets = deriveFacets(listed);
  const active = effectiveFilters(workspace, listed, chosen);
  const isActive = (key: FacetKey, value: string) => active[key]?.includes(value) ?? false;
  const labelCounts = new Map<string, number>();
  for (const session of listed)
    for (const id of session.labelIds ?? []) labelCounts.set(id, (labelCounts.get(id) ?? 0) + 1);
  const narrowed = !!scope || hasActiveFilters(active);
  const chips = Object.entries(active).flatMap(([key, values]) =>
    (values ?? []).map((value) => ({
      key: key as FacetKey,
      value,
      text:
        key === 'label'
          ? (workspace.labels.find((label) => label.id === value)?.name ?? value)
          : key === 'readOnly'
            ? 'Read-only'
            : value,
    })),
  );
  const searchable = workspace.scopes.length > SEARCH_THRESHOLD;
  const needle = query.trim().toLowerCase();
  const shown =
    searchable && needle
      ? workspace.scopes.filter(
          (candidate) =>
            candidate.name.toLowerCase().includes(needle) ||
            candidate.path.toLowerCase().includes(needle),
        )
      : workspace.scopes;

  const report = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));

  const addLabel = async () => {
    setError('');
    try {
      if (await createAndSelectLabel(workspace.id, newLabel)) setNewLabel('');
    } catch (reason) {
      report(reason);
    }
  };

  // Deleting takes the label off every session carrying it, from a menu whose
  // every other × only stops a filter — so it says what it did and offers the
  // way back, rather than asking first.
  const removeLabel = async (label: Label) => {
    setError('');
    try {
      await deleteLabelWithUndo(workspace.id, label);
    } catch (reason) {
      report(reason);
    }
  };

  // Picking a value narrows the list; the menu stays open so several can be picked.
  const facetItem = (key: FacetKey, entry: FacetValue, text = entry.value) => (
    <DropdownMenu.Item
      key={`${key}:${entry.value}`}
      className="dropdown-item"
      onSelect={(event) => {
        event.preventDefault();
        toggle(workspace.id, key, entry.value);
      }}
    >
      <span className="sidebar-scope-menu-name">{text}</span>
      <span className="sidebar-scope-menu-count">{entry.count}</span>
      <span className="sidebar-scope-menu-check">
        {isActive(key, entry.value) && <Check size={14} aria-hidden="true" />}
      </span>
    </DropdownMenu.Item>
  );

  const addScope = async () => {
    setError('');
    try {
      const added = await addScopeViaDialog(workspace.id);
      if (added) chooseScope(workspace.id, added.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  // The field owns its keys: Radix's typeahead would otherwise take each
  // letter as a jump to the item starting with it. ↓ steps into the list.
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.currentTarget
        .closest('[role="menu"]')
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus();
    }
    event.stopPropagation();
  };

  return (
    <>
      <div className="sidebar-filter-row">
        <div className={`sidebar-scope-filter ${narrowed ? 'is-filtered' : ''}`}>
          <DropdownMenu.Root
            open={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open);
              if (!open) setQuery('');
            }}
          >
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="sidebar-scope-filter-trigger"
                aria-label="Filter sessions"
                title={scope ? tildePath(scope.path) : undefined}
              >
                <ListFilter size={14} aria-hidden="true" />
                <span className="sidebar-scope-filter-label">
                  {trail?.parent && (
                    <>
                      <span className="sidebar-scope-filter-parent">{trail.parent}</span>
                      <span className="sidebar-scope-filter-slash" aria-hidden="true">
                        /
                      </span>
                    </>
                  )}
                  <span className="sidebar-scope-filter-name">{trail?.label ?? 'All scopes'}</span>
                </span>
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="dropdown-content sidebar-scope-menu"
                align="start"
                sideOffset={4}
                onCloseAutoFocus={(event) => {
                  if (editing) event.preventDefault();
                }}
              >
                {searchable && (
                  <input
                    className="sidebar-scope-menu-search"
                    type="search"
                    placeholder="Find a scope"
                    aria-label="Find a scope"
                    value={query}
                    autoFocus
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={onSearchKeyDown}
                  />
                )}
                <DropdownMenu.Label className="sidebar-scope-menu-heading">
                  Scope
                </DropdownMenu.Label>
                <DropdownMenu.Item
                  className="dropdown-item"
                  onSelect={() => chooseScope(workspace.id, null)}
                >
                  <span className="sidebar-scope-menu-name">All scopes</span>
                  <span className="sidebar-scope-menu-check">
                    {!scope && <Check size={14} aria-hidden="true" />}
                  </span>
                </DropdownMenu.Item>
                {workspace.scopes.length > 0 && (
                  <DropdownMenu.Separator className="dropdown-separator" />
                )}
                {shown.map((candidate) => {
                  const candidateTrail = scopeTrail(workspace.scopes, candidate);
                  return (
                    <DropdownMenu.Item
                      key={candidate.id}
                      className="dropdown-item"
                      title={tildePath(candidate.path)}
                      onSelect={() => chooseScope(workspace.id, candidate.id)}
                    >
                      {candidate.isGitRepo ? (
                        <GitBranch size={14} aria-hidden="true" />
                      ) : (
                        <Folder size={14} aria-hidden="true" />
                      )}
                      <span className="sidebar-scope-menu-name">
                        {candidateTrail.parent && (
                          <span className="sidebar-scope-menu-parent">
                            {candidateTrail.parent} /{' '}
                          </span>
                        )}
                        {candidateTrail.label}
                      </span>
                      <span className="sidebar-scope-menu-count">
                        {counts.get(candidate.id) ?? 0}
                      </span>
                      <span className="sidebar-scope-menu-check">
                        {candidate.id === scope?.id && <Check size={14} aria-hidden="true" />}
                      </span>
                    </DropdownMenu.Item>
                  );
                })}
                {needle && !shown.length && (
                  <p className="sidebar-scope-menu-empty">No scope matches “{query.trim()}”.</p>
                )}
                {(Object.keys(FACET_TITLES) as Array<keyof typeof FACET_TITLES>).map(
                  (key) =>
                    facets[key].length > 0 && (
                      <div key={key}>
                        <DropdownMenu.Separator className="dropdown-separator" />
                        <DropdownMenu.Label className="sidebar-scope-menu-heading">
                          {FACET_TITLES[key]}
                        </DropdownMenu.Label>
                        {facets[key].map((entry) => facetItem(key, entry))}
                      </div>
                    ),
                )}
                {facets.readOnly.length > 0 && (
                  <>
                    <DropdownMenu.Separator className="dropdown-separator" />
                    {facetItem('readOnly', facets.readOnly[0], 'Read-only sessions')}
                  </>
                )}
                <DropdownMenu.Separator className="dropdown-separator" />
                <DropdownMenu.Label className="sidebar-scope-menu-heading">
                  Labels
                </DropdownMenu.Label>
                {workspace.labels.map((label) => (
                  <DropdownMenu.Item
                    key={label.id}
                    className="dropdown-item"
                    onSelect={(event) => {
                      event.preventDefault();
                      toggle(workspace.id, 'label', label.id);
                    }}
                  >
                    <span className="sidebar-scope-menu-name">
                      {label.emoji ? `${label.emoji} ` : ''}
                      {label.name}
                    </span>
                    <span className="sidebar-scope-menu-count">
                      {labelCounts.get(label.id) ?? 0}
                    </span>
                    <span className="sidebar-scope-menu-check">
                      {isActive('label', label.id) && <Check size={14} aria-hidden="true" />}
                    </span>
                    <button
                      type="button"
                      className="sidebar-scope-filter-clear"
                      aria-label={`Edit label ${label.name}`}
                      title="Rename or set emoji"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuOpen(false);
                        setEditing(label);
                      }}
                    >
                      <Pencil size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="sidebar-scope-filter-clear"
                      aria-label={`Delete label ${label.name}`}
                      title="Delete label"
                      onClick={(event) => {
                        event.stopPropagation();
                        void removeLabel(label);
                      }}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </DropdownMenu.Item>
                ))}
                <input
                  className="sidebar-scope-menu-search"
                  type="text"
                  placeholder="New label"
                  aria-label="New label"
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void addLabel();
                    }
                    if (event.key !== 'Escape') event.stopPropagation();
                  }}
                />
                <DropdownMenu.Separator className="dropdown-separator" />
                <DropdownMenu.Item className="dropdown-item" onSelect={() => void addScope()}>
                  <Plus size={14} aria-hidden="true" />
                  Add scope
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="dropdown-item"
                  onSelect={() => openSettings('scopes')}
                >
                  <Settings size={14} aria-hidden="true" />
                  Manage scopes…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {narrowed && (
            <button
              type="button"
              className="sidebar-scope-filter-clear"
              aria-label="Clear filters"
              title="Clear filters"
              onClick={() => clearAllFilters(workspace.id)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
        {accessory}
      </div>
      {chips.length > 0 && (
        <div className="sidebar-filter-chips" aria-label="Active filters">
          {chips.map((chip) => {
            // A label chip is also where a session row can be dropped to give it
            // that label: buckets are derived, so a label is the one thing a drop
            // can assign.
            const isLabel = chip.key === 'label';
            const id = `${chip.key}:${chip.value}`;
            return (
              <button
                key={id}
                type="button"
                className={`sidebar-filter-chip ${dropChip === id ? 'drop-target' : ''}`}
                aria-label={`Remove filter ${chip.text}`}
                title="Remove filter"
                onClick={() => toggle(workspace.id, chip.key, chip.value)}
                onDragOver={
                  isLabel
                    ? (event) => {
                        if (!isSessionDrag(event)) return;
                        // Without preventDefault the browser refuses the drop outright.
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setDropChip(id);
                      }
                    : undefined
                }
                onDragLeave={
                  isLabel
                    ? (event) => {
                        if (leftDropTarget(event)) setDropChip(null);
                      }
                    : undefined
                }
                onDrop={
                  isLabel
                    ? (event) => {
                        setDropChip(null);
                        void dropSessionOnLabel(workspace.id, event, chip.value).catch(report);
                      }
                    : undefined
                }
              >
                {chip.text}
                <X size={10} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
      {editing && (
        <EditLabelDialog
          workspaceId={workspace.id}
          label={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {error && (
        <p className="sidebar-error" role="alert" title={error}>
          {error}
        </p>
      )}
    </>
  );
}
