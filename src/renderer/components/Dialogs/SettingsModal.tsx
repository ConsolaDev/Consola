import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Sun, Moon, Monitor, Palette, Keyboard, Boxes, Minus, Plus } from 'lucide-react';
import {
  useSettingsStore,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_MAX,
  type ThemeMode,
} from '../../stores/settingsStore';
import { useTheme } from '../../hooks/useTheme';
import { COMMAND_PALETTE_SHORTCUT_LABEL, isMac } from '../../utils/platform';
import { HarnessesSection } from '../Harnesses';
import './styles.css';

type SettingsSection = 'appearance' | 'harnesses' | 'shortcuts';

interface SettingsSectionConfig {
  id: SettingsSection;
  label: string;
  icon: typeof Palette;
}

const sections: SettingsSectionConfig[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'harnesses', label: 'Harnesses', icon: Boxes },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: Keyboard },
];

const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance');
  const { theme, setTheme, terminalFontSize, setTerminalFontSize } = useSettingsStore();
  useTheme();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="settings-modal-content">
          <Dialog.Title className="sr-only">Settings</Dialog.Title>

          <nav className="settings-modal-nav">
            <div className="settings-modal-nav-header">Settings</div>
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={`settings-modal-nav-item ${activeSection === id ? 'active' : ''}`}
                onClick={() => setActiveSection(id)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-modal-body">
            {activeSection === 'appearance' && (
              <AppearanceSection
                theme={theme}
                setTheme={setTheme}
                terminalFontSize={terminalFontSize}
                setTerminalFontSize={setTerminalFontSize}
              />
            )}
            {activeSection === 'harnesses' && <HarnessesSection />}
            {activeSection === 'shortcuts' && <ShortcutsSection />}
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

function ShortcutsSection() {
  // Mirrors what useKeyboardShortcuts actually binds -- nothing aspirational.
  const mod = isMac ? '⌘' : 'Ctrl+';
  const shift = isMac ? '⇧' : 'Shift+';
  const shortcuts = [
    { label: 'Command palette', key: COMMAND_PALETTE_SHORTCUT_LABEL },
    { label: 'New session', key: `${mod}N` },
    { label: 'Toggle sidebar', key: `${mod}\\` },
    { label: 'Toggle file explorer', key: `${mod}${shift}E` },
    { label: 'Open settings', key: `${mod},` },
    { label: 'Cycle theme', key: `${mod}${shift}T` },
  ];

  return (
    <div className="settings-modal-section">
      <h2 className="settings-modal-section-title">Keyboard Shortcuts</h2>
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
