import { Settings } from 'lucide-react';
import { useRef, useSyncExternalStore } from 'react';
import { chooseSection, hashOfSection } from '../domain/sections';
import { SETTINGS_SECTION_ID } from '../domain/settings';
import type { MyWorkspace } from '../domain/workspace';
import { currentSectionId, onSectionChange, openSection } from '../services/address';
import { AccountMenu } from './AccountMenu';
import { Footer } from './Footer';
import { SECTIONS, type SectionProps } from './sections';
import { SettingsDialog } from './SettingsDialog';
import { useSlidingHighlight } from './useSlidingHighlight';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

const subscribe = (changed: () => void) => onSectionChange(() => changed());

/** The section the address names, kept in step with it. */
function useSectionId(): string | null {
  return useSyncExternalStore(subscribe, currentSectionId);
}

/**
 * The open workspace's pages: a sidebar (the workspace's menu, the nav of `SECTIONS` with
 * Settings at its foot, and the account) beside the section the address names, laid out as the
 * desktop app's sidebar.
 * A link changes the address and the address picks the section, so a reload, a shared link and
 * the browser's back and forward all land where they point. `workspaces` is null when they
 * could not be listed.
 *
 * A section is keyed by the workspace too, so switching workspaces starts it again rather than
 * showing what it loaded for the last one.
 *
 * Settings is no section: the nav's last link opens it as a dialog over the section that was
 * open (`#/settings/<page>`), as in the desktop app, and closing it goes back to that section.
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
  const wanted = useSectionId();
  const settingsOpen = wanted === SETTINGS_SECTION_ID;
  // The section under Settings: the last one the address named before it opened.
  const behind = useRef<string | null>(null);
  if (!settingsOpen) behind.current = wanted;
  const section = chooseSection(SECTIONS, settingsOpen ? behind.current : wanted);
  const { View } = section;
  const { container, highlight } = useSlidingHighlight<HTMLElement>('.nav-link');

  return (
    <div className="shell">
      <title>{`${settingsOpen ? 'Settings' : section.label} · ${workspace.name} · Consola Cloud`}</title>
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
        <nav className="sidebar-nav" aria-label="Workspace" {...container}>
          <span className="nav-hover" {...highlight} />
          <ul className="nav-list">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <a
                  className="nav-link"
                  href={hashOfSection(id)}
                  aria-current={id === section.id && !settingsOpen ? 'page' : undefined}
                >
                  <Icon size={16} aria-hidden="true" />
                  {label}
                </a>
              </li>
            ))}
          </ul>
          <ul className="nav-list">
            <li>
              <a
                className="nav-link"
                href={hashOfSection(SETTINGS_SECTION_ID)}
                aria-current={settingsOpen ? 'page' : undefined}
              >
                <Settings size={16} aria-hidden="true" />
                Settings
              </a>
            </li>
          </ul>
        </nav>
        <div className="sidebar-foot">
          <AccountMenu user={me.user} />
        </div>
      </aside>
      <div className="content">
        <main className="content-inner" data-layout={section.layout}>
          <View
            key={`${workspace.id} ${section.id}`}
            me={me}
            workspace={workspace}
            onWorkspaceChanged={onSwitched}
          />
        </main>
        <Footer />
      </div>
      {settingsOpen && (
        <SettingsDialog
          key={workspace.id}
          me={me}
          workspace={workspace}
          onWorkspaceChanged={onSwitched}
          onClose={() => openSection(section.id)}
        />
      )}
    </div>
  );
}
