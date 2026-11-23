import type { FactoriesState } from '../domain/factories';
import { owningTeam } from '../domain/factories';
import {
  FACTORY_GONE,
  messageForFactoriesState,
  sourceName,
  teamLabel,
} from '../domain/factoryMessages';
import type { FactoryPageId } from '../domain/factoryNav';
import type { MyWorkspace } from '../domain/workspace';
import { FactoryDefinitionPage } from './FactoryDefinitionPage';
import { FactorySettingsPage } from './FactorySettingsPage';
import { FactoryTile } from './FactoryTile';
import './FactoryView.css';

/**
 * A factory's page, as the address names it (`#/factories/<id>/<page>`): the factory's tile and
 * name over a row of its facts (its team, where its files come from), then the page itself, its
 * definition or its settings. The factory is the one the sidebar's list holds (`useFactories`),
 * so the two always agree: one missing from it is gone, or now belongs to a team the person is
 * not in, and the page says so. `onChanged` reads the list again.
 */
export function FactoryView({
  factoryId,
  page,
  state,
  workspace,
  onChanged,
}: {
  factoryId: string;
  page: FactoryPageId;
  state: FactoriesState | null;
  workspace: MyWorkspace;
  onChanged: () => Promise<void>;
}) {
  if (state === null) {
    return (
      <p className="factory-quiet" role="status">
        Loading the factory…
      </p>
    );
  }

  if (state.kind !== 'listed') {
    return (
      <div className="factory-notice">
        <p role="alert">{messageForFactoriesState(state, workspace)}</p>
        {(state.kind === 'pending' || state.kind === 'unavailable') && (
          <button type="button" className="button" onClick={() => void onChanged()}>
            Try again
          </button>
        )}
      </div>
    );
  }

  const factory = state.factories.find((listed) => listed.id === factoryId);
  if (!factory) {
    return (
      <div className="factory-notice">
        <p role="alert">{FACTORY_GONE}</p>
      </div>
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

      {page === 'definition' && (
        <FactoryDefinitionPage
          key={factory.latestVersion}
          factory={factory}
          workspace={workspace}
          onGone={onChanged}
        />
      )}
      {page === 'settings' && (
        <FactorySettingsPage
          factory={factory}
          teams={state.teams}
          workspace={workspace}
          onChanged={onChanged}
        />
      )}
    </>
  );
}
