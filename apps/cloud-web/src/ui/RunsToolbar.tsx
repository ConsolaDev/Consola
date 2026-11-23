import { DropdownMenu } from '@radix-ui/themes';
import { ChevronDown, Factory, ListFilter, Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  automationsOffered,
  factoriesByTeam,
  hasFilters,
  isBackground,
  NO_FILTERS,
  type RunFilters,
  SEARCH_MAX,
  toggleBackground,
  toggleMine,
  togglePhase,
  toggleTrigger,
  withAutomation,
  withFactory,
  withSearch,
  withTeam,
} from '../domain/runFilters';
import { PHASES, type PhaseCounts, RUN_TRIGGERS, type RunFacets } from '../domain/runs';
import { PHASE_HINTS, PHASE_LABELS, triggerWords } from '../domain/runWords';

/** How long the search waits after a key before the list follows it. */
const SEARCH_SETTLE_MS = 250;

/**
 * The list's title and search, then a row of chips as Warp's Runs list has them: the factory
 * picker, My runs, a chip per phase with its count, Background runs, and a Filter menu for the
 * automation and the trigger. Every change goes to `onChange`, which puts it in the address.
 *
 * `counts` and `facets` are the cell's last answer, kept while a new one loads, so the row does
 * not jump as filters change; null before the first.
 */
export function RunsToolbar({
  filters,
  counts,
  facets,
  onChange,
}: {
  filters: RunFilters;
  counts: PhaseCounts | null;
  facets: RunFacets | null;
  onChange: (next: RunFilters) => void;
}) {
  return (
    <>
      <header className="runs-head">
        <h1 className="runs-title">Runs</h1>
        <SearchField filters={filters} onChange={onChange} />
      </header>
      <fieldset className="runs-chips">
        <legend className="sr-only">Filter runs</legend>
        <FactoryPicker filters={filters} facets={facets} onChange={onChange} />
        <span className="runs-chips-rule" aria-hidden="true" />
        <Chip pressed={filters.mine} onPress={() => onChange(toggleMine(filters))}>
          My runs
        </Chip>
        {PHASES.map((phase) => {
          const count = counts?.[phase];
          return (
            <Chip
              key={phase}
              pressed={filters.phases.includes(phase)}
              title={PHASE_HINTS[phase]}
              tone={phase === 'needs-you' && count ? 'needs-you' : undefined}
              onPress={() => onChange(togglePhase(filters, phase))}
            >
              {PHASE_LABELS[phase]}
              {count !== undefined && <span className="runs-chip-count">{count}</span>}
            </Chip>
          );
        })}
        <Chip
          pressed={isBackground(filters)}
          title="Runs a schedule, an event or a poll started"
          onPress={() => onChange(toggleBackground(filters))}
        >
          Background runs
        </Chip>
        <span className="runs-chips-end">
          <FilterMenu filters={filters} facets={facets} onChange={onChange} />
          {hasFilters(filters) && (
            <button type="button" className="runs-clear" onClick={() => onChange(NO_FILTERS)}>
              <X size={12} aria-hidden="true" />
              Clear
            </button>
          )}
        </span>
      </fieldset>
    </>
  );
}

function Chip({
  pressed,
  title,
  tone,
  onPress,
  children,
}: {
  pressed: boolean;
  title?: string;
  tone?: 'needs-you';
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="runs-chip"
      aria-pressed={pressed}
      title={title}
      data-tone={tone}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

/**
 * The search, as typed: the list follows once typing settles, and the address only then. `/`
 * from anywhere on the page that is not a field puts the keyboard here, as on GitHub and Warp.
 */
function SearchField({
  filters,
  onChange,
}: {
  filters: RunFilters;
  onChange: (next: RunFilters) => void;
}) {
  const [draft, setDraft] = useState(filters.q);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ filters, onChange });
  latest.current = { filters, onChange };

  // The address changed under the field (back, a link, Clear): show what it says now.
  useEffect(() => {
    setDraft((typed) => (typed.trim() === filters.q.trim() ? typed : filters.q));
  }, [filters.q]);

  useEffect(() => {
    if (draft.trim() === latest.current.filters.q.trim()) return;
    const timer = setTimeout(() => {
      latest.current.onChange(withSearch(latest.current.filters, draft));
    }, SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')) {
        return;
      }
      event.preventDefault();
      input.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <label className="runs-search">
      <Search size={14} aria-hidden="true" />
      <span className="sr-only">Search runs</span>
      <input
        ref={input}
        type="search"
        className="runs-search-input"
        placeholder="Search runs"
        maxLength={SEARCH_MAX}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && draft !== '') {
            event.preventDefault();
            setDraft('');
          }
        }}
      />
      {draft === '' && (
        <span className="runs-search-key" aria-hidden="true">
          /
        </span>
      )}
    </label>
  );
}

/** The factory picker: every factory, a whole team's, or one, the factories under their teams. */
function FactoryPicker({
  filters,
  facets,
  onChange,
}: {
  filters: RunFilters;
  facets: RunFacets | null;
  onChange: (next: RunFilters) => void;
}) {
  const factory = facets?.factories.find((candidate) => candidate.id === filters.factoryId);
  const team = facets?.teams.find((candidate) => candidate.id === filters.teamId);
  const label = filters.factoryId
    ? (factory?.name ?? 'A factory')
    : filters.teamId
      ? `${team?.name ?? 'A team'}’s factories`
      : 'All factories';
  const groups = facets ? factoriesByTeam(facets) : [];
  const narrowed = filters.factoryId !== null || filters.teamId !== null;
  const pickedValue = filters.factoryId
    ? `factory:${filters.factoryId}`
    : filters.teamId
      ? `team:${filters.teamId}`
      : 'all';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <button type="button" className="runs-chip runs-picker" data-active={narrowed || undefined}>
          <Factory size={13} aria-hidden="true" />
          <span className="runs-picker-label">{label}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" size="1" className="runs-menu">
        <DropdownMenu.RadioGroup value={pickedValue}>
          <DropdownMenu.RadioItem
            value="all"
            onSelect={() => onChange(withFactory(withTeam(filters, null), null))}
          >
            All factories
          </DropdownMenu.RadioItem>
          {groups.length === 0 && (
            <p className="runs-menu-note">{facets ? 'You see no factories yet.' : 'Loading…'}</p>
          )}
          {groups.map(({ team: owner, factories }) => (
            <DropdownMenu.Group key={owner?.id ?? 'other'}>
              <DropdownMenu.Separator />
              <DropdownMenu.Label>{owner?.name ?? 'Other teams'}</DropdownMenu.Label>
              {owner && (
                <DropdownMenu.RadioItem
                  value={`team:${owner.id}`}
                  onSelect={() => onChange(withTeam(filters, owner.id))}
                >
                  Everything in {owner.name}
                </DropdownMenu.RadioItem>
              )}
              {factories.map((candidate) => (
                <DropdownMenu.RadioItem
                  key={candidate.id}
                  value={`factory:${candidate.id}`}
                  onSelect={() => onChange(withFactory(filters, candidate.id))}
                >
                  <span className="runs-menu-name">{candidate.name}</span>
                  <span className="runs-menu-hint">v{candidate.latestVersion}</span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.Group>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/** The rest of the filters: the automation, and how runs were started. */
function FilterMenu({
  filters,
  facets,
  onChange,
}: {
  filters: RunFilters;
  facets: RunFacets | null;
  onChange: (next: RunFilters) => void;
}) {
  const automations = facets ? automationsOffered(facets, filters) : [];
  const factoryName = (id: string) => facets?.factories.find((f) => f.id === id)?.name ?? null;
  const picked = (filters.automation ? 1 : 0) + filters.triggers.length;
  const background = isBackground(filters);
  const automationKey = (automation: { factoryId: string; name: string }) =>
    `${automation.factoryId}/${automation.name}`;
  const automationValue =
    filters.automation === null
      ? ''
      : automationKey({ factoryId: filters.factoryId ?? '', name: filters.automation });

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <button
          type="button"
          className="runs-chip runs-filter"
          data-active={picked > 0 || undefined}
        >
          <ListFilter size={13} aria-hidden="true" />
          Filter
          {picked > 0 && !background && <span className="runs-chip-count">{picked}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" size="1" className="runs-menu">
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger>
            Automation
            {filters.automation && <span className="runs-menu-hint">{filters.automation}</span>}
          </DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent className="runs-menu">
            <DropdownMenu.RadioGroup value={automationValue}>
              <DropdownMenu.RadioItem
                value=""
                onSelect={() => onChange(withAutomation(filters, null))}
              >
                Any automation
              </DropdownMenu.RadioItem>
              {automations.length > 0 && <DropdownMenu.Separator />}
              {automations.map((automation) => (
                <DropdownMenu.RadioItem
                  key={automationKey(automation)}
                  value={automationKey(automation)}
                  onSelect={() => onChange(withAutomation(filters, automation))}
                >
                  <span className="runs-menu-name">{automation.name}</span>
                  {filters.factoryId === null && (
                    <span className="runs-menu-hint">{factoryName(automation.factoryId)}</span>
                  )}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            {facets && automations.length === 0 && (
              <p className="runs-menu-note">No automation has run here yet.</p>
            )}
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger>
            Started by
            {filters.triggers.length > 0 && (
              <span className="runs-menu-hint">
                {background ? 'Background' : filters.triggers.map(triggerWords).join(', ')}
              </span>
            )}
          </DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent className="runs-menu">
            {RUN_TRIGGERS.map((trigger) => (
              <DropdownMenu.CheckboxItem
                key={trigger}
                checked={filters.triggers.includes(trigger)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => onChange(toggleTrigger(filters, trigger))}
              >
                {triggerWords(trigger)}
              </DropdownMenu.CheckboxItem>
            ))}
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
