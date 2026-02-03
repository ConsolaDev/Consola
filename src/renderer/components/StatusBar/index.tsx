import { Flex, Text } from '@radix-ui/themes';
import { useTerminalStore } from '../../stores/terminalStore';
import './styles.css';

export default function StatusBar() {
  const { mode, isConnected, dimensions } = useTerminalStore();

  return (
    <footer className="status-bar">
      <Flex gap="4" align="center">
        <span className={`status-indicator ${isConnected ? 'connected' : ''}`} />
        <Text size="1" className={`mode-label ${mode.toLowerCase()}`}>
          {mode}
        </Text>
      </Flex>

      <Text size="1" className="dimensions">
        {dimensions.cols} x {dimensions.rows}
      </Text>
    </footer>
  );
}
