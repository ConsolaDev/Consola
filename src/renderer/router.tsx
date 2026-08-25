import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { WorkspaceSettingsProvider } from './contexts/WorkspaceSettingsContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { CommandPaletteProvider } from './contexts/CommandPaletteContext';

// Wrap Layout with providers that need router context
function LayoutWithProviders() {
  return (
    <WorkspaceSettingsProvider>
      {/* Inside WorkspaceSettingsProvider: the global modal's pointer row
          opens the workspace modal, and the palette offers it. */}
      <SettingsProvider>
        {/* Inside SettingsProvider: the palette offers "Open settings". */}
        <CommandPaletteProvider>
          <Layout />
        </CommandPaletteProvider>
      </SettingsProvider>
    </WorkspaceSettingsProvider>
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
