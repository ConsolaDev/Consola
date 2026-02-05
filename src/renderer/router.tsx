import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { SettingsProvider } from './contexts/SettingsContext';

// Wrap Layout with providers that need router context
function LayoutWithProviders() {
  return (
    <SettingsProvider>
      <Layout />
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
