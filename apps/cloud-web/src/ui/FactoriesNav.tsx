import { ChevronDown, FileCode, type LucideIcon, Plus, Settings2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { FactoriesState, Factory } from '../domain/factories';
import {
  FACTORY_PAGE_LABELS,
  foldLabel,
  LOADING_FACTORIES,
  NO_FACTORIES,
  sidebarLineForFactoriesState,
  UNSAVED_EDITS,
} from '../domain/factoryMessages';
import {
  FACTORY_PAGES,
  type FactoryPageId,
  hashOfFactoryPage,
  isUnfolded,
  withFold,
} from '../domain/factoryNav';
import type { MyWorkspace } from '../domain/workspace';
import { readUnfolded, writeUnfolded } from '../services/foldStore';
import { FactoryTile } from './FactoryTile';
import { useHasUnsavedEdits } from './factoryDrafts';

/** Each page of a factory's icon in the sidebar, from the desktop's set. */
const PAGE_ICONS: Record<FactoryPageId, LucideIcon> = {
  definition: FileCode,
  settings: Settings2,
};

/**
 * The sidebar's Factories group: its heading, with + for a new factory, over every factory the
 * cell lists for the person, exactly as it lists them. A factory is a row (its tile and name)
 * that opens its first page and unfolds it, and a chevron that folds or unfolds it, the open one
 * included; under it, its pages. Arriving at a factory, by its row, a link or the address,
 * unfolds it. Which factories are unfolded is kept per workspace (`foldStore`), so mount this
 * keyed by the workspace. A factory open but folded marks its own row, so the person still sees
 * where they are.
 *
 * What could not be listed is one quiet line under the heading, with Try again where it helps,
 * never a page's error.
 */
export function FactoriesNav({
  workspace,
  state,
  open,
  current,
  onNew,
  onRetry,
}: {
  workspace: MyWorkspace;
  state: FactoriesState | null;
  /** The factory page the dashboard shows, under Settings too. */
  open: { factoryId: string; page: FactoryPageId } | null;
  /** Whether that page is the one on screen, rather than under Settings. */
  current: boolean;
  onNew: () => void;
  onRetry: () => void;
}) {
  const headingId = useId();
  const [unfolded, setUnfolded] = useState(() => readUnfolded(workspace.id));
  const openId = open?.factoryId ?? null;

  useEffect(() => {
    writeUnfolded(workspace.id, unfolded);
  }, [workspace.id, unfolded]);

  // Arriving at a factory unfolds it, however the person got there; they may fold it again.
  useEffect(() => {
    if (openId !== null) setUnfolded((now) => withFold(now, openId, true));
  }, [openId]);

  function fold(factoryId: string, show: boolean) {
    setUnfolded((now) => withFold(now, factoryId, show));
  }

  return (
    <section className="sidebar-group" aria-labelledby={headingId}>
      <div className="sidebar-group-header">
        <h2 id={headingId} className="sidebar-group-title">
          Factories
        </h2>
        <button
          type="button"
          className="sidebar-group-button"
          aria-label="New factory"
          title={state?.kind === 'listed' ? 'New factory' : 'New factory, once factories load'}
          disabled={state?.kind !== 'listed'}
          onClick={onNew}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>

      {state === null && (
        <p className="sidebar-note" role="status">
          {LOADING_FACTORIES}
        </p>
      )}

      {state && state.kind !== 'listed' && (
        <p className="sidebar-note" role="alert">
          {sidebarLineForFactoriesState(state, workspace)}{' '}
          {(state.kind === 'pending' || state.kind === 'unavailable') && (
            <button type="button" className="sidebar-note-action" onClick={onRetry}>
              Try again
            </button>
          )}
        </p>
      )}

      {state?.kind === 'listed' && state.factories.length === 0 && (
        <p className="sidebar-note">{NO_FACTORIES}</p>
      )}

      {state?.kind === 'listed' && state.factories.length > 0 && (
        <ul className="nav-list" aria-labelledby={headingId}>
          {state.factories.map((factory) => (
            <FactoryItem
              key={factory.id}
              workspaceId={workspace.id}
              factory={factory}
              open={open?.factoryId === factory.id ? open.page : null}
              current={current}
              unfolded={isUnfolded(factory.id, unfolded)}
              onFold={(show) => fold(factory.id, show)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One factory: its row, its chevron, and its pages under it when unfolded. Unsaved edits left on
 * its definition (`factoryDrafts`) put a dot on the Factory definition row, or on the factory's
 * own row while it is folded, so the person finds their way back to them.
 */
function FactoryItem({
  workspaceId,
  factory,
  open,
  current,
  unfolded,
  onFold,
}: {
  workspaceId: string;
  factory: Factory;
  /** The page of this factory the dashboard shows, or null when it shows none. */
  open: FactoryPageId | null;
  current: boolean;
  unfolded: boolean;
  onFold: (show: boolean) => void;
}) {
  const pagesId = useId();
  const unsaved = useHasUnsavedEdits(workspaceId, factory.id);
  return (
    <li className="factory-item">
      <div className="factory-row">
        <a
          className="nav-row factory-row-link"
          href={hashOfFactoryPage(factory.id)}
          // Folded, the factory open marks its own row, since its page's row is hidden.
          data-open={(open !== null && !unfolded) || undefined}
          onClick={() => onFold(true)}
        >
          <FactoryTile factory={factory} size={18} />
          <span className="nav-row-label factory-row-name">{factory.name}</span>
          {unsaved && !unfolded && <UnsavedMark />}
        </a>
        <button
          type="button"
          className="factory-row-toggle"
          aria-expanded={unfolded}
          aria-controls={unfolded ? pagesId : undefined}
          aria-label={foldLabel(factory.name, unfolded)}
          title={foldLabel(factory.name, unfolded)}
          onClick={() => onFold(!unfolded)}
        >
          <ChevronDown
            className="fold-chevron"
            size={12}
            aria-hidden="true"
            data-open={unfolded || undefined}
          />
        </button>
      </div>
      {unfolded && (
        <ul id={pagesId} className="factory-pages">
          {FACTORY_PAGES.map((page) => {
            const Icon = PAGE_ICONS[page];
            return (
              <li key={page}>
                <a
                  className="nav-row factory-page-link"
                  href={hashOfFactoryPage(factory.id, page)}
                  aria-current={current && open === page ? 'page' : undefined}
                  data-open={open === page || undefined}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span className="nav-row-label">{FACTORY_PAGE_LABELS[page]}</span>
                  {unsaved && page === 'definition' && <UnsavedMark />}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** A row's dot for unsaved edits, said to a screen reader after the row's name. */
function UnsavedMark() {
  return (
    <>
      <span className="nav-unsaved" aria-hidden="true" title={UNSAVED_EDITS} />
      <span className="sr-only">, {UNSAVED_EDITS.toLowerCase()}</span>
    </>
  );
}
