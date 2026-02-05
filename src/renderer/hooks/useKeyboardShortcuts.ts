import { useEffect, useCallback } from 'react';
import { useNavigationStore } from '../stores/navigationStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { ThemeMode } from '../stores/settingsStore';

interface UseKeyboardShortcutsOptions {
  onNewWorkspace?: () => void;
  onCloseActiveTab?: () => void;
  onOpenSettings?: () => void;
}

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions = {}) {
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);
  const toggleExplorer = useNavigationStore((state) => state.toggleExplorer);
  const { theme, setTheme } = useSettingsStore();
  const { onNewWorkspace, onCloseActiveTab, onOpenSettings } = options;

  const toggleTheme = useCallback(() => {
    const themeOrder: ThemeMode[] = ['light', 'dark', 'system'];
    const currentIndex = themeOrder.indexOf(theme);
    const nextTheme = themeOrder[(currentIndex + 1) % themeOrder.length];
    setTheme(nextTheme);
  }, [theme, setTheme]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;

      // Cmd/Ctrl + \ : Toggle sidebar
      if (isMod && event.key === '\\') {
        event.preventDefault();
        toggleSidebar();
        return;
      }

      // Cmd/Ctrl + N : New workspace (opens dialog)
      if (isMod && event.key === 'n') {
        event.preventDefault();
        onNewWorkspace?.();
        return;
      }

      // Cmd/Ctrl + , : Open settings
      if (isMod && event.key === ',') {
        event.preventDefault();
        onOpenSettings?.();
        return;
      }

      // Cmd/Ctrl + Shift + T : Toggle theme
      if (isMod && event.shiftKey && event.key === 't') {
        event.preventDefault();
        toggleTheme();
        return;
      }

      // Cmd/Ctrl + Shift + E : Toggle file explorer
      if (isMod && event.shiftKey && event.key === 'e') {
        event.preventDefault();
        toggleExplorer();
        return;
      }

      // Cmd/Ctrl + W : Close active tab
      if (isMod && event.key === 'w') {
        event.preventDefault();
        onCloseActiveTab?.();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar, toggleExplorer, toggleTheme, onNewWorkspace, onCloseActiveTab, onOpenSettings]);
}
