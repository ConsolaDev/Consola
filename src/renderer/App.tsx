import { Flex } from '@radix-ui/themes';
import Header from './components/Header';
import Terminal from './components/Terminal';
import StatusBar from './components/StatusBar';
import { useTerminal } from './hooks/useTerminal';
import './styles/app.css';

export default function App() {
  // Initialize terminal connection and event subscriptions
  useTerminal();

  return (
    <Flex direction="column" height="100vh">
      <Header />
      <Terminal />
      <StatusBar />
    </Flex>
  );
}
