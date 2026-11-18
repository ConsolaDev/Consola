import { AppUpdatesSection } from '../AppUpdates';
import { SHELL_SHORTCUT_LABEL } from '../../utils/shellShortcut';
import { COMMAND_PALETTE_SHORTCUT_LABEL, isMac } from '../../utils/platform';
import { HarnessesSection } from '../Harnesses';
import { AutoSettleControl } from '../AutoSettle/AutoSettleControl';
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
  Info,
  Plug,
  Sparkles,
  Tag,
  Trash2,
  Minus,
  Plus,
  ListChecks,
  type LucideIcon,
} from 'lucide-react';
import {
  useSettingsStore,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_MAX,
  type ThemeMode,
} from '../../stores/settingsStore';
import { useTheme } from '../../hooks/useTheme';
import type { Workspace } from '../../stores/workspaceStore';
import { ProviderBindingPanel } from '../Provider';
import { ManifestHeader } from '../WorkspaceSettings/ManifestHeader';
import { HarnessPanel } from '../WorkspaceSettings/HarnessPanel';
import { ScopesPanel } from '../WorkspaceSettings/ScopesPanel';
import { LabelsPanel } from '../WorkspaceSettings/LabelsPanel';
import { DangerZonePanel } from '../WorkspaceSettings/DangerZonePanel';
import { ActionsPanel } from '../WorkspaceSettings/ActionsPanel';
import { providerNavLabel } from '../WorkspaceSettings/navLabels';
import { APP_GROUP, WORKSPACE_GROUP, isWorkspaceSection } from './settingsSections';
import type { SettingsSection, WorkspaceSectionId } from './settingsSections';
import './styles.css';
import '../WorkspaceSettings/styles.css';

interface SettingsSectionMeta {
  /** A function of the workspace: the Provider entry is named by what is bound. The App group's labels read nothing. */
  label: (workspace: Workspace | null) => string;
  icon: LucideIcon;
  danger?: boolean;
}

// A Record, not two arrays of configs: TypeScript itself rejects a missing or
// duplicate section id here, which is what would otherwise need a vitest
// test — npm run typecheck already proves completeness.
const NAV_META: Record<SettingsSection, SettingsSectionMeta> = {
  appearance: { label: () => 'Appearance', icon: Palette },
  sessions: { label: () => 'Sessions', icon: ListChecks },
  harnesses: { label: () => 'Harnesses', icon: Boxes },
  shortcuts: { label: () => 'Keyboard shortcuts', icon: Keyboard },
  general: { label: () => 'General', icon: Info },
  scopes: { label: () => 'Scopes', icon: Folder },
  provider: { label: providerNavLabel, icon: Plug },
  actions: { label: () => 'Actions', icon: Sparkles },
  labels: { label: () => 'Labels', icon: Tag },
  danger: { label: () => 'Danger zone', icon: Trash2, danger: true },
  updates: { label: () => 'Updates', icon: Monitor },
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
  /** The workspace this window is on. The Workspace group edits it and is shown only while there is one. */
  workspace: Workspace | null;
}

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
        <span>{label(workspace)}</span>
      </button>
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay settings-modal-overlay" />
        <Dialog.Content className="settings-modal-content">
          <Dialog.Title className="sr-only">Settings</Dialog.Title>

          <nav className="settings-modal-nav" aria-label="Settings sections">
            <div className="settings-modal-nav-header">Settings</div>
            <div
              role="group"
              aria-labelledby="settings-nav-app-group"
              className="settings-modal-nav-group"
            >
              <div id="settings-nav-app-group" className="settings-modal-nav-group-label">
                App
              </div>
              {APP_GROUP.map(navItem)}
            </div>
            {workspace && (
              <div
                role="group"
                aria-labelledby="settings-nav-workspace-group"
                className="settings-modal-nav-group"
              >
                <div
                  id="settings-nav-workspace-group"
                  className="settings-modal-nav-group-label settings-modal-nav-workspace-heading"
                >
                  Workspace ·{' '}
                  <span className="settings-modal-nav-workspace-name">{workspace.name}</span>
                </div>
                {WORKSPACE_GROUP.map(navItem)}
              </div>
            )}
            <div className="settings-modal-nav-footer">{navItem('updates')}</div>
          </nav>

          <div className="settings-modal-body">
            {isWorkspaceSection(section) ? (
              workspace && (
                <WorkspaceSectionBody key={workspace.id} workspace={workspace} section={section} />
              )
            ) : (
              <>
                {section === 'appearance' && (
                  <AppearanceSection
                    theme={theme}
                    setTheme={setTheme}
                    terminalFontSize={terminalFontSize}
                    setTerminalFontSize={setTerminalFontSize}
                  />
                )}
                {section === 'sessions' && <SessionsSection />}
                {section === 'harnesses' && <HarnessesSection />}
                {section === 'shortcuts' && <ShortcutsSection />}
                {section === 'updates' && <AppUpdatesSection />}
              </>
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
 * The workspace group's panels, one section at a time. Keyed by workspace id
 * from the caller, so retargeting the dialog to another workspace remounts
 * every panel: no draft, open rename or pending confirmation survives into
 * another workspace's record.
 */
function WorkspaceSectionBody({
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
      {section === 'scopes' && <ScopesPanel workspace={workspace} />}
      {section === 'provider' && (
        <section className="ws-panel">
          <ProviderBindingPanel workspace={workspace} />
        </section>
      )}
      {section === 'actions' && <ActionsPanel workspace={workspace} />}
      {section === 'labels' && <LabelsPanel workspace={workspace} />}
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
      <div className="settings-modal-option">
        <div className="settings-modal-option-info">
          <span className="settings-modal-option-label">Settle idle sessions</span>
          <span className="settings-modal-option-description">
            Sessions with nothing happening move to the Settled shelf after this long. Nothing is
            deleted, and new activity brings a session back. Choose Off to keep every session where
            it is.
          </span>
        </div>
        <AutoSettleControl />
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
    { label: 'Toggle file explorer', key: `${mod}${shift}E` },
    { label: 'Toggle terminal', key: SHELL_SHORTCUT_LABEL },
    { label: 'Open settings', key: `${mod},` },
    { label: 'Cycle theme', key: `${mod}${shift}T` },
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
