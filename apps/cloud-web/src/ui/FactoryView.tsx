import { Fragment, lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import type { FactoriesState } from '../domain/factories';
import { owningTeam } from '../domain/factories';
import {
  DEFINITION_NOT_LOADED,
  FACTORY_GONE,
  messageForFactoriesState,
  sourceName,
  teamLabel,
} from '../domain/factoryMessages';
import type { FactoryPageId } from '../domain/factoryNav';
import type { MyWorkspace } from '../domain/workspace';
import { FactorySettingsPage } from './FactorySettingsPage';
import { FactoryTile } from './FactoryTile';
import './FactoryView.css';

/**
 * A factory's page, as the address names it (`#/factories/<id>/<page>`): its definition, which
 * has the whole width and a bar of its own, or its settings, under the factory's tile and name
 * and a row of its facts (its team, where its files come from). The factory is the one the sidebar's list holds (`useFactories`),
 * so the two always agree: one missing from it is gone, or now belongs to a team the person is
 * not in, and the page says so. `onChanged` reads the list again.
 */
export function FactoryView({
  factoryId,
  page,
  state,
  personId,
  workspace,
  onChanged,
}: {
  factoryId: string;
  page: FactoryPageId;
  state: FactoriesState | null;
  personId: string;
  workspace: MyWorkspace;
  onChanged: () => Promise<void>;
}) {
  // The definition has the whole width (`factoryLayout`) and lays itself out; what stands in for
  // it until the factory is listed keeps a margin of its own there.
  const Frame = page === 'definition' ? WideFrame : Fragment;

  if (state === null) {
    return (
      <Frame>
        <p className="factory-quiet" role="status">
          Loading the factory…
        </p>
      </Frame>
    );
  }

  if (state.kind !== 'listed') {
    return (
      <Frame>
        <div className="factory-notice">
          <p role="alert">{messageForFactoriesState(state)}</p>
          {state.kind === 'unavailable' && (
            <button type="button" className="button" onClick={() => void onChanged()}>
              Try again
            </button>
          )}
        </div>
      </Frame>
    );
  }

  const factory = state.factories.find((listed) => listed.id === factoryId);
  if (!factory) {
    return (
      <Frame>
        <div className="factory-notice">
          <p role="alert">{FACTORY_GONE}</p>
        </div>
      </Frame>
    );
  }

  if (page === 'definition') {
    return (
      <Suspense
        fallback={
          <WideFrame>
            <p className="factory-quiet" role="status">
              Loading its files…
            </p>
          </WideFrame>
        }
      >
        <FactoryDefinitionPage
          factory={factory}
          personId={personId}
          workspace={workspace}
          onChanged={onChanged}
        />
      </Suspense>
    );
  }

  return (
    <>
      <header className="factory-head">
        <FactoryTile factory={factory} size={36} />
        <div className="factory-head-text">
          <h1 className="factory-name">{factory.name}</h1>
          <div className="factory-facts">
            <span>
              <span className="sr-only">Team: </span>
              {teamLabel(owningTeam(factory, state.teams))}
            </span>
            <span>{sourceName(factory.source.kind)}</span>
          </div>
        </div>
      </header>

      <FactorySettingsPage
        factory={factory}
        teams={state.teams}
        workspace={workspace}
        onChanged={onChanged}
      />
    </>
  );
}

// The definition carries the editor and the schema's checker, so it loads only when it opens.
const FactoryDefinitionPage = lazy(() =>
  import('./FactoryDefinitionPage').then(
    (module) => ({ default: module.FactoryDefinitionPage }),
    () => ({ default: DefinitionNotLoaded }),
  ),
);

/** Where the definition would be, when its code could not be loaded. */
function DefinitionNotLoaded() {
  return (
    <WideFrame>
      <div className="factory-notice">
        <p role="alert">{DEFINITION_NOT_LOADED}</p>
      </div>
    </WideFrame>
  );
}

/** The margin a wide page's stand-ins keep. */
function WideFrame({ children }: { children: ReactNode }) {
  return <div className="factory-wide-frame">{children}</div>;
}

/**
 * How a factory's page sits beside the sidebar: the definition takes the whole width, as Runs
 * does, and Settings the reading column.
 */
export function factoryLayout(page: FactoryPageId): 'wide' | undefined {
  return page === 'definition' ? 'wide' : undefined;
}
