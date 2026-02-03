import React from 'react';
import ReactDOM from 'react-dom/client';
import { Theme } from '@radix-ui/themes';
import App from './App';
import { useSettingsStore } from './stores/settingsStore';
import '@radix-ui/themes/styles.css';
import './styles/themes/index.css';
import './styles/global.css';

function Root() {
  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme);

  return (
    <Theme appearance={resolvedTheme} accentColor="cyan" grayColor="slate">
      <App />
    </Theme>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
