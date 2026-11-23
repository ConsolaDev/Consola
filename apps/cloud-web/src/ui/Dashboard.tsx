import { Settings } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FACTORY_PAGE_LABELS } from '../domain/factoryMessages';
import { factoryLanding, factoryRouteOfHash, hashOfFactoryPage } from '../domain/factoryNav';
import { chooseSection, hashOfSection, sectionIdOfHash } from '../domain/sections';
import { SETTINGS_SECTION_ID } from '../domain/settings';
import type { MyWorkspace } from '../domain/workspace';
import { currentHash, onHashChange, openHash, replaceHash } from '../services/address';
import { AccountMenu } from './AccountMenu';
import { FactoriesNav } from './FactoriesNav';
import { FactoryView } from './FactoryView';
import { Footer } from './Footer';
import { NewFactoryDialog } from './NewFactoryDialog';
import { SECTIONS, type SectionProps } from './sections';
import { SettingsDialog } from './SettingsDialog';
import { useFactories } from './useFactories';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/** The address's hash, kept in step with it. */
function useHash(): string {
  return useSyncExternalStore(onHashChange, currentHash);
}

/**
 * The open workspace's pages: a sidebar beside the page the address names, laid out and drawn
 * as the desktop app's sidebar. At its top the workspace's menu; then Overview (`SECTIONS`);
 * then the Factories group, every factory the person sees with its pages under it
 * (`FactoriesNav`, `#/factories/<id>/<page>`); Settings at the nav's foot; and the account.
 * Every row is a link and the address picks the page, so a reload, a shared link and the
 * browser's back and forward all land where they point. `workspaces` is null when they could not
 * be listed.
 *
 * The factories are read once here (`useFactories`) for the sidebar and a factory's page alike,
 * so the two always agree, and read again after any create, rename or move. `#/factories` alone
 * lands on the first factory's definition, or Overview when there is none. New factory is a
 * dialog over the dashboard, opened from the group's +.
 *
 * A page is keyed by the workspace too, so switching workspaces starts it again rather than
 * showing what it loaded for the last one.
 *
 * Settings is no page of its own: the nav's last link opens it as a dialog over the page that
 * was open (`#/settings/<page>`), as in the desktop app, and closing it goes back to that page.
 * An address that opens Settings directly (cloud-global's GitHub callback) has the first
 * section behind it.
 */
export function Dashboard({
  me,
  workspace,
  workspaces,
  onSwitched,
  onCreate,
}: Omit<SectionProps, 'onWorkspaceChanged'> & {
  workspaces: MyWorkspace[] | null;
  onSwitched: () => Promise<void>;
  onCreate: () => void;
}) {
  const hash = useHash();
  const settingsOpen = sectionIdOfHash(hash) === SETTINGS_SECTION_ID;
  // The page under Settings: the last address before it opened.
  const behind = useRef('');
  if (!settingsOpen) behind.current = hash;
  const shown = settingsOpen ? behind.current : hash;
  const factoryRoute = factoryRouteOfHash(shown);
  const section = chooseSection(SECTIONS, factoryRoute ? null : sectionIdOfHash(shown));
  const { View } = section;
  const factories = useFactories(workspace.id);
  const [creating, setCreating] = useState(false);
  const listed = factories.state?.kind === 'listed' ? factories.state : null;

  // `#/factories` alone names no page: it lands on the first factory, or the first section,
  // once the factories are read, in place of the address that named it.
  const landing = factoryRoute?.kind === 'landing' && !settingsOpen;
  const state = factories.state;
  useEffect(() => {
    if (!landing || state === null) return;
    const first = state.kind === 'listed' ? factoryLanding(state.factories) : null;
    replaceHash(first ?? hashOfSection(SECTIONS[0].id));
  }, [landing, state]);

  const openFactory = factoryRoute?.kind === 'page' ? factoryRoute : null;
  const openName = listed?.factories.find((factory) => factory.id === openFactory?.factoryId)?.name;
  const label = openFactory
    ? `${openName ?? 'Factory'} · ${FACTORY_PAGE_LABELS[openFactory.page]}`
    : section.label;

  return (
    <div className="shell">
      <title>{`${settingsOpen ? 'Settings' : label} · ${workspace.name} · Consola Cloud`}</title>
      <aside className="sidebar">
        <div className="sidebar-head">
          <WorkspaceSwitcher
            active={workspace}
            workspaces={workspaces}
            onSwitched={onSwitched}
            onCreate={onCreate}
            withSettings
          />
        </div>
        <nav className="sidebar-nav" aria-label="Workspace">
          <ul className="nav-list">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <a
                  className="nav-row nav-row-front"
                  href={hashOfSection(id)}
                  aria-current={
                    id === section.id && !factoryRoute && !settingsOpen ? 'page' : undefined
                  }
                >
                  <Icon size={14} aria-hidden="true" />
                  <span className="nav-row-label">{label}</span>
                </a>
              </li>
            ))}
          </ul>
          <FactoriesNav
            key={workspace.id}
            workspace={workspace}
            state={factories.state}
            open={openFactory}
            current={!settingsOpen}
            onNew={() => setCreating(true)}
            onRetry={() => void factories.reload()}
          />
          <ul className="nav-list nav-foot">
            <li>
              <a
                className="nav-row nav-row-settings"
                href={hashOfSection(SETTINGS_SECTION_ID)}
                aria-current={settingsOpen ? 'page' : undefined}
              >
                <Settings size={14} aria-hidden="true" />
                <span className="nav-row-label">Settings</span>
              </a>
            </li>
          </ul>
        </nav>
        <div className="sidebar-foot">
          <AccountMenu user={me.user} />
        </div>
      </aside>
      <div className="content">
        <main className="content-inner">
          {openFactory ? (
            <FactoryView
              key={`${workspace.id} ${openFactory.factoryId}`}
              factoryId={openFactory.factoryId}
              page={openFactory.page}
              state={factories.state}
              workspace={workspace}
              onChanged={factories.reload}
            />
          ) : factoryRoute?.kind === 'landing' ? (
            <p className="muted" role="status">
              Opening your factories…
            </p>
          ) : (
            <View
              key={`${workspace.id} ${section.id}`}
              me={me}
              workspace={workspace}
              onWorkspaceChanged={onSwitched}
            />
          )}
        </main>
        <Footer />
      </div>
      {settingsOpen && (
        <SettingsDialog
          key={workspace.id}
          me={me}
          workspace={workspace}
          onWorkspaceChanged={onSwitched}
          onClose={() =>
            openHash(
              sectionIdOfHash(behind.current) ? behind.current : hashOfSection(SECTIONS[0].id),
            )
          }
        />
      )}
      {creating && listed && (
        <NewFactoryDialog
          key={workspace.id}
          teams={listed.teams}
          workspace={workspace}
          onStale={factories.reload}
          onClose={() => setCreating(false)}
          onCreated={async (factory) => {
            await factories.reload();
            setCreating(false);
            openHash(hashOfFactoryPage(factory.id));
          }}
        />
      )}
    </div>
  );
}
