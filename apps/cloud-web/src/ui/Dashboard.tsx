import { useSyncExternalStore } from 'react';
import { chooseSection, hashOfSection } from '../domain/sections';
import { currentSectionId, onSectionChange } from '../services/address';
import { SECTIONS, type SectionProps } from './sections';

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
 */
export function Dashboard({ me, workspace }: SectionProps) {
  const section = chooseSection(SECTIONS, useSectionId());
  const { View } = section;

  return (
    <div className="dashboard">
      <title>{`${section.label} · ${workspace.name} · Consola Cloud`}</title>
      <nav className="dashboard-nav" aria-label="Workspace">
        <ul>
          {SECTIONS.map(({ id, label }) => (
            <li key={id}>
              <a
                className="nav-link"
                href={hashOfSection(id)}
                aria-current={id === section.id ? 'page' : undefined}
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="dashboard-content">
        <View key={`${workspace.id} ${section.id}`} me={me} workspace={workspace} />
      </div>
    </div>
  );
}
