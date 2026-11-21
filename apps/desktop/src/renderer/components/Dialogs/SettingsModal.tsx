import { useId, type ReactNode } from 'react';
import { AppUpdatesSection } from '../AppUpdates';
import { SHELL_SHORTCUT_LABEL } from '../../utils/shellShortcut';
import { SIDE_PANEL_SHORTCUT_LABEL } from '../../utils/sidePanelShortcut';
import * as Dialog from '@radix-ui/react-dialog';
import {
  X,
  Sun,
  Moon,
  Monitor,
  Palette,
  Keyboard,
  Boxes,
  Folder,
  FolderGit2,
  Globe,
  Info,
  Minus,
  Plug,
  Plus,
  ListChecks,
  Sparkles,
  Tag,
  Trash2,
  MessagesSquare,
  type LucideIcon,
} from 'lucide-react';
import {
  useSettingsStore,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_MAX,
  type ThemeMode,
} from '../../stores/settingsStore';
import type { Workspace } from '../../stores/workspaceStore';
import { useTheme } from '../../hooks/useTheme';
import {
  BROWSER_SHORTCUT_LABEL,
  COMMAND_PALETTE_SHORTCUT_LABEL,
  isMac,
} from '../../utils/platform';
import { HarnessesSection } from '../Harnesses';
import { TerminalLinksControl } from '../Browser/TerminalLinksControl';
import { AutoSettleControl } from '../AutoSettle/AutoSettleControl';
import { WorktreeCleanupControl } from '../WorktreeCleanup/WorktreeCleanupControl';
import { WorktreeCleanupPanel } from '../WorktreeCleanup/WorktreeCleanupPanel';
import { ProviderBindingPanel } from '../Provider';
import { ManifestHeader } from '../WorkspaceSettings/ManifestHeader';
import { HarnessPanel } from '../WorkspaceSettings/HarnessPanel';
import { SessionTitlesPanel } from '../WorkspaceSettings/SessionTitlesPanel';
import { ScopesPanel } from '../WorkspaceSettings/ScopesPanel';
import { LabelsPanel } from '../WorkspaceSettings/LabelsPanel';
import { BrowserSettingsPanel } from '../WorkspaceSettings/BrowserSettingsPanel';
import { DangerZonePanel } from '../WorkspaceSettings/DangerZonePanel';
import { ActionsPanel } from '../WorkspaceSettings/ActionsPanel';
import { providerNavLabel } from '../WorkspaceSettings/navLabels';
import {
  APP_GROUP,
  WORKSPACE_GROUP,
  isWorkspaceSection,
  type SettingsSection,
  type WorkspaceSectionId,
} from './settingsSections';
import { SnoozeOptions } from '../Settings/SnoozeOptions';
import { SessionRowsOption } from '../Settings/SessionRowsOption';
import './styles.css';
// The workspace panels' own rules (ws-*) live with the panels.
import '../WorkspaceSettings/styles.css';

interface SettingsNavMeta {
  /** A function for the Provider entry, which is named by what is bound. */
  label: string | ((workspace: Workspace) => string);
  icon: LucideIcon;
  danger?: boolean;
}

// A Record, not a second array: TypeScript itself rejects a missing section
// id here, so typecheck proves every section has a label and an icon.
const NAV_META: Record<SettingsSection, SettingsNavMeta> = {
  appearance: { label: 'Appearance', icon: Palette },
  sessions: { label: 'Sessions', icon: ListChecks },
  appBrowser: { label: 'Browser links', icon: Globe },
  harnesses: { label: 'Harnesses', icon: Boxes },
  shortcuts: { label: 'Keyboard shortcuts', icon: Keyboard },
  updates: { label: 'Updates', icon: Monitor },
  general: { label: 'General', icon: Info },
  titles: { label: 'Sessions', icon: MessagesSquare },
  scopes: { label: 'Scopes', icon: Folder },
  provider: { label: providerNavLabel, icon: Plug },
  actions: { label: 'Actions', icon: Sparkles },
  labels: { label: 'Labels', icon: Tag },
  worktrees: { label: 'Worktrees', icon: FolderGit2 },
  browser: { label: 'Browser', icon: Globe },
  danger: { label: 'Danger zone', icon: Trash2, danger: true },
};

const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  /** The workspace this window is on. Null leaves the Workspace group out. */
  workspace: Workspace | null;
}

/**
 * Every setting, in one dialog. The list says whose each one is: the App
 * group is the same in every workspace, the Workspace group edits the one
 * this window is on and names it, and Updates sits apart at the bottom
 * because it is about the app itself rather than a preference.
 */
export function SettingsModal({
  open,
  onOpenChange,
  section,
  onSectionChange,
  workspace,
}: SettingsModalProps) {
  const { theme, setTheme, terminalFontSize, setTerminalFontSize } = useSettingsStore();
  useTheme();

  const navItem = (id: SettingsSection) => {
    const { label, icon: Icon, danger } = NAV_META[id];
    const isActive = section === id;
    // A label that needs the workspace is only ever rendered inside the
    // Workspace group, which is not there without one.
    const text = typeof label === 'string' ? label : workspace ? label(workspace) : '';
    return (
      <button
        key={id}
        type="button"
        className={['settings-modal-nav-item', isActive && 'active', danger && 'danger']
          .filter(Boolean)
          .join(' ')}
        aria-current={isActive ? 'true' : undefined}
        onClick={() => onSectionChange(id)}
      >
        <Icon size={16} />
        <span>{text}</span>
      </button>
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay settings-modal-overlay" />
        <Dialog.Content
          className="settings-modal-content"
          // Focus starts on the section being shown, not on the top of the
          // list: a door that opens Scopes should not leave the keyboard on
          // Appearance, one Enter away from leaving it.
          onOpenAutoFocus={(event) => {
            const current = event.currentTarget;
            if (!(current instanceof HTMLElement)) return;
            const active = current.querySelector<HTMLElement>(
              '.settings-modal-nav-item[aria-current="true"]',
            );
            if (!active) return;
            event.preventDefault();
            active.focus();
          }}
        >
          <Dialog.Title className="sr-only">Settings</Dialog.Title>

          <nav className="settings-modal-nav" aria-label="Settings sections">
            <div className="settings-modal-nav-header">Settings</div>
            <NavGroup label="App">{APP_GROUP.map(navItem)}</NavGroup>
            {workspace && (
              <NavGroup label="Workspace" name={workspace.name}>
                {WORKSPACE_GROUP.map(navItem)}
              </NavGroup>
            )}
            <div className="settings-modal-nav-footer">{navItem('updates')}</div>
          </nav>

          <div className="settings-modal-body">
            {section === 'appearance' && (
              <AppearanceSection
                theme={theme}
                setTheme={setTheme}
                terminalFontSize={terminalFontSize}
                setTerminalFontSize={setTerminalFontSize}
              />
            )}
            {section === 'sessions' && <SessionsSection />}
            {section === 'appBrowser' && <AppBrowserSection />}
            {section === 'harnesses' && <HarnessesSection />}
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'updates' && <AppUpdatesSection />}
            {/* Keyed by workspace: no draft, open rename or pending
                confirmation survives into another workspace's record. */}
            {workspace && isWorkspaceSection(section) && (
              <WorkspaceSection key={workspace.id} workspace={workspace} section={section} />
            )}
          </div>

          <Dialog.Close asChild>
            <button className="dialog-close" aria-label="Close">
              <X size={16} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * One heading and the sections under it. The Workspace group's heading
 * carries the workspace's name, so what belongs to this workspace never
 * reads as an app-wide setting.
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
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; these are navigation buttons.
    <div className="settings-modal-nav-group" role="group" aria-labelledby={headingId}>
      <div id={headingId} className="settings-modal-nav-group-label" title={name}>
        {name ? `${label} · ${name}` : label}
      </div>
      {children}
    </div>
  );
}

function WorkspaceSection({
  workspace,
  section,
}: {
  workspace: Workspace;
  section: WorkspaceSectionId;
}) {
  return (
    <div className="settings-modal-section">
      {section === 'general' && (
        <>
          <ManifestHeader workspace={workspace} />
          <HarnessPanel workspace={workspace} />
        </>
      )}
      {section === 'titles' && <SessionTitlesPanel workspace={workspace} />}
      {section === 'scopes' && <ScopesPanel workspace={workspace} />}
      {section === 'provider' && (
        <section className="ws-panel">
          <ProviderBindingPanel workspace={workspace} />
        </section>
      )}
      {section === 'actions' && <ActionsPanel workspace={workspace} />}
      {section === 'labels' && <LabelsPanel workspace={workspace} />}
      {section === 'worktrees' && <WorktreeCleanupPanel workspace={workspace} />}
      {section === 'browser' && <BrowserSettingsPanel workspace={workspace} />}
      {section === 'danger' && <DangerZonePanel workspace={workspace} />}
    </div>
  );
}

function AppearanceSection({
  theme,
  setTheme,
  terminalFontSize,
  setTerminalFontSize,
}: {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
}) {
  return (
    <div className="settings-modal-section">
      <h2 className="settings-modal-section-title">Appearance</h2>
      <div className="settings-modal-option">
        <div className="settings-modal-option-info">
          <span className="settings-modal-option-label">Theme</span>
          <span className="settings-modal-option-description">
            Select your preferred color theme
          </span>
        </div>
        <div className="settings-modal-theme-selector">
          {themeOptions.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              className={`settings-modal-theme-button ${theme === value ? 'active' : ''}`}
              onClick={() => setTheme(value)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-modal-option">
        <div className="settings-modal-option-info">
          <span className="settings-modal-option-label">Terminal font size</span>
          <span className="settings-modal-option-description">
            Larger text is markedly easier to read on a non-Retina display
          </span>
        </div>
        <div className="settings-modal-stepper">
          <button
            className="settings-modal-stepper-button"
            onClick={() => setTerminalFontSize(terminalFontSize - 1)}
            disabled={terminalFontSize <= TERMINAL_FONT_SIZE_MIN}
            aria-label="Decrease terminal font size"
          >
            <Minus size={14} />
          </button>
          <span className="settings-modal-stepper-value">{terminalFontSize}px</span>
          <button
            className="settings-modal-stepper-button"
            onClick={() => setTerminalFontSize(terminalFontSize + 1)}
            disabled={terminalFontSize >= TERMINAL_FONT_SIZE_MAX}
            aria-label="Increase terminal font size"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionsSection() {
  return (
    <div className="settings-modal-section">
      <h2 className="settings-modal-section-title">Sessions</h2>
      <SessionRowsOption />
      <div className="settings-modal-option">
        <div className="settings-modal-option-info">
          <span className="settings-modal-option-label">Settle idle sessions</span>
          <span className="settings-modal-option-description">
            Sessions with nothing happening move to the Settled shelf after this long, and new
            activity brings a session back. A session that never had a message, and has no page
            open, is removed instead. Choose Off to keep every session where it is.
          </span>
        </div>
        <AutoSettleControl />
      </div>
      <div className="settings-modal-option">
        <div className="settings-modal-option-info">
          <span className="settings-modal-option-label">Remove a session’s worktree when</span>
          <span className="settings-modal-option-description">
            Each rule is off until you turn it on. Consola never removes a worktree with changes,
            unpushed commits, files that exist only there, or anything still running in it. Unless
            the session was deleted, it stays, and its worktree is rebuilt when you open it. A
            workspace can set rules of its own under Workspace → Worktrees.
          </span>
        </div>
        <WorktreeCleanupControl />
      </div>
      <SnoozeOptions />
    </div>
  );
}

function AppBrowserSection() {
  return (
    <div className="settings-modal-section">
      <h2 className="settings-modal-section-title">Browser links</h2>
      <div className="settings-modal-option">
        <div className="settings-modal-option-info">
          <span className="settings-modal-option-label">Links in the terminal</span>
          <span className="settings-modal-option-description">
            Where a link opens when you click it in a session’s terminal or shell. Hold Shift while
            you click to do the opposite, once. Links that are not web pages always go to the
            system.
          </span>
        </div>
        <TerminalLinksControl />
      </div>
    </div>
  );
}

function ShortcutsSection() {
  // Mirrors what useKeyboardShortcuts actually binds -- nothing aspirational.
  const mod = isMac ? '⌘' : 'Ctrl+';
  const shift = isMac ? '⇧' : 'Shift+';
  const shortcuts = [
    { label: 'Command palette', key: COMMAND_PALETTE_SHORTCUT_LABEL },
    { label: 'New session', key: `${mod}N` },
    { label: 'New session with options', key: isMac ? '⇧⌘N' : 'Ctrl+Shift+N' },
    { label: 'New window', key: isMac ? '⌥⌘N' : 'Ctrl+Alt+N' },
    { label: 'Switch workspace by position', key: `${mod}1–9` },
    { label: 'Toggle sidebar', key: `${mod}\\` },
    { label: 'Files tab', key: `${mod}${shift}E` },
    { label: 'Toggle browser', key: BROWSER_SHORTCUT_LABEL },
    { label: 'Toggle terminal', key: SHELL_SHORTCUT_LABEL },
    { label: 'Show or hide the side panel', key: SIDE_PANEL_SHORTCUT_LABEL },
    { label: 'Open settings', key: `${mod},` },
    { label: 'Cycle theme', key: `${mod}${shift}T` },
    { label: 'Rename session', key: 'F2' },
  ];

  return (
    <div className="settings-modal-section">
      <h2 className="settings-modal-section-title">Keyboard shortcuts</h2>
      <div className="settings-modal-shortcuts">
        {shortcuts.map(({ label, key }) => (
          <div key={label} className="settings-modal-shortcut">
            <span className="settings-modal-shortcut-label">{label}</span>
            <kbd className="settings-modal-shortcut-key">{key}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
