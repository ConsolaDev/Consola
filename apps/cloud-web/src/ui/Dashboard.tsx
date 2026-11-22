import { Settings } from 'lucide-react';
import { useRef, useSyncExternalStore } from 'react';
import { chooseSection, hashOfSection } from '../domain/sections';
import { SETTINGS_SECTION_ID } from '../domain/settings';
import { currentSectionId, onSectionChange, openSection } from '../services/address';
import { SECTIONS, type SectionProps } from './sections';
import { SettingsDialog } from './SettingsDialog';

const subscribe = (changed: () => void) => onSectionChange(() => changed());

/** The section the address names, kept in step with it. */
function useSectionId(): string | null {
  return useSyncExternalStore(subscribe, currentSectionId);
}

/**
 * The open workspace's pages: the nav of `SECTIONS`, and the section the address names beside
 * it. A link changes the address and the address picks the section, so a reload, a shared link
 * and the browser's back and forward all land where they point.
 *
 * A section is keyed by the workspace too, so switching workspaces starts it again rather than
 * showing what it loaded for the last one.
 *
 * Settings is no section: the nav's last link opens it as a dialog over the section that was
 * open (`#/settings/<page>`), as in the desktop app, and closing it goes back to that section.
 * An address that opens Settings directly (cloud-global's GitHub callback) has the first
 * section behind it.
 */
export function Dashboard({ me, workspace }: SectionProps) {
  const wanted = useSectionId();
  const settingsOpen = wanted === SETTINGS_SECTION_ID;
  // The section under Settings: the last one the address named before it opened.
  const behind = useRef<string | null>(null);
  if (!settingsOpen) behind.current = wanted;
  const section = chooseSection(SECTIONS, settingsOpen ? behind.current : wanted);
  const { View } = section;

  return (
    <div className="dashboard">
      <title>{`${settingsOpen ? 'Settings' : section.label} · ${workspace.name} · Consola Cloud`}</title>
      <nav className="dashboard-nav" aria-label="Workspace">
        <ul>
          {SECTIONS.map(({ id, label }) => (
            <li key={id}>
              <a
                className="nav-link"
                href={hashOfSection(id)}
                aria-current={id === section.id && !settingsOpen ? 'page' : undefined}
              >
                {label}
              </a>
            </li>
          ))}
          <li className="dashboard-nav-settings">
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
      <div className="dashboard-content">
        <View key={`${workspace.id} ${section.id}`} me={me} workspace={workspace} />
      </div>
      {settingsOpen && (
        <SettingsDialog
          key={workspace.id}
          me={me}
          workspace={workspace}
          onClose={() => openSection(section.id)}
        />
      )}
    </div>
  );
}
