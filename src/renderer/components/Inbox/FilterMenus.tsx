// src/renderer/components/Inbox/FilterMenus.tsx
//
// Named FilterMenus.tsx rather than InboxFilters.tsx: on macOS's
// case-insensitive filesystem that would collide with inboxFilters.ts, the
// pure module these menus read their vocabulary from.
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import {
  INBOX_UPDATED_FILTERS,
  UPDATED_FILTER_LABELS,
  type InboxUpdatedFilter,
} from './inboxFilters';

interface RepoFilterMenuProps {
  /** Every repo in the snapshot, sorted -- the only things worth offering. */
  repos: string[];
  selected: string[];
  onChange: (repos: string[]) => void;
}

/**
 * GitHub's "Select repositories": a multi-select over what the snapshot
 * actually holds. Toggling keeps the menu open (Radix closes on select by
 * default, which makes picking three repos three trips), and an empty
 * selection reads as "all" rather than "none".
 */
export function RepoFilterMenu({ repos, selected, onChange }: RepoFilterMenuProps) {
  const label =
    selected.length === 0
      ? 'Select repositories'
      : selected.length === 1
        ? selected[0]
        : `${selected.length} repositories`;

  const toggle = (repo: string, checked: boolean) => {
    onChange(checked ? [...selected, repo] : selected.filter((candidate) => candidate !== repo));
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={`inbox-filter-trigger inbox-repo-filter-trigger ${
            selected.length > 0 ? 'active' : ''
          }`}
          disabled={repos.length === 0}
          title={repos.length === 0 ? 'No repositories in the inbox yet' : undefined}
        >
          <span className="inbox-filter-trigger-label">{label}</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content inbox-filter-menu"
          sideOffset={6}
          align="start"
        >
          {repos.map((repo) => (
            <DropdownMenu.CheckboxItem
              key={repo}
              className="dropdown-item inbox-filter-item"
              checked={selected.includes(repo)}
              onCheckedChange={(checked) => toggle(repo, checked === true)}
              // Keep the menu open: a multi-select that closes on every tick
              // is a single-select with extra steps.
              onSelect={(event) => event.preventDefault()}
            >
              <span className="inbox-filter-item-indicator" aria-hidden="true">
                <DropdownMenu.ItemIndicator>
                  <Check size={12} />
                </DropdownMenu.ItemIndicator>
              </span>
              <span>{repo}</span>
            </DropdownMenu.CheckboxItem>
          ))}
          {selected.length > 0 && (
            <>
              <DropdownMenu.Separator className="dropdown-separator" />
              <DropdownMenu.Item className="dropdown-item" onSelect={() => onChange([])}>
                <span className="inbox-filter-item-indicator" aria-hidden="true" />
                <span>Clear selection</span>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

interface UpdatedFilterMenuProps {
  value: InboxUpdatedFilter;
  onChange: (value: InboxUpdatedFilter) => void;
}

/** GitHub's "Updated" range: one of four windows, single-select, closes on pick. */
export function UpdatedFilterMenu({ value, onChange }: UpdatedFilterMenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="inbox-filter-trigger inbox-updated-filter-trigger">
          <span className="inbox-filter-trigger-label">Updated: {UPDATED_FILTER_LABELS[value]}</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content inbox-filter-menu"
          sideOffset={6}
          align="start"
        >
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onChange(next as InboxUpdatedFilter)}
          >
            {INBOX_UPDATED_FILTERS.map((range) => (
              <DropdownMenu.RadioItem
                key={range}
                className="dropdown-item inbox-filter-item"
                value={range}
              >
                <span className="inbox-filter-item-indicator" aria-hidden="true">
                  <DropdownMenu.ItemIndicator>
                    <Check size={12} />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span>{UPDATED_FILTER_LABELS[range]}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
