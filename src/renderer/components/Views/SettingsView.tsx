import { Sun, Moon, Monitor } from 'lucide-react';
import { useSettingsStore, type ThemeMode } from '../../stores/settingsStore';
import { useTheme } from '../../hooks/useTheme';
import './styles.css';

const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function SettingsView() {
  const { theme, setTheme } = useSettingsStore();
  useTheme(); // Ensure theme is applied

  return (
    <div className="settings-view">
      <div className="settings-view-header">
        <h1 className="settings-view-title">Settings</h1>
      </div>
      <div className="settings-view-content">
        <section className="settings-section">
          <h2 className="settings-section-title">Appearance</h2>
          <div className="settings-option">
            <div className="settings-option-info">
              <span className="settings-option-label">Theme</span>
              <span className="settings-option-description">
                Select your preferred color theme
              </span>
            </div>
            <div className="settings-theme-selector">
              {themeOptions.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  className={`settings-theme-button ${theme === value ? 'active' : ''}`}
                  onClick={() => setTheme(value)}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">Keyboard Shortcuts</h2>
          <div className="settings-shortcuts">
            <div className="settings-shortcut">
              <span className="settings-shortcut-label">Toggle sidebar</span>
              <kbd className="settings-shortcut-key">⌘\</kbd>
            </div>
            <div className="settings-shortcut">
              <span className="settings-shortcut-label">New workspace</span>
              <kbd className="settings-shortcut-key">⌘N</kbd>
            </div>
            <div className="settings-shortcut">
              <span className="settings-shortcut-label">Open settings</span>
              <kbd className="settings-shortcut-key">⌘,</kbd>
            </div>
            <div className="settings-shortcut">
              <span className="settings-shortcut-label">Toggle theme</span>
              <kbd className="settings-shortcut-key">⌘⇧T</kbd>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
