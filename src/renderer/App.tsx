import { Flex } from '@radix-ui/themes';
import Header from './components/Header';
import Terminal from './components/Terminal';
import StatusBar from './components/StatusBar';
import { AgentPanel } from './components/Agent';
import { useTerminal } from './hooks/useTerminal';
import { useTerminalStore } from './stores/terminalStore';
import './styles/app.css';
import './components/Agent/styles.css';

export default function App() {
  // Initialize terminal connection and event subscriptions
  useTerminal();

  const { mode } = useTerminalStore();

  return (
    <Flex direction="column" height="100vh">
      <Header />
      {mode === 'AGENT' ? <AgentPanel /> : <Terminal />}
      <StatusBar />
    </Flex>
  );
}
