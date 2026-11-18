import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LinkSessionDialog } from './components/Dialogs/LinkSessionDialog';
import { SettingsProvider } from './contexts/SettingsContext';
import { CommandPaletteProvider } from './contexts/CommandPaletteContext';

// Wrap Layout with providers that need router context
function LayoutWithProviders() {
  return (
    <SettingsProvider>
      {/* Inside SettingsProvider: the palette offers "Open settings" and
          "Workspace settings…", both doors into the one dialog. */}
      <CommandPaletteProvider>
        <Layout />
        {/* Mounted here, not in the Sidebar: the sidebar unmounts when
            hidden, and the dialog is opened from three unrelated trees. */}
        <LinkSessionDialog />
      </CommandPaletteProvider>
    </SettingsProvider>
  );
}

// Use HashRouter for Electron compatibility
// Navigation is handled via stores, not routes
export const router = createHashRouter([
  {
    path: '/',
    element: <LayoutWithProviders />,
    children: [{ index: true, element: null }],
  },
]);
