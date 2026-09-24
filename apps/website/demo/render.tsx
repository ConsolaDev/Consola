import React, { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@radix-ui/themes';
import App from '../../desktop/src/renderer/App';
import { hydrateWorkspaceStore } from '../../desktop/src/renderer/stores/workspaceStore';
import { hydrateHarnessStore } from '../../desktop/src/renderer/stores/harnessStore';
import { hydrateTerminalStatus } from '../../desktop/src/renderer/stores/terminalStore';
import { useNavigationStore } from '../../desktop/src/renderer/stores/navigationStore';
import { useGitReviewStore } from '../../desktop/src/renderer/stores/gitReviewStore';
import { useGitStatusStore } from '../../desktop/src/renderer/stores/gitStatusStore';
import { useSettingsStore } from '../../desktop/src/renderer/stores/settingsStore';
import '@fontsource-variable/jetbrains-mono';
import '@radix-ui/themes/styles.css';
import '../../desktop/src/renderer/styles/themes/index.css';
import '../../desktop/src/renderer/styles/global.css';
import '../../desktop/src/renderer/styles/statusDots.css';
import './styles.css';

class DemoBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="demo-error"><h1>Let’s start fresh.</h1><p>The demo hit an unexpected state.</p><button onClick={() => location.reload()}>Reset demo</button></div> : this.props.children; }
}
function Root() {
  const theme = useSettingsStore(state => state.resolvedTheme);
  const [notice, setNotice] = React.useState('');
  React.useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const show = (event: Event) => { setNotice((event as CustomEvent<string>).detail); clearTimeout(timeout); timeout = setTimeout(() => setNotice(''), 6500); };
    document.addEventListener('demo:notice', show);
    return () => { document.removeEventListener('demo:notice', show); clearTimeout(timeout); };
  }, []);
  return <Theme appearance={theme} accentColor="cyan" grayColor="slate"><DemoBoundary><App /></DemoBoundary>{notice && <div className="demo-notice" role="status">{notice}<button aria-label="Dismiss demo notice" onClick={() => setNotice('')}>×</button></div>}</Theme>;
}
async function openChanges() {
  await useNavigationStore.getState().setActiveWorkspace('acme');
  useNavigationStore.getState().setActiveSession('retry');
  useGitReviewStore.getState().open();
  await useGitStatusStore.getState().refresh('/demo/acme/platform');
}
document.addEventListener('demo:changes', async event => {
  await useGitStatusStore.getState().refresh((event as CustomEvent<string>).detail);
  useGitReviewStore.getState().open();
});
window.addEventListener('message', async event => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'consola:demo-command') return;
  if (event.data.command === 'home') {
    await useNavigationStore.getState().setActiveWorkspace('acme');
    useNavigationStore.getState().setActiveSession('onboarding');
    useGitReviewStore.getState().close();
  }
  if (event.data.command === 'personal') await useNavigationStore.getState().setActiveWorkspace('personal');
  if (event.data.command === 'inbox') { await useNavigationStore.getState().setActiveWorkspace('acme'); useNavigationStore.getState().openInbox(); }
  if (event.data.command === 'changes') await openChanges();
  if (event.data.command === 'reset') location.reload();
});
await Promise.all([hydrateWorkspaceStore(), hydrateHarnessStore(), hydrateTerminalStatus()]);
useGitReviewStore.setState({ isSidebarCollapsed: true });
useNavigationStore.setState({ sidebarWidth: 220, isSidebarHidden: false, isExplorerVisible: false });
createRoot(document.getElementById('root')!).render(<Root />);
// Keep the website shortcuts in sync even when visitors navigate inside the app.
function reportView() {
  const navigation = useNavigationStore.getState();
  const view = navigation.activeWorkspaceId === 'personal' ? 'personal'
    : navigation.activeWorkspaceId !== 'acme' ? null
    : navigation.isInboxOpen ? 'inbox'
    : useGitReviewStore.getState().isOpen && navigation.activeSessionId ? 'changes' : 'home';
  window.parent.postMessage({ type: 'consola:demo-view', view }, location.origin);
}
useNavigationStore.subscribe(reportView);
useGitReviewStore.subscribe(reportView);
reportView();
window.parent.postMessage({ type: 'consola:demo-ready' }, location.origin);
