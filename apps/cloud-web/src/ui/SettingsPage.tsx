import { useSyncExternalStore } from 'react';
import { chooseSection } from '../domain/sections';
import { hashOfSettingsPage } from '../domain/settings';
import { currentSettingsPageId, onSettingsPageChange } from '../services/settingsAddress';
import type { SectionProps } from './sections';
import { SETTINGS_PAGES } from './settingsPages';
import './SettingsPage.css';

const subscribe = (changed: () => void) => onSettingsPageChange(() => changed());

/** The settings page the address names, kept in step with it. */
function useSettingsPageId(): string | null {
  return useSyncExternalStore(subscribe, currentSettingsPageId);
}

/**
 * The workspace's settings: a row of tabs, one per page of `SETTINGS_PAGES`, and the page the
 * address names (`#/settings/<page>`) under it. Like the dashboard's sections, a tab is a plain
 * link and the address picks the page, so a reload, a link and back and forward land where they
 * point. Every member sees every page; each page shows its own controls by what the server
 * answers.
 */
export function SettingsPage({ me, workspace }: SectionProps) {
  const page = chooseSection(SETTINGS_PAGES, useSettingsPageId());
  const { View } = page;

  return (
    <>
      <header className="section-header">
        <h1 className="section-title">Settings</h1>
      </header>
      <nav className="settings-tabs" aria-label="Settings">
        <ul>
          {SETTINGS_PAGES.map(({ id, label }) => (
            <li key={id}>
              <a
                className="settings-tab"
                href={hashOfSettingsPage(id)}
                aria-current={id === page.id ? 'page' : undefined}
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <View key={page.id} me={me} workspace={workspace} />
    </>
  );
}
