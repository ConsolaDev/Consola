import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNavigationStore } from '../stores/navigationStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { ThemeMode } from '../stores/settingsStore';

interface UseKeyboardShortcutsOptions {
  onNewWorkspace?: () => void;
}

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions = {}) {
  const navigate = useNavigate();
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);
  const { theme, setTheme } = useSettingsStore();
  const { onNewWorkspace } = options;

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
        navigate('/settings');
        return;
      }

      // Cmd/Ctrl + Shift + T : Toggle theme
      if (isMod && event.shiftKey && event.key === 't') {
        event.preventDefault();
        toggleTheme();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate, toggleSidebar, toggleTheme, onNewWorkspace]);
}
