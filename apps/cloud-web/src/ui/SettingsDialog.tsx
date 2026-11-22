import { X } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { chooseSection } from '../domain/sections';
import { hashOfSettingsPage } from '../domain/settings';
import { currentSettingsPageId, onSettingsPageChange } from '../services/settingsAddress';
import type { SectionProps } from './sections';
import { SETTINGS_PAGES } from './settingsPages';
import './SettingsDialog.css';

const subscribe = (changed: () => void) => onSettingsPageChange(() => changed());

/**
 * Where a Radix overlay on a settings page renders. Radix puts a DropdownMenu's, Popover's,
 * Select's or Tooltip's content at the end of the page's body, which this modal dialog makes
 * inert: it shows, and takes no click. Hand `ref` to any element of the page, and `container` to
 * the overlay's content, which then renders inside the dialog (and inside the Theme, as the dialog
 * is).
 */
export function useSettingsMenuHost(): {
  ref: (element: HTMLElement | null) => void;
  container: HTMLElement | undefined;
} {
  const [container, setContainer] = useState<HTMLElement | undefined>(undefined);
  const ref = useCallback((element: HTMLElement | null) => {
    setContainer(element?.closest('dialog') ?? undefined);
  }, []);
  return { ref, container };
}

/** The settings page the address names, kept in step with it. */
function useSettingsPageId(): string | null {
  return useSyncExternalStore(subscribe, currentSettingsPageId);
}

/**
 * Every setting, in one dialog over the dashboard, laid out as the desktop app's: a list of its
 * pages on the left, under a group that names the workspace they belong to, and the page the
 * address names (`#/settings/<page>`) beside it. A page is a link and the address picks it, so a
 * reload, a link and back and forward land where they point. Escape and the close button call
 * `onClose`, which leaves the address for the section behind.
 */
export function SettingsDialog({ me, workspace, onClose }: SectionProps & { onClose: () => void }) {
  const page = chooseSection(SETTINGS_PAGES, useSettingsPageId());
  const { View } = page;
  const dialog = useRef<HTMLDialogElement>(null);

  // A modal dialog, so the dashboard behind it is inert, and the keyboard starts on the page's
  // own entry in the list, as the desktop app's does.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    element.querySelector<HTMLElement>('.settings-nav-item[aria-current="page"]')?.focus();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-label="Settings"
      onCancel={(event) => {
        // Escape: the address closes it, not the browser.
        event.preventDefault();
        onClose();
      }}
    >
      <nav className="settings-nav" aria-label="Settings pages">
        <div className="settings-nav-header">Settings</div>
        <NavGroup label="Workspace" name={workspace.name}>
          {SETTINGS_PAGES.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <a
                className="settings-nav-item"
                href={hashOfSettingsPage(id)}
                aria-current={id === page.id ? 'page' : undefined}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{label}</span>
              </a>
            </li>
          ))}
        </NavGroup>
      </nav>

      <div className="settings-body">
        <View key={page.id} me={me} workspace={workspace} />
      </div>

      <button
        type="button"
        className="settings-close"
        aria-label="Close settings"
        onClick={onClose}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </dialog>
  );
}

/**
 * One heading and the list of pages under it, the list named by the heading. The Workspace
 * group's heading carries the workspace's name, so what belongs to this workspace never reads as
 * the person's own setting.
 */
function NavGroup({
  label,
  name,
  children,
}: {
  label: string;
  name?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <div className="settings-nav-group">
      <div id={headingId} className="settings-nav-group-label" title={name}>
        {name ? `${label} · ${name}` : label}
      </div>
      <ul aria-labelledby={headingId}>{children}</ul>
    </div>
  );
}
