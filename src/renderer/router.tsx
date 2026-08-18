import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { SettingsProvider } from './contexts/SettingsContext';
import { CommandPaletteProvider } from './contexts/CommandPaletteContext';

// Wrap Layout with providers that need router context
function LayoutWithProviders() {
  return (
    <SettingsProvider>
      {/* Inside SettingsProvider: the palette offers "Open settings". */}
      <CommandPaletteProvider>
        <Layout />
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
